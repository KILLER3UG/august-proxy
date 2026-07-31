"""Tests for Sprint B.2 (API envelope) and Sprint D.4 (ownership router)."""

import pytest
from app.lib.api_envelope import error, paginated, success
from app.services.ownership_router import _friction_to_demand_type, get_suggestions, suggest_owner

# ─── API Envelope (B.2) ───────────────────────────────────────────────────────


class TestApiEnvelopeIntegration:
    def test_success_wraps_data(self):
        result = success({'score': 42})
        assert result == {'ok': True, 'formatVersion': '1.0', 'data': {'score': 42}}

    def test_error_shape(self):
        result = error('NOT_FOUND', 'Missing', hint='Check ID')
        assert result['ok'] is False
        assert result['error']['code'] == 'NOT_FOUND'
        assert result['error']['hint'] == 'Check ID'

    def test_paginated_has_more(self):
        result = paginated([1, 2, 3], total=10, offset=0, limit=3)
        assert result['meta']['pagination']['hasMore'] is True

    def test_paginated_last_page(self):
        result = paginated([1], total=1, offset=0, limit=10)
        assert result['meta']['pagination']['hasMore'] is False


# ─── Ownership Router (D.4) ──────────────────────────────────────────────────


class TestOwnershipRouter:
    def test_correction_routes_to_memory(self):
        result = suggest_owner({'type': 'correction'})
        assert result['suggestedOwner'] == 'memory'
        assert result['action'] == 'create'

    def test_repeated_procedure_routes_to_skill(self):
        result = suggest_owner({'type': 'repeated_procedure'})
        assert result['suggestedOwner'] == 'skill'

    def test_deterministic_check_routes_to_hook(self):
        result = suggest_owner({'type': 'deterministic_check'})
        assert result['suggestedOwner'] == 'hook'

    def test_existing_coverage_suggests_extend(self):
        result = suggest_owner({'type': 'correction', 'existingCoverage': 'heuristic: use uv'})
        assert result['suggestedOwner'] == 'extend_existing'
        assert result['action'] == 'extend'

    def test_unknown_type_needs_evidence(self):
        result = suggest_owner({'type': 'something_new'})
        assert result['suggestedOwner'] == 'needs_evidence'
        assert result['action'] == 'investigate'

    def test_friction_category_mapping(self):
        assert _friction_to_demand_type('tool') == 'deterministic_check'
        assert _friction_to_demand_type('harness') == 'project_fact'
        assert _friction_to_demand_type('model') == 'correction'
        assert _friction_to_demand_type('external') == 'external_access'

    def test_get_suggestions_returns_list(self):
        # With empty DB, should return empty list (no friction, no workflows)
        result = get_suggestions()
        assert isinstance(result, list)

    def test_all_owner_types_defined(self):
        from app.services.ownership_router import _ROUTING_RULES, OWNER_TYPES

        # Every routing rule owner should be in the OWNER_TYPES list
        for rule in _ROUTING_RULES.values():
            assert rule['owner'] in OWNER_TYPES
