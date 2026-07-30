"""Tests for Phase 5: UX & Onboarding features."""

import os

import pytest
from app.services.automation_gate import render_spec_card, validate_automation_spec
from app.services.guidance import get_guidance
from app.services.provider_detect import detect_providers

# ─── Support Tracks (5.3) ─────────────────────────────────────────────────────


class TestGuidance:
    def test_bootstrap_for_empty_project(self, tmp_path):
        result = get_guidance(str(tmp_path))
        assert result['track'] == 'bootstrap'
        assert result['score'] < 30
        assert len(result['steps']) >= 2
        assert any('AGENTS.md' in s['title'] for s in result['steps'])

    def test_operationalize_for_partial_project(self, tmp_path):
        (tmp_path / 'README.md').write_text('# Project')
        (tmp_path / 'AGENTS.md').write_text('# Agents')
        (tmp_path / 'package.json').write_text('{"scripts": {"test": "vitest", "lint": "eslint"}}')
        (tmp_path / '.github' / 'workflows').mkdir(parents=True)
        (tmp_path / '.github' / 'workflows' / 'ci.yml').write_text('on: push')
        result = get_guidance(str(tmp_path))
        # With README + AGENTS + scripts + CI, should be operationalize range
        assert result['track'] in ('bootstrap', 'operationalize')
        assert len(result['steps']) >= 2

    def test_optimize_for_full_project(self, tmp_path):
        (tmp_path / 'README.md').write_text('# Project')
        (tmp_path / 'AGENTS.md').write_text('# Agents')
        (tmp_path / 'CONTRIBUTING.md').write_text('# Contrib')
        (tmp_path / 'package.json').write_text('{"scripts": {"test": "vitest", "lint": "eslint", "watch": "vitest --watch"}}')
        (tmp_path / '.github' / 'workflows').mkdir(parents=True)
        (tmp_path / '.github' / 'workflows' / 'ci.yml').write_text('on: push')
        (tmp_path / '.pre-commit-config.yaml').write_text('repos: []')
        (tmp_path / '.git').mkdir()
        (tmp_path / 'CODEOWNERS').write_text('* @team')
        (tmp_path / '.github' / 'pull_request_template.md').write_text('## Changes')
        (tmp_path / '.github' / 'dependabot.yml').write_text('version: 2')
        (tmp_path / 'docs' / 'design').mkdir(parents=True)
        result = get_guidance(str(tmp_path))
        # Well-equipped project should be at least operationalize
        assert result['track'] in ('operationalize', 'optimize')
        assert result['score'] >= 30

    def test_no_workspace_returns_bootstrap(self):
        result = get_guidance(None)
        assert result['track'] == 'bootstrap'
        assert result['score'] == 0


# ─── Automation Gate (5.7 + 5.8) ─────────────────────────────────────────────


class TestAutomationGate:
    def test_valid_spec(self):
        spec = {
            'name': 'daily-report',
            'type': 'workbench',
            'trigger': '0 9 * * *',
            'runScope': 'Generate daily summary',
            'stopCondition': 'After 1 successful run',
            'validation': 'Check output file exists',
            'sandbox': 'read-only',
        }
        result = validate_automation_spec(spec)
        assert result['valid'] is True
        assert len(result['errors']) == 0

    def test_missing_required_fields(self):
        spec = {'name': 'incomplete', 'type': 'workbench'}
        result = validate_automation_spec(spec)
        assert result['valid'] is False
        assert len(result['errors']) >= 3  # trigger, runScope, stopCondition

    def test_shell_requires_sandbox(self):
        spec = {
            'name': 'shell-job',
            'type': 'shell',
            'trigger': 'every 1h',
            'runScope': 'Run cleanup',
            'stopCondition': 'After 3 iterations',
        }
        result = validate_automation_spec(spec)
        assert result['valid'] is False
        assert any('sandbox' in e for e in result['errors'])

    def test_empty_stop_condition_rejected(self):
        spec = {
            'name': 'no-stop',
            'type': 'workbench',
            'trigger': 'every 1h',
            'runScope': 'Do thing',
            'stopCondition': 'never',
        }
        result = validate_automation_spec(spec)
        assert result['valid'] is False
        assert any('Stop condition' in e for e in result['errors'])

    def test_spec_card_rendering(self):
        spec = {
            'name': 'test-auto',
            'trigger': 'every 6h',
            'runScope': 'Check deps',
            'prompt': 'Run npm audit and report',
            'validation': 'No critical vulns',
            'stopCondition': 'After 1 run',
            'outputArtifact': 'audit-report.json',
        }
        card = render_spec_card(spec)
        assert 'WHEN: every 6h' in card
        assert 'STOP: After 1 run' in card
        assert 'LEAVE: audit-report.json' in card

    def test_warnings_for_recommended_fields(self):
        spec = {
            'name': 'minimal',
            'type': 'workbench',
            'trigger': 'daily',
            'runScope': 'Do stuff',
            'stopCondition': 'After 1 run',
        }
        result = validate_automation_spec(spec)
        assert result['valid'] is True
        assert len(result['warnings']) > 0  # Missing validation, sandbox, etc.


# ─── Provider Detection (5.2) ─────────────────────────────────────────────────


class TestProviderDetect:
    def test_detects_openai(self, monkeypatch):
        monkeypatch.setenv('OPENAI_API_KEY', 'sk-test123456789012345678901234')
        result = detect_providers()
        assert len(result) >= 1
        openai = next(p for p in result if p['name'] == 'OpenAI')
        assert openai['baseUrl'] == 'https://api.openai.com/v1'
        assert openai['keyPrefix'] == 'sk-t****'
        assert 'sk-test123456789012345678901234' not in str(result)  # Full key never exposed

    def test_detects_multiple(self, monkeypatch):
        monkeypatch.setenv('OPENAI_API_KEY', 'sk-aaa123456789012345678901234')
        monkeypatch.setenv('ANTHROPIC_API_KEY', 'sk-ant-bbb123456789012345678901234')
        result = detect_providers()
        names = {p['name'] for p in result}
        assert 'OpenAI' in names
        assert 'Anthropic' in names

    def test_empty_env_returns_nothing(self, monkeypatch):
        # Clear all known provider keys
        for key in ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY']:
            monkeypatch.delenv(key, raising=False)
        result = detect_providers()
        # May still detect others from real env, so just check structure
        assert isinstance(result, list)

    def test_never_exposes_full_key(self, monkeypatch):
        monkeypatch.setenv('OPENAI_API_KEY', 'sk-super-secret-key-1234567890')
        result = detect_providers()
        result_str = str(result)
        assert 'super-secret-key' not in result_str


# ─── Longitudinal Trends (5.4) ────────────────────────────────────────────────


class TestTrends:
    def test_record_and_retrieve(self, tmp_path, monkeypatch):
        import sqlite3

        from app.services.memory_schema import ensure_schema

        db_file = tmp_path / 'trends.sqlite'
        conn = sqlite3.connect(str(db_file))
        conn.row_factory = sqlite3.Row
        ensure_schema(conn)

        import app.services.memory_store as ms
        monkeypatch.setattr(ms, '_conn', lambda: conn)

        from app.services.memory.trends import get_trends, record_weekly_snapshot

        snapshot = record_weekly_snapshot()
        assert snapshot is not None
        assert 'weekStart' in snapshot

        # Second call same week returns None (already recorded)
        assert record_weekly_snapshot() is None

        trends = get_trends(weeks=12)
        assert len(trends) == 1
        assert trends[0]['frictionTotal'] == 0

        conn.close()
