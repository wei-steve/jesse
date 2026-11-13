import base64
import binascii
import json
import os
import re
from datetime import datetime, timezone
from typing import Optional, Union

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

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
LABELS_FILE = 'finder-labels.jsonl'
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
LABEL_KINDS = ('trend', 'order', 'note')
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


class LabelsRequestJson(BaseModel):
    """Which factor run the marks are asked for. Every field is optional so a partial filter still works."""
    factor: Optional[str] = None
    exchange: Optional[str] = None
    symbol: Optional[str] = None


def labels_path() -> str:
    """storage/labels/finder-labels.jsonl under the cwd of `jesse run`, like the screenshots folder."""
    return os.path.join(os.getcwd(), LABELS_FOLDER, LABELS_FILE)


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
    """Append one mark (kind trend / order, good / bad / clear) or one note to the project's label file."""
    kind = (request_json.kind or DEFAULT_LABEL_KIND).strip()
    if kind not in LABEL_KINDS:
        return JSONResponse({'error': 'kind 只能是 ' + ' / '.join(LABEL_KINDS)}, status_code=400)
    # A note row needs no good / bad; a trend or order row is nothing without its label.
    if kind != 'note' and request_json.label not in LABEL_VALUES:
        return JSONResponse({'error': 'label 只能是 ' + ' / '.join(LABEL_VALUES)}, status_code=400)
    key = request_json.key.strip()
    if not key:
        return JSONResponse({'error': 'key 不能为空'}, status_code=400)
    if len(key) > MAX_KEY:
        return JSONResponse({'error': f'key 太长（上限 {MAX_KEY} 字符）'}, status_code=400)

    record = request_json.model_dump(exclude_none=True)
    record['key'] = key
    record['kind'] = kind
    # A note is trimmed and capped instead of rejected: losing the tail of one line of text is better than losing
    # the mark the user just made. The note is its own mark now (kind=note), so clearing a good / bad leaves it.
    note = (request_json.note or '').strip()[:MAX_LABEL_NOTE]
    if kind == 'note':
        # Only the text: a note row is not a mark, and an empty note is the explicit "clear the note" row.
        record.pop('label', None)
        record['note'] = note
    elif note:
        record['note'] = note
    else:
        record.pop('note', None)
    # UTC ISO, same stamp style as the rest of this controller. Only appended fields are added; nothing is rewritten.
    record['saved_at'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

    line = json.dumps(record, ensure_ascii=False)
    if len(line.encode('utf-8')) > MAX_RECORD_BYTES:
        return JSONResponse({'error': f'标注太大（一条上限 {MAX_RECORD_BYTES // 1024} KB）'}, status_code=413)

    path = labels_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as file:
        file.write(line + '\n')
    return JSONResponse({'ok': True})


@router.post('/labels')
def get_labels(request_json: LabelsRequestJson) -> JSONResponse:
    """Every signal's two marks and its note, as the last row of each kind per key."""
    latest = {}
    for row in read_label_rows(labels_path()):
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
    return JSONResponse({'labels': labels})
