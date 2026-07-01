"""
Client identification from request headers.
"""
from __future__ import annotations
from fastapi import Request

def identify(request: Request) -> dict:
    """Extract client info from the incoming request."""
    ua = request.headers.get('user-agent', '')
    ip = request.client.host if request.client else 'unknown'
    return {'ip': ip, 'user_agent': ua, 'origin': request.headers.get('origin', '')}