"""Workbench re-export of the single model-fleet service.

All runtime role resolution goes through ``model_fleet_service``. This
module exists so existing ``from app.services.workbench import model_fleet``
imports keep working.
"""

from __future__ import annotations

from app.services.model_fleet_service import (
    DEFAULTS as DEFAULT_FLEET,
    ROLES,
    getFleet,
    getModelForRole,
    invalidate_cache,
    updateFleet,
    validateRoles,
    _reset_cache,
    _resetCache,
)

__all__ = [
    'DEFAULT_FLEET',
    'ROLES',
    'getFleet',
    'getModelForRole',
    'invalidate_cache',
    'updateFleet',
    'validateRoles',
    '_reset_cache',
    '_resetCache',
]
