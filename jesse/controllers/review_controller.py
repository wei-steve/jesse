import base64
import binascii
import os
import re
from datetime import datetime, timezone
from typing import Optional

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
