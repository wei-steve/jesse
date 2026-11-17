import base64
import binascii
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from typing import Optional, Union

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from jesse.services import deepcoin_private, market_sources
from jesse.services.auth import require_auth

router = APIRouter(prefix="/review", tags=["Review"], dependencies=[Depends(require_auth)])

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# A 4-chart grid snapshot is usually 1-3 MB. 15 MB still fits a high-DPI iPad screenshot while
# refusing a request that would only fill the project's disk.
MAX_BYTES = 15 * 1024 * 1024
UNSAFE_LABEL_CHARS = re.compile(r"[^A-Za-z0-9_-]")
MAX_LABEL = 40
# A note is a one-line message for the person reading the screenshots folder, not a document.
MAX_NOTE = 2000
# Relative to os.getcwd() (the project `jesse run` was started in), like factors/. The review pages
# tell Claude to read `storage/screenshots/latest.png`, so the folder must live with the project.
FOLDER = os.path.join("storage", "screenshots")


# Signal labels of the factor finder: the page marks each signal good / bad / clear while flipping through the
# list, and the person analysing the factor reads the file instead of a screenshot per signal. Append-only JSONL
# in the project folder, so a mark never rewrites history and the newest row per `key` is the current mark.
LABELS_FOLDER = os.path.join('storage', 'labels')
# A "备注本" (label book) is one `<name>.jsonl` in that folder: the same rows, several notebooks, so a new question
# starts clean without losing last week's marks. `finder-labels` is the default and the file every page (and script)
# wrote before books existed, so old marks keep working without a migration.
DEFAULT_BOOK = 'finder-labels'
BOOK_SUFFIX = '.jsonl'
# A plain file name: letters, digits, `_`, `-` and CJK (a Chinese book name is fine). No `/`, `.` or space, so a name
# can never climb out of storage/labels/ or name a file the folder does not expect.
BOOK_NAME = re.compile(r'^[A-Za-z0-9_\-\u4e00-\u9fff]{1,40}$')
# `factor|exchange|symbol|tf|start|dir`, built by the page (labels.mjs). 200 is far above any real key and keeps a
# garbage key from bloating the file.
MAX_KEY = 200
# One line of text next to the mark, not a document.
MAX_LABEL_NOTE = 500
# One record is one line: the page sends the factor params and the order it had on screen, which is a handful of
# numbers. A record above 8 KB is a mistake (or abuse), not a label.
MAX_RECORD_BYTES = 8 * 1024
# One signal carries three independent marks: whether the trend judgement was right (`trend`), whether the limit
# order was usable (`order`), and one free-text note. The page sends the machine choices and the person reads the
# file, so the reason a signal is bad stays distinguishable. Rows written before the split have no `kind` and are
# trend marks.
LABEL_VALUES = ('good', 'bad', 'clear')
# `bar` is a note on one candle of any timeframe (not on a signal): the page double-clicks a chart and sends the
# candle it landed on. Its key is `bar|exchange|symbol|tf|time`, built by the page (labels.mjs) like the signal keys,
# so the timeframe is part of the identity and a 3m note can never land on the 15m candle of the same clock time.
LABEL_KINDS = ('trend', 'order', 'note', 'bar')
DEFAULT_LABEL_KIND = 'trend'


class ScreenshotRequestJson(BaseModel):
    image: str
    label: Optional[str] = None
    note: Optional[str] = None


def clean_label(value: Optional[str]) -> str:
    """Keep only `[A-Za-z0-9_-]` (max 40 chars) so the name can never escape the screenshots folder."""
    cleaned = UNSAFE_LABEL_CHARS.sub("-", value or "screenshot").strip("-")[:MAX_LABEL]
    return cleaned or "screenshot"


def decode_image(image: str) -> bytes:
    """Decode the base64 body. Raises binascii.Error for anything that is not valid base64."""
    # The browser strips the `data:image/png;base64,` prefix; tolerating whitespace keeps hand-made
    # requests working without accepting arbitrary junk.
    return base64.b64decode("".join(image.split()), validate=True)


