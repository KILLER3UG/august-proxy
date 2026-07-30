"""Hooks API router — stats and management endpoints."""

from fastapi import APIRouter

from app.services.hooks.registry import registry

router = APIRouter(prefix='/api/hooks', tags=['hooks'])


@router.get('')
async def list_hooks():
    """List all registered hooks."""
    return registry.stats()


@router.get('/stats')
async def hook_stats():
    """Per-hook performance stats (p95, deny rate, breaker state)."""
    return registry.stats()
