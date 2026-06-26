"""
Response helpers — send JSON or error responses through FastAPI.
"""

from __future__ import annotations

from fastapi.responses import JSONResponse


def send_json(data, status: int = 200) -> JSONResponse:
    return JSONResponse(content=data, status_code=status)


def send_error(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(content={"error": message}, status_code=status)
