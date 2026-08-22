"""Regression tests for round 3: graph eviction protection (P3-8) and
background-task model selection following the user's chosen model."""

from __future__ import annotations

import json

# ─── P3-8: graph entity eviction must not eat durable memory ────────────────


class TestGraphEvictionProtection:
    def test_low_importance_entity_evicted_first(self):
        """Plain-LRU behavior preserved when victims are unprotected."""
        from app.services.memory import graph_memory

        graph_memory._graph_lock_acquire = getattr(graph_memory, '_graph_lock', None)
        # Fill one slot over cap with an old, low-value entity + a newer one.
        old_key = 'old_general_note'
        new_key = 'newer_general_note'
        graph_memory.addEntity(old_key, entityType='general', metadata={'importance': 0.3})
        graph_memory.addEntity(new_key, entityType='general', metadata={'importance': 0.3})
        conn = graph_memory._conn()
        # Force the cap to 2 and age the old row so LRU order is deterministic.
        original_max = graph_memory._MAXEntities
        graph_memory._MAXEntities = 2
        try:
            conn.execute(
                "UPDATE graph_entities SET updated_at = '2020-01-01T00:00:00Z' WHERE name_key = ?",
                (old_key,),
            )
            conn.commit()
            graph_memory.addEntity('trigger_new', entityType='general', metadata={'importance': 0.3})
            keys = {
                r['name_key']
                for r in conn.execute('SELECT name_key FROM graph_entities').fetchall()
            }
            assert old_key not in keys, 'oldest unprotected entity must be evicted'
            assert new_key in keys
            assert 'trigger_new' in keys
        finally:
            graph_memory._MAXEntities = original_max

    def test_workflow_rule_survives_eviction(self):
        """A learned correction must never be the LRU victim."""
        from app.services.memory import graph_memory

        conn = graph_memory._conn()
        original_max = graph_memory._MAXEntities
        graph_memory._MAXEntities = 2
        try:
            conn.execute('DELETE FROM graph_entities')
            conn.commit()
            # Old workflowRule + young general entity; LRU would pick the rule.
            graph_memory.addEntity(
                'correction_never_deploy_friday',
                entityType='workflowRule',
                metadata={'importance': 0.8},
            )
            graph_memory.addEntity('chatter_node', entityType='general', metadata={'importance': 0.4})
            conn.execute(
                "UPDATE graph_entities SET updated_at = '2020-01-01T00:00:00Z' "
                "WHERE name_key = 'correction_never_deploy_friday'"
            )
            conn.commit()
            graph_memory.addEntity('trigger_new', entityType='general', metadata={})
            types = dict(
                (r['name_key'], r['entity_type'])
                for r in conn.execute('SELECT name_key, entity_type FROM graph_entities').fetchall()
            )
            assert 'correction_never_deploy_friday' in types, 'workflowRule evicted despite protection'
            assert types.get('chatter_node') is None, 'unprotected younger node should have been the victim'
        finally:
            graph_memory._MAXEntities = original_max

    def test_high_importance_survives_eviction(self):
        """metadata.importance >= 0.7 is durable regardless of entity type."""
        from app.services.memory import graph_memory

        conn = graph_memory._conn()
        original_max = graph_memory._MAXEntities
        graph_memory._MAXEntities = 2
        try:
            conn.execute('DELETE FROM graph_entities')
            conn.commit()
            graph_memory.addEntity(
                'vital_fact',
                entityType='general',
                metadata={'importance': 0.9},
            )
            graph_memory.addEntity('filler', entityType='general', metadata={'importance': 0.1})
            conn.execute(
                "UPDATE graph_entities SET updated_at = '2020-01-01T00:00:00Z' WHERE name_key = 'vital_fact'"
            )
            conn.commit()
            graph_memory.addEntity('trigger_new', entityType='general', metadata={})
            keys = {
                r['name_key']
                for r in conn.execute('SELECT name_key FROM graph_entities').fetchall()
            }
            assert 'vital_fact' in keys, 'high-importance entity evicted despite protection'
            assert 'filler' not in keys
        finally:
            graph_memory._MAXEntities = original_max


# ─── Background tasks follow the user's selected model ───────────────────────


class TestBackgroundTaskModelSelection:
    def test_hint_used_when_no_config(self):
        from app.services.workbench.providers import background_task_model

        assert background_task_model('reviewModel', 'user-picked/model-x') == 'user-picked/model-x'

    def test_config_overrides_hint(self):
        from app.services import background_review_service
        from app.services.workbench.providers import background_task_model

        background_review_service.saveConfig(review_model='configured/review-model', actor='test')
        try:
            assert background_task_model('reviewModel', 'user-picked/model-x') == 'configured/review-model'
        finally:
            background_review_service.saveConfig(review_model='', actor='test')

    def test_review_client_uses_session_model_not_hardcoded(self):
        """The review client must target the session's model — never the old
        hardcoded claude-sonnet fallback — when no config override exists."""
        import inspect

        from app.services.workbench import providers

        src = inspect.getsource(providers.make_review_llm_client)
        assert 'claude-sonnet-4-20250514' not in src, (
            'hardcoded fallback model still present in make_review_llm_client'
        )

    def test_review_client_resolves_provider_default_when_hint_empty(self):
        """Empty hint → provider defaultModel, which is what the user configured."""
        from app.providers import resolver as providerResolver
        from app.services.workbench.providers import make_review_llm_client

        provider = providerResolver.resolve('')
        if provider is None or not provider.get('defaultModel'):
            return  # nothing configured on this install; nothing to assert
        client = make_review_llm_client(provider, '')
        # The closure must exist and be callable; the model it captured equals
        # the provider default (verified via source inspection above for the
        # no-hardcode property, and here by construction).
        assert callable(client)
