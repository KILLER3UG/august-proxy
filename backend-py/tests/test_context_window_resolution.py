"""Per-model contextWindow from providers.json must win over profiles/heuristics."""

from app.services import model_service as ms


def test_explicit_model_entry_beats_wildcard_profile():
    provider = {
        'name': 'Opencode Zen',
        'modelProfiles': {'*': {'contextWindow': 128000}},
        'models': [{'id': 'any-custom-model', 'contextWindow': 1_000_000}],
    }
    assert ms._getContextWindow('any-custom-model', provider) == 1_000_000


def test_user_entry_beats_live_api_fallback():
    """Model Providers UI must win over host /models metadata (often 128k)."""
    provider = {
        'name': 'Opencode Zen',
        'modelProfiles': {'*': {'contextWindow': 128000}},
        'models': [{'id': 'gpt-custom', 'contextWindow': 2000000}],
    }
    assert ms._getContextWindow('gpt-custom', provider, 128000) == 2000000


def test_fallback_beats_wildcard_when_no_model_window():
    provider = {
        'name': 'Opencode Zen',
        'modelProfiles': {'*': {'contextWindow': 128000}},
        'models': [{'id': 'mystery-model', 'name': 'Mystery'}],
    }
    assert ms._getContextWindow('mystery-model', provider, 2000000) == 2000000


def test_profile_used_when_model_entry_has_no_window():
    provider = {
        'name': 'Custom',
        'modelProfiles': {'my-model': {'contextWindow': 256000}},
        'models': [{'id': 'my-model', 'name': 'My Model'}],
    }
    assert ms._getContextWindow('my-model', provider) == 256000


def test_wildcard_does_not_mask_family_heuristic():
    provider = {
        'name': 'Opencode Zen',
        'modelProfiles': {'*': {'contextWindow': 128000}},
        'models': [{'id': 'deepseek-v4-flash', 'name': 'Flash'}],
    }
    assert ms._getContextWindow('deepseek-v4-flash', provider) == 1_000_000


def test_fetched_128k_stamp_does_not_mask_heuristic():
    provider = {
        'name': 'Opencode Zen',
        'models': [
            {
                'id': 'deepseek-v4-flash',
                'contextWindow': 128000,
                'source': 'fetched',
            }
        ],
    }
    assert ms._getContextWindow('deepseek-v4-flash', provider) == 1_000_000


def test_manual_128k_is_respected():
    provider = {
        'name': 'Custom',
        'models': [
            {'id': 'deepseek-v4-flash', 'contextWindow': 128000, 'source': 'manual'}
        ],
    }
    assert ms._getContextWindow('deepseek-v4-flash', provider) == 128000


def test_manual_custom_window_wins():
    provider = {
        'name': 'Custom',
        'modelProfiles': {'*': {'contextWindow': 128000}},
        'models': [
            {'id': 'any-model', 'contextWindow': 512000, 'source': 'manual'}
        ],
    }
    assert ms._getContextWindow('any-model', provider, 128000) == 512000



def test_invalidate_cache_reloads_settings(tmp_path, monkeypatch):
    """After providers.json changes, settings.providers must refresh."""
    from app.config import settings

    providers_path = tmp_path / 'providers.json'
    providers_path.write_text(
        '{"providers":[{"id":"p1","name":"P1","enabled":true,"apiKey":"k","models":[{"id":"m1","contextWindow":999999}]}]}',
        encoding='utf-8',
    )
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    assert settings.providers['providers'][0]['models'][0]['contextWindow'] == 999999

    # Mutate on disk without going through settings
    providers_path.write_text(
        '{"providers":[{"id":"p1","name":"P1","enabled":true,"apiKey":"k","models":[{"id":"m1","contextWindow":555555}]}]}',
        encoding='utf-8',
    )
    ms.invalidate_cache()
    assert settings.providers['providers'][0]['models'][0]['contextWindow'] == 555555