@router.post("/screenshot")
def save_screenshot(request_json: ScreenshotRequestJson) -> JSONResponse:
    """Store a chart snapshot (and its optional note) in the project's storage/screenshots/ folder."""
    # base64 is 4/3 of the raw size: reject an oversized body before spending memory on decoding it.
    if len(request_json.image) > (MAX_BYTES // 3 + 1) * 4:
        return JSONResponse({'error': f'图片太大（上限 {MAX_BYTES // (1024 * 1024)} MB）'}, status_code=413)
    try:
        data = decode_image(request_json.image)
    except (binascii.Error, ValueError):
        return JSONResponse({'error': 'image 不是有效的 base64'}, status_code=400)
    if not data.startswith(PNG_SIGNATURE):
        return JSONResponse({'error': '只接受 PNG 图片'}, status_code=400)
    if len(data) > MAX_BYTES:
        return JSONResponse({'error': f'图片太大（上限 {MAX_BYTES // (1024 * 1024)} MB）'}, status_code=413)

    folder = os.path.join(os.getcwd(), FOLDER)
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    label = clean_label(request_json.label)
    name = f'{stamp}-{label}.png'
    # Two snapshots of the same label within one second both belong to the user: keep both as -2, -3, ...
    suffix = 2
    while os.path.exists(os.path.join(folder, name)):
        name = f'{stamp}-{label}-{suffix}.png'
        suffix += 1

    path = os.path.join(folder, name)
    with open(path, 'wb') as file:
        file.write(data)

    note = (request_json.note or '').strip()[:MAX_NOTE]
    if note:
        with open(f'{os.path.splitext(path)[0]}.txt', 'w', encoding='utf-8') as file:
            file.write(note)

    # latest.png is the fixed path for "look at the newest screenshot", so the reader needs no file name.
    with open(os.path.join(folder, 'latest.png'), 'wb') as file:
        file.write(data)

    return JSONResponse({'file': name, 'path': path})


class LabelRequestJson(BaseModel):
    key: str
    # Which book the row belongs to. Missing = the default, so an older page / script keeps writing where it always did.
    book: Optional[str] = None
    # Required for trend / order (good / bad / clear), ignored for note rows, which only carry the text.
    label: Optional[str] = None
    # trend / order / note; missing means trend, so a page (or script) written before the split still works.
    kind: Optional[str] = None
    factor: Optional[str] = None
    version: Optional[str] = None
    params: Optional[dict] = None
    exchange: Optional[str] = None
    symbol: Optional[str] = None
    tf: Optional[str] = None
    # Seconds, like every other time this page sends.
    start: Optional[Union[int, float]] = None
    dir: Optional[int] = None
    note: Optional[str] = None
    order: Optional[dict] = None
    # kind=bar only: the candle's open time (seconds) and the numbers the page computed for it (o/h/l/c, MA5, MA10,
    # ATR, BOLL 20/2), so the note explains itself long after the chart has moved on.
    time: Optional[Union[int, float]] = None
    bar: Optional[dict] = None
    # kind=bar only: the signal that was selected while the candle was noted (`factor|exchange|symbol|tf|start|dir`),
    # so the reader knows which signal the person was looking at.
    signal: Optional[str] = None


class LabelsRequestJson(BaseModel):
    """Which factor run the marks are asked for. Every field is optional so a partial filter still works."""
    factor: Optional[str] = None
    exchange: Optional[str] = None
    symbol: Optional[str] = None
    # Missing = the default book (see LabelRequestJson.book).
    book: Optional[str] = None


class LabelBookRequestJson(BaseModel):
    name: str


def labels_folder() -> str:
    """storage/labels/ under the cwd of `jesse run`, like the screenshots folder."""
    return os.path.join(os.getcwd(), LABELS_FOLDER)


def labels_path(book: str = DEFAULT_BOOK) -> str:
    """storage/labels/<book>.jsonl of the project `jesse run` was started in."""
    return os.path.join(labels_folder(), f'{book}{BOOK_SUFFIX}')


def resolve_book(value: Optional[str]) -> Union[str, JSONResponse]:
    """The book a request names (`finder-labels` when the field is absent), or the 400 answer for an impossible name.

    An empty name is refused: it is not the same as not naming a book (the pages send the default explicitly), and a
    file called `.jsonl` is never a notebook anyone meant to write.
    """
    if value is None:
        return DEFAULT_BOOK
    name = value.strip()
    if not BOOK_NAME.match(name):
        return JSONResponse({'error': '备注本名字只能用中英文、数字、_ 和 -（1–40 字，不能含 / . 空格）'},
                            status_code=400)
    return name


def label_kind(row: dict) -> str:
    """The kind of one stored row. Rows without `kind` (and hand-edited nonsense) are trend marks, the only mark
    that existed when they were written; nothing is rewritten on disk."""
    kind = row.get('kind')
    return kind if kind in LABEL_KINDS else DEFAULT_LABEL_KIND


def read_label_rows(path: str) -> list:
    """Every readable row, oldest first. A hand-edited broken line is skipped instead of failing the read."""
    try:
        with open(path, encoding='utf-8') as file:
            lines = file.readlines()
    except FileNotFoundError:
        return []
    rows = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and isinstance(row.get('key'), str):
            rows.append(row)
    return rows


@router.post('/label')
def save_label(request_json: LabelRequestJson) -> JSONResponse:
    """Append one mark (kind trend / order, good / bad / clear), one note, or one candle note to the label file."""
    kind = (request_json.kind or DEFAULT_LABEL_KIND).strip()
    if kind not in LABEL_KINDS:
        return JSONResponse({'error': 'kind 只能是 ' + ' / '.join(LABEL_KINDS)}, status_code=400)
    # A note / bar row needs no good / bad; a trend or order row is nothing without its label.
    if kind not in ('note', 'bar') and request_json.label not in LABEL_VALUES:
        return JSONResponse({'error': 'label 只能是 ' + ' / '.join(LABEL_VALUES)}, status_code=400)
    key = request_json.key.strip()
    if not key:
        return JSONResponse({'error': 'key 不能为空'}, status_code=400)
    if len(key) > MAX_KEY:
        return JSONResponse({'error': f'key 太长（上限 {MAX_KEY} 字符）'}, status_code=400)
    book = resolve_book(request_json.book)
    if isinstance(book, JSONResponse):
        return book
    # Only the default book is created by its first write (that is where every older page writes); a named book has to
    # be created first (POST /review/label-books/create), so a typo can never scatter rows into a fresh file.
    if book != DEFAULT_BOOK and not os.path.isfile(labels_path(book)):
        return JSONResponse({'error': '备注本不存在，先新建'}, status_code=404)

    record = request_json.model_dump(exclude_none=True)
    record['key'] = key
    record['kind'] = kind
    # A note is trimmed and capped instead of rejected: losing the tail of one line of text is better than losing
    # the mark the user just made. The note is its own mark now (kind=note), so clearing a good / bad leaves it.
    note = (request_json.note or '').strip()[:MAX_LABEL_NOTE]
    if kind in ('note', 'bar'):
        # Only the text: a note row (signal or candle) is not a mark, and an empty note is the explicit "clear it" row.
        record.pop('label', None)
        record['note'] = note
    elif note:
        record['note'] = note
    else:
        record.pop('note', None)
    # UTC ISO, same stamp style as the rest of this controller. Only appended fields are added; nothing is rewritten.
    record['saved_at'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

    # The book is the file name, so it is not repeated inside every row (the file itself says which book it is).
    record.pop('book', None)

    line = json.dumps(record, ensure_ascii=False)
    if len(line.encode('utf-8')) > MAX_RECORD_BYTES:
        return JSONResponse({'error': f'标注太大（一条上限 {MAX_RECORD_BYTES // 1024} KB）'}, status_code=413)

    path = labels_path(book)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as file:
        file.write(line + '\n')
    return JSONResponse({'ok': True})


class MarketCandlesRequestJson(BaseModel):
    """One series of a source the browser cannot read itself: US treasury yields (Yahoo / FRED) and Deepcoin. Binance
    and OKX are CORS-open and read directly by the page."""
    source: str
    symbol: str
    interval: str
    # Yields only: a Yahoo range name (`5d`, `1mo`, `1y` …).
    range: Optional[str] = None
    # Deepcoin only: `swap` / `spot`, the page size, and the open time (seconds) of the oldest bar already loaded,
    # which asks for the page of history before it.
    market: Optional[str] = None
    limit: Optional[int] = None
    before: Optional[Union[int, float]] = None


class MarketTickersJson(BaseModel):
    """The product list of one source the browser cannot read itself (Deepcoin: no CORS headers)."""
    source: str
    market: Optional[str] = None


@router.post('/market/candles')
def market_candles(request_json: MarketCandlesRequestJson) -> JSONResponse:
    """Candles of one whitelisted market source for the 看行情 page.

    Yahoo, FRED and Deepcoin send no CORS headers, so the page cannot read them from the browser. The whitelist, the
    upstream request (10-second timeout) and the cache live in jesse/services/market_sources.py; here we only turn
    its two failure kinds into HTTP statuses.
    """
    try:
        answer = market_sources.read_candles(request_json.source, request_json.symbol, request_json.interval,
                                             request_json.range, request_json.market, request_json.limit,
                                             request_json.before)
    except market_sources.MarketSourceError as error:
        return JSONResponse({'error': str(error)}, status_code=error.status_code)
    return JSONResponse(answer)


@router.post('/market/tickers')
def market_tickers(request_json: MarketTickersJson) -> JSONResponse:
    """The USDT product list of one proxied source (Deepcoin), biggest 24h turnover first.

    The page's left column draws it as 「合约 | 现货」 and refreshes it every 10 seconds; the upstream answer is cached
    for the same 10 seconds, so several tabs cost one request.
    """
    try:
        answer = market_sources.read_tickers(request_json.source, request_json.market)
    except market_sources.MarketSourceError as error:
        return JSONResponse({'error': str(error)}, status_code=error.status_code)
    return JSONResponse(answer)


class MarketFillsRequestJson(BaseModel):
    """The owner's own Deepcoin fills of one instrument, for the 看行情 page's 「我的成交」 markers.

    `symbol` is the pair the product list shows (`BTC-USDT`); the `swap` market maps it to `BTC-USDT-SWAP` server-side.
    Times are seconds, like every other time this page sends.
    """
    market: str
    symbol: str
    begin: Union[int, float]
    end: Optional[Union[int, float]] = None


@router.post('/market/fills')
def market_fills(request_json: MarketFillsRequestJson) -> JSONResponse:
    """The owner's Deepcoin fills of one instrument, oldest first, or `{configured: false, fills: []}`.

    Deepcoin's trade endpoint is signed with an API key and sends no CORS headers, so the browser cannot read it. The
    key lives in the project's `.env.deepcoin` and is read per request in jesse/services/deepcoin_private.py; it never
    reaches this answer, a log line or an error message. An unconfigured project is a 200 with `configured: false`: the
    chart has nothing to draw, which is not a failure.

    The fills are stored in the project folder (`storage/deepcoin-fills/<instId>.json`), so a request only pulls what is
    new and answers with `covered_from` / `complete` saying how much of the asked window the store covers. A venue that
    refuses the request still answers 200 with the stored fills plus an `error`: the markers of earlier reads are drawn.
    """
    try:
        answer = deepcoin_private.read_fills(request_json.market, request_json.symbol, request_json.begin,
                                             request_json.end)
    except deepcoin_private.DeepcoinError as error:
        return JSONResponse({'error': str(error)}, status_code=error.status_code)
    return JSONResponse(answer)


def bar_entry(row: dict) -> dict:
    """`{note, tf, time}` of one `kind=bar` row. The key (`bar|exchange|symbol|tf|time`) is the identity, so a
    hand-edited line without its own `tf` / `time` still lands on the candle it names."""
    parts = row['key'].split('|')
    tf = row.get('tf') if isinstance(row.get('tf'), str) else (parts[3] if len(parts) == 5 else None)
    time = row.get('time')
    if not isinstance(time, (int, float)) or isinstance(time, bool):
        try:
            time = int(parts[4]) if len(parts) == 5 else None
        except ValueError:
            time = None
    return {'note': row.get('note') or '', 'tf': tf, 'time': time}


@router.post('/labels')
def get_labels(request_json: LabelsRequestJson) -> JSONResponse:
    """Every signal's two marks and its note, plus the note on every noted candle, as the last row per key."""
    book = resolve_book(request_json.book)
    if isinstance(book, JSONResponse):
        return book
    latest = {}
    bars = {}
    # A book that is not on disk reads as empty (the same answer as a book with no rows): nothing to explain to a reader.
    for row in read_label_rows(labels_path(book)):
        if label_kind(row) == 'bar':
            # A candle note belongs to the chart, not to a factor run: only exchange + symbol narrow it, and the key
            # already carries the timeframe and the candle time. An empty note is the "deleted" row, so it drops out.
            if any(wanted is not None and row.get(field) != wanted
                   for field, wanted in (('exchange', request_json.exchange), ('symbol', request_json.symbol))):
                continue
            entry = bar_entry(row)
            if entry['note']:
                bars[row['key']] = entry
            else:
                bars.pop(row['key'], None)
            continue
        if any(wanted is not None and row.get(field) != wanted
               for field, wanted in (('factor', request_json.factor), ('exchange', request_json.exchange),
                                     ('symbol', request_json.symbol))):
            continue
        # Rows are read oldest first, so the last row of a kind is the current state of that kind.
        entry = latest.setdefault(row['key'], {'trend': None, 'order': None, 'note': ''})
        kind = label_kind(row)
        if kind == 'note':
            # A note row states the note of the signal: text, or explicitly none.
            entry['note'] = row.get('note') or ''
            continue
        label = row.get('label')
        if label in ('good', 'bad'):
            entry[kind] = label
        elif label == 'clear':
            entry[kind] = None
        # Marks written before the note was its own kind carry it; a newer note row still wins.
        if row.get('note'):
            entry['note'] = row['note']
    labels = {key: entry for key, entry in latest.items()
              if entry['trend'] or entry['order'] or entry['note']}
    return JSONResponse({'labels': labels, 'bars': bars})


# ---- Label books ------------------------------------------------------------
# Claude / the person reads the books straight off disk (`storage/labels/*.jsonl`); these two endpoints only tell the
# pages which books exist (name + how many rows + when last written) and create an empty one. There is deliberately no
# delete and no rename: losing a notebook to a mis-click is not recoverable, so a removal stays a manual act.
def book_rows(path: str) -> int:
    """How many rows one book holds: a cheap line count (a book is one JSON object per line)."""
    try:
        with open(path, encoding='utf-8') as file:
            return sum(1 for line in file if line.strip())
    except OSError:
        return 0


@router.post('/label-books')
def list_label_books() -> JSONResponse:
    """Every book of the project, the most recently written first: `{books: [{name, rows, updated}], default}`."""
    folder = labels_folder()
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        names = []
    books = []
    for filename in names:
        if not filename.endswith(BOOK_SUFFIX):
            continue
        name = filename[:-len(BOOK_SUFFIX)]
        # A hand-copied file with a name the API refuses is not a book: it cannot be selected, so it cannot be written.
        if not BOOK_NAME.match(name):
            continue
        path = os.path.join(folder, filename)
        try:
            updated = os.stat(path).st_mtime
        except OSError:
            continue
        books.append({'name': name, 'rows': book_rows(path), 'updated': int(updated)})
    # The default book is listed even before its first write: the pages show the open book in their dropdown, and the
    # first mark creates the file (that is what every page did before books existed).
    if not any(book['name'] == DEFAULT_BOOK for book in books):
        books.append({'name': DEFAULT_BOOK, 'rows': 0, 'updated': 0})
    books.sort(key=lambda book: (-book['updated'], book['name']))
    return JSONResponse({'books': books, 'default': DEFAULT_BOOK})


@router.post('/label-books/create')
def create_label_book(request_json: LabelBookRequestJson) -> JSONResponse:
    """Create one empty book. An existing name is a 409: the page switches to it instead of writing over it."""
    name = resolve_book(request_json.name)
    if isinstance(name, JSONResponse):
        return name
    os.makedirs(labels_folder(), exist_ok=True)
    path = labels_path(name)
    exists = JSONResponse({'error': f'备注本「{name}」已存在'}, status_code=409)
    if os.path.exists(path):
        return exists
    try:
        # 'x' refuses instead of truncating if another request created the same name in between.
        with open(path, 'x', encoding='utf-8'):
            pass
    except FileExistsError:
        return exists
    return JSONResponse({'ok': True, 'name': name})


# ---- Page settings (localStorage `jesse.*` keys) -----------------------------
class PrefsSaveJson(BaseModel):
    """One batch of settings: `{key: value}` writes a key, `{key: null}` forgets it.

    The values are typed loosely on purpose: a body of the wrong shape must answer 400 with a Chinese message (like
    every other endpoint of this router), not pydantic's 422.
    """
    items: dict = {}


# The review pages keep their display settings in localStorage, which is per browser *and per origin*: moving Jesse to
# another LAN address (or opening it from another computer) meant every setting was back at its default. The keys are
# now mirrored into one file in the project folder (`jesse run`'s cwd), so any address / computer / browser opens with
# the same watchlist, indicators and form. Everything the pages store under a `jesse.` prefix is mirrored as-is (new
# keys need no change here); the dashboard's `main` token and every other key stay in the browser only.
PREFS_FILE = os.path.join('storage', 'review-prefs.json')
# `jesse.` + 1-80 characters: the keys the pages build today (`jesse.review.display.v1`, `jesse.market.watchlist.v1`, …).
# The character set cannot climb out of anything (no `/`, no `..` path trick) and keeps the file's keys recognisable.
PREF_KEY = re.compile(r'^jesse\.[A-Za-z0-9_.\-]{1,80}$')
# One setting is a serialised localStorage value (a display config, a watchlist, a form). 256 KB is far above the
# largest of them and refuses a body that would only fill the project's disk.
MAX_PREF_VALUE_BYTES = 256 * 1024
# A page writes its settings a handful at a time; 50 in one batch is already generous.
MAX_PREF_ITEMS = 50
# The read-modify-write of the file must not interleave: two tabs saving a key at the same time would otherwise drop
# one of them. One process serves the pages, so a thread lock is enough.
PREFS_LOCK = threading.Lock()


def prefs_path() -> str:
    """storage/review-prefs.json of the project `jesse run` was started in (same cwd as the screenshots / labels)."""
    return os.path.join(os.getcwd(), PREFS_FILE)


def prefs_seconds() -> int:
    """Seconds since the epoch, the unit every timestamp of these pages uses."""
    return int(datetime.now(timezone.utc).timestamp())


def clean_prefs(data) -> dict:
    """`{key: {value, updated}}` from whatever the file holds: anything unusable is dropped instead of raising.

    The file can be hand-edited (as every other storage file of a Jesse project can), so a broken key, a value that is
    not a string, or an old shape must not break the pages: those entries simply do not exist.
    """
    if not isinstance(data, dict):
        return {}
    prefs = {}
    for key, entry in data.items():
        if not isinstance(key, str) or not PREF_KEY.match(key) or not isinstance(entry, dict):
            continue
        value = entry.get('value')
        if not isinstance(value, str) or len(value.encode('utf-8')) > MAX_PREF_VALUE_BYTES:
            continue
        updated = entry.get('updated')
        if not isinstance(updated, (int, float)) or isinstance(updated, bool):
            updated = 0
        prefs[key] = {'value': value, 'updated': int(updated)}
    return prefs


def read_prefs() -> dict:
    """Every stored setting, `{}` when the file does not exist (or cannot be read as JSON)."""
    try:
        with open(prefs_path(), encoding='utf-8') as file:
            return clean_prefs(json.load(file))
    except (OSError, ValueError):
        return {}


def write_prefs(prefs: dict) -> None:
    """Replace the file atomically (temp file in the same folder, then `os.replace`).

    A crash or a full disk leaves either the old file or the new one, never a half-written JSON that would lose every
    setting; the temp file is removed if the write fails.
    """
    path = prefs_path()
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    handle, temp_path = tempfile.mkstemp(prefix='review-prefs-', suffix='.tmp', dir=folder)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as file:
            json.dump(prefs, file, ensure_ascii=False, sort_keys=True, indent=1)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_path, path)
    except BaseException:
        try:
            os.remove(temp_path)
        except OSError:
            pass
        raise


@router.post('/prefs')
def get_prefs() -> JSONResponse:
    """Every mirror of the pages' `jesse.*` localStorage keys: `{prefs: {key: value}, updated: {key: seconds}}`.

    A project that never synced reads as empty (the same answer as a project with no settings), so the first page
    open has nothing to explain.
    """
    prefs = read_prefs()
    return JSONResponse({'prefs': {key: entry['value'] for key, entry in prefs.items()},
                         'updated': {key: entry['updated'] for key, entry in prefs.items()}})


@router.post('/prefs/save')
def save_prefs(request_json: PrefsSaveJson) -> JSONResponse:
    """Write one batch of settings; `null` forgets a key. The whole batch is refused (400) on one bad item."""
    items = request_json.items or {}
    if len(items) > MAX_PREF_ITEMS:
        return JSONResponse({'error': f'一次最多保存 {MAX_PREF_ITEMS} 个设置（收到 {len(items)} 个）'}, status_code=400)
    for key, value in items.items():
        if not isinstance(key, str) or not PREF_KEY.match(key):
            return JSONResponse({'error': '设置名不合法：必须以 jesse. 开头，后面只能是字母、数字、_ . -（共 1–80 字符）'},
                                status_code=400)
        if value is None:
            continue
        if not isinstance(value, str):
            return JSONResponse({'error': f'设置值必须是字符串（删除请用 null）：{key}'}, status_code=400)
        if len(value.encode('utf-8')) > MAX_PREF_VALUE_BYTES:
            return JSONResponse({'error': f'设置值太大（单个上限 {MAX_PREF_VALUE_BYTES // 1024} KB）：{key}'},
                                status_code=400)

    with PREFS_LOCK:
        prefs = read_prefs()
        updated = prefs_seconds()
        saved = removed = 0
        for key, value in items.items():
            if value is None:
                # Nothing to delete is not an error: another tab may have removed the key already.
                removed += 1 if prefs.pop(key, None) is not None else 0
                continue
            prefs[key] = {'value': value, 'updated': updated}
            saved += 1
        # Nothing changed on disk: a delete of a key that does not exist writes no file (and creates no storage/).
        if saved or removed:
            write_prefs(prefs)
    return JSONResponse({'ok': True, 'saved': saved, 'removed': removed})
