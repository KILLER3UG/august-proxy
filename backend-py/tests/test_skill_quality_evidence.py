"""Tests for skill quality scoring (3.4) and evidence states (3.5)."""

import pytest
from app.services.evidence import EvidenceState, TurnEvidenceTracker
from app.services.skills.quality import score_skill

# ─── Skill Quality (3.4) ──────────────────────────────────────────────────────


class TestSkillQuality:
    def test_good_skill_scores_high(self):
        result = score_skill(
            name='diagnose-backend-bug',
            description='Diagnose backend 500 errors with structured evidence',
            body='## Steps\n1. Read logs\n2. Correlate request ID\n3. Identify root cause\n\n## Expected output\nDiagnosis package with status.\n\n## If it fails\nReport blocked with reason.',
            trigger='backend error 500 diagnosis',
            category='debugging',
            use_count=5,
            last_used_at='2026-07-28T10:00:00',
            created_at='2026-07-01T10:00:00',
        )
        assert result['score'] >= 70
        assert result['breakdown']['discovery'] >= 15
        assert result['breakdown']['effectiveness'] >= 20
        assert result['breakdown']['completeness'] >= 15
        assert result['breakdown']['safety'] == 15

    def test_empty_skill_scores_low(self):
        result = score_skill(
            name='x',
            description='',
            body='',
            trigger=None,
            category=None,
            use_count=0,
        )
        assert result['score'] <= 30
        assert result['breakdown']['effectiveness'] == 0
        assert result['breakdown']['completeness'] == 0

    def test_dangerous_skill_loses_safety(self):
        result = score_skill(
            name='cleanup',
            description='Clean up old files',
            body='Run rm -rf on all files in the directory to clean up.',
            trigger='cleanup',
            category='maintenance',
        )
        assert result['breakdown']['safety'] < 15

    def test_stale_skill_loses_freshness(self):
        result = score_skill(
            name='old-skill',
            description='An old skill',
            body='Some body content that is long enough to pass the threshold of two hundred characters. ' * 3,
            trigger='old trigger',
            category='test',
            created_at='2025-01-01T00:00:00',  # > 180 days ago
        )
        assert result['breakdown']['freshness'] == 0

    def test_score_capped_at_100(self):
        result = score_skill(
            name='perfect-skill',
            description='A perfect skill for testing',
            body='## Steps\n1. Do thing\n2. Verify\n\n## Expected output\nSuccess.\n\n## If it fails\nRetry.' + 'x' * 200,
            trigger='test trigger',
            category='testing',
            use_count=10,
            last_used_at='2026-07-29T10:00:00',
            created_at='2026-07-20T10:00:00',
        )
        assert result['score'] <= 100


# ─── Evidence States (3.5) ────────────────────────────────────────────────────


class TestEvidenceStates:
    def test_read_only_turn(self):
        tracker = TurnEvidenceTracker()
        tracker.record_tool('read_file', {'path': 'main.py'})
        tracker.record_tool('memory_search', {'query': 'test'})
        assert tracker.classify() == EvidenceState.READ_ONLY

    def test_verified_turn(self):
        tracker = TurnEvidenceTracker()
        tracker.record_tool('write_file', {'path': 'app/main.py', 'content': '...'})
        tracker.record_tool('run_command', {'command': 'uv run pytest -q'}, result='12 passed')
        assert tracker.classify() == EvidenceState.VERIFIED

    def test_unverified_turn(self):
        tracker = TurnEvidenceTracker()
        tracker.record_tool('write_file', {'path': 'app/main.py', 'content': '...'})
        tracker.record_tool('read_file', {'path': 'app/other.py'})
        assert tracker.classify() == EvidenceState.UNVERIFIED

    def test_verification_before_mutation_doesnt_count(self):
        tracker = TurnEvidenceTracker()
        tracker.record_tool('run_command', {'command': 'pytest'}, result='5 passed')
        tracker.record_tool('write_file', {'path': 'app/main.py', 'content': '...'})
        # Verification was BEFORE mutation — doesn't count
        assert tracker.classify() == EvidenceState.UNVERIFIED

    def test_mutation_resets_prior_verification(self):
        tracker = TurnEvidenceTracker()
        tracker.record_tool('write_file', {'path': 'a.py', 'content': '...'})
        tracker.record_tool('run_command', {'command': 'pytest'}, result='ok')
        tracker.record_tool('write_file', {'path': 'b.py', 'content': '...'})
        # Second mutation resets verification
        assert tracker.classify() == EvidenceState.UNVERIFIED

    def test_lint_counts_as_verification(self):
        tracker = TurnEvidenceTracker()
        tracker.record_tool('edit_lines', {'path': 'app/main.py', 'diff': '...'})
        tracker.record_tool('run_command', {'command': 'ruff check .'}, result='All checks passed')
        assert tracker.classify() == EvidenceState.VERIFIED

    def test_non_test_command_is_mutation(self):
        tracker = TurnEvidenceTracker()
        tracker.record_tool('run_command', {'command': 'pip install requests'})
        # pip install is not verification — it's a mutation
        assert tracker.classify() == EvidenceState.UNVERIFIED

    def test_to_dict_shape(self):
        tracker = TurnEvidenceTracker()
        tracker.record_tool('write_file', {'path': 'x.py', 'content': '...'})
        tracker.record_tool('run_command', {'command': 'pytest tests/'}, result='3 passed')
        d = tracker.to_dict()
        assert d['type'] == 'evidenceState'
        assert d['state'] == 'verified'
        assert d['verificationTool'] == 'run_command'
        assert 'passed' in d['verificationOutput']
