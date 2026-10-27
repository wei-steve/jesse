from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any, List, Optional

from jesse.services import factor_finder
from jesse.services.auth import require_auth

router = APIRouter(prefix="/factors", tags=["Factors"], dependencies=[Depends(require_auth)])


class FactorRunRequestJson(BaseModel):
    factor: str
    exchange: str
    symbol: str
    # UTC: ISO string (no zone = UTC) or epoch milliseconds. Omitting `finish` means the newest 1m candle.
    start: Any
    finish: Optional[Any] = None
    timeframes: Optional[List[str]] = None
    params: Optional[dict] = None


@router.post("/list")
def list_factors() -> JSONResponse:
    """Factor files found in the project's factors/ folder (empty list when there is none)."""
    return JSONResponse(factor_finder.list_factors())


@router.post("/run")
def run_factor(request_json: FactorRunRequestJson) -> JSONResponse:
    """Run one factor on candles read directly from the database, including the latest minutes."""
    try:
        return JSONResponse(factor_finder.run_factor(request_json.model_dump()))
    except factor_finder.FactorError as exc:
        return JSONResponse({'error': str(exc)}, status_code=exc.status)
