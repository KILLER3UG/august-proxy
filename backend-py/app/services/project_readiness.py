"""Project readiness scoring — evaluates how ready a project is for agent work.

Part of Better Harness Plan Phase 4.1 + 4.6.
5 capabilities × L1-L5: Context Map, Environment Readiness, Fast Feedback,
Quality Gates, Change Safety. Adapts to project type (overlays).
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

# Project type detection patterns
_PROJECT_TYPES = {
    'library': ['setup.py', 'setup.cfg', 'pyproject.toml:build-system', 'Cargo.toml:lib'],
    'frontend': ['package.json:react', 'package.json:vue', 'package.json:svelte', 'vite.config'],
    'backend': ['app/main.py:FastAPI', 'package.json:express', 'Dockerfile', 'docker-compose'],
    'infrastructure': ['terraform', 'k8s', 'kubernetes', 'Dockerfile', '.github/workflows'],
    'docs': ['mkdocs.yml', 'docusaurus', 'docs/'],
}


def score_project_readiness(workspace_path: str) -> dict:
    """Score a project's readiness for AI agent work.

    Returns: {overall, capabilities: [{name, level, maxLevel, evidence, recommendations}], projectType}
    """
    if not workspace_path or not os.path.isdir(workspace_path):
        return {'overall': 0, 'capabilities': [], 'projectType': 'unknown', 'error': 'Invalid workspace path'}

    project_type = _detect_project_type(workspace_path)
    capabilities = [
        _score_context_map(workspace_path, project_type),
        _score_environment_readiness(workspace_path, project_type),
        _score_fast_feedback(workspace_path, project_type),
        _score_quality_gates(workspace_path, project_type),
        _score_change_safety(workspace_path, project_type),
    ]

    overall = sum(c['level'] for c in capabilities)
    max_overall = sum(c['maxLevel'] for c in capabilities)

    return {
        'overall': overall,
        'maxOverall': max_overall,
        'percentage': round(overall / max_overall * 100) if max_overall else 0,
        'projectType': project_type,
        'capabilities': capabilities,
    }


def _detect_project_type(workspace: str) -> str:
    """Detect the project shape for overlay adjustments."""
    files = _list_files(workspace, depth=2)
    file_names = {os.path.basename(f).lower() for f in files}

    if 'package.json' in file_names:
        pkg_path = os.path.join(workspace, 'package.json')
        try:
            with open(pkg_path, 'r', encoding='utf-8') as f:
                content = f.read(4096)
            if any(fw in content for fw in ('react', 'vue', 'svelte', 'next', 'vite')):
                return 'frontend'
            if any(fw in content for fw in ('express', 'fastify', 'koa', 'hono')):
                return 'backend'
        except OSError:
            pass

    if 'pyproject.toml' in file_names or 'setup.py' in file_names:
        try:
            with open(os.path.join(workspace, 'pyproject.toml'), 'r', encoding='utf-8') as f:
                content = f.read(4096)
            if 'fastapi' in content or 'uvicorn' in content:
                return 'backend'
            if '[build-system]' in content:
                return 'library'
        except OSError:
            pass

    if 'dockerfile' in file_names or 'docker-compose.yml' in file_names:
        return 'backend'
    if 'terraform' in ' '.join(file_names) or any('.tf' in f for f in file_names):
        return 'infrastructure'

    return 'general'


def _score_context_map(workspace: str, project_type: str) -> dict:
    """L1-L5: Can an agent reach the right context, boundary, risk, and next step?"""
    level = 0
    evidence = []
    recommendations = []

    if _exists(workspace, 'README.md'):
        level = 1
        evidence.append('README.md exists')
    if _exists(workspace, 'AGENTS.md') or _exists(workspace, 'CLAUDE.md') or _exists(workspace, 'QWEN.md'):
        level = max(level, 2)
        evidence.append('Agent instructions (AGENTS.md/CLAUDE.md)')
    if _exists(workspace, 'docs/ARCHITECTURE.md') or _exists(workspace, 'ARCHITECTURE.md'):
        level = max(level, 3)
        evidence.append('Architecture doc')
    if _exists(workspace, 'docs/CONFIGURATION.md') or _exists(workspace, 'CONTRIBUTING.md'):
        level = max(level, 3)
        evidence.append('Configuration/contribution guide')
    # L4: scoped instructions per directory
    nested_agents = _find_files(workspace, 'AGENTS.md', depth=3)
    if len(nested_agents) > 1:
        level = max(level, 4)
        evidence.append(f'{len(nested_agents)} scoped instruction files')
    # L5: design docs + specs
    if _exists(workspace, 'docs/design/') or _exists(workspace, 'docs/specs/'):
        level = max(level, 5)
        evidence.append('Design/spec docs')

    if level < 2:
        recommendations.append('Add AGENTS.md with project commands, boundaries, and risk areas')
    if level < 3:
        recommendations.append('Add architecture documentation')

    return {'name': 'Context Map', 'level': level, 'maxLevel': 5, 'evidence': evidence, 'recommendations': recommendations}


def _score_environment_readiness(workspace: str, project_type: str) -> dict:
    """L1-L5: Can an agent set up, run, diagnose, reset, and isolate?"""
    level = 0
    evidence = []
    recommendations = []

    has_pkg = _exists(workspace, 'package.json') or _exists(workspace, 'pyproject.toml') or _exists(workspace, 'Cargo.toml')
    if has_pkg:
        level = 1
        evidence.append('Package manifest exists')

    has_scripts = False
    if _exists(workspace, 'package.json'):
        try:
            with open(os.path.join(workspace, 'package.json'), 'r', encoding='utf-8') as f:
                if '"scripts"' in f.read(8192):
                    has_scripts = True
        except OSError:
            pass
    if has_scripts or _exists(workspace, 'Makefile') or _exists(workspace, 'justfile'):
        level = max(level, 2)
        evidence.append('Build/run scripts defined')

    if _exists(workspace, 'docker-compose.yml') or _exists(workspace, '.devcontainer/'):
        level = max(level, 3)
        evidence.append('Containerized dev environment')

    # Doctor/setup scripts
    if _find_files(workspace, 'doctor', depth=2) or _find_files(workspace, 'setup', depth=2):
        level = max(level, 3)
        evidence.append('Doctor/setup script')

    if _exists(workspace, '.env.example') or _exists(workspace, '.env.template'):
        level = max(level, 4)
        evidence.append('Environment template')

    if level < 2:
        recommendations.append('Add scripts for setup, run, and test')

    return {'name': 'Environment Readiness', 'level': level, 'maxLevel': 5, 'evidence': evidence, 'recommendations': recommendations}


def _score_fast_feedback(workspace: str, project_type: str) -> dict:
    """L1-L5: Do affected checks return timely, actionable behavior evidence?"""
    level = 0
    evidence = []
    recommendations = []

    # Test framework detection
    test_indicators = ['pytest.ini', 'conftest.py', 'vitest.config', 'jest.config', 'package.json:test']
    if any(_exists(workspace, i.split(':')[0]) for i in test_indicators):
        level = 1
        evidence.append('Test framework detected')
    elif _find_files(workspace, 'test_', depth=2) or _find_files(workspace, '.test.', depth=2):
        level = 1
        evidence.append('Test files found')

    # Lint/type checking
    lint_indicators = ['.eslintrc', 'eslint.config', 'ruff.toml', 'pyproject.toml:ruff', '.flake8', 'tsconfig.json', 'mypy.ini']
    if any(_exists(workspace, i.split(':')[0]) for i in lint_indicators):
        level = max(level, 2)
        evidence.append('Lint/type checking configured')

    # Pre-commit hooks
    if _exists(workspace, '.pre-commit-config.yaml') or _exists(workspace, '.husky/'):
        level = max(level, 3)
        evidence.append('Pre-commit hooks')

    # Watch mode / fast feedback tools
    if _exists(workspace, 'package.json'):
        try:
            with open(os.path.join(workspace, 'package.json'), 'r', encoding='utf-8') as f:
                content = f.read(8192)
            if 'watch' in content or 'nodemon' in content or 'watchfiles' in content:
                level = max(level, 3)
                evidence.append('Watch mode available')
        except OSError:
            pass

    if level < 1:
        recommendations.append('Add a test command (pytest, vitest, jest, etc.)')
    if level < 2:
        recommendations.append('Add linting/type checking (ruff, eslint, mypy, tsc)')

    return {'name': 'Fast Feedback', 'level': level, 'maxLevel': 5, 'evidence': evidence, 'recommendations': recommendations}


def _score_quality_gates(workspace: str, project_type: str) -> dict:
    """L1-L5: Are relevant rules mechanically checked and repairable?"""
    level = 0
    evidence = []
    recommendations = []

    if _exists(workspace, '.github/workflows/') or _exists(workspace, '.gitlab-ci.yml') or _exists(workspace, 'Jenkinsfile'):
        level = 1
        evidence.append('CI pipeline exists')

    if _exists(workspace, '.pre-commit-config.yaml'):
        level = max(level, 2)
        evidence.append('Pre-commit quality gates')

    # Branch protection hints (CODEOWNERS, PR templates)
    if _exists(workspace, 'CODEOWNERS') or _exists(workspace, '.github/CODEOWNERS'):
        level = max(level, 3)
        evidence.append('CODEOWNERS (review routing)')
    if _exists(workspace, '.github/pull_request_template.md'):
        level = max(level, 3)
        evidence.append('PR template')

    if _exists(workspace, '.github/dependabot.yml') or _exists(workspace, 'renovate.json'):
        level = max(level, 4)
        evidence.append('Dependency automation')

    if level < 1:
        recommendations.append('Add CI (GitHub Actions, GitLab CI, etc.)')

    return {'name': 'Quality Gates', 'level': level, 'maxLevel': 5, 'evidence': evidence, 'recommendations': recommendations}


def _score_change_safety(workspace: str, project_type: str) -> dict:
    """L1-L5: Are agent changes bounded, accepted through evidence, and recoverable?"""
    level = 0
    evidence = []
    recommendations = []

    if _exists(workspace, '.git/'):
        level = 1
        evidence.append('Git version control')

    if _exists(workspace, '.git/hooks/'):
        try:
            hooks = os.listdir(os.path.join(workspace, '.git', 'hooks'))
            if len(hooks) > 1:
                level = max(level, 2)
                evidence.append('Git hooks active')
        except OSError:
            pass

    if _exists(workspace, '.pre-commit-config.yaml') or _exists(workspace, '.husky/'):
        level = max(level, 2)
        evidence.append('Pre-commit lifecycle hooks')

    # Rollback/recovery mechanisms
    if _exists(workspace, 'docker-compose.yml') or _exists(workspace, 'Makefile'):
        level = max(level, 3)
        evidence.append('Reset/rollback mechanism')

    if _exists(workspace, '.github/workflows/'):
        level = max(level, 3)
        evidence.append('CI-based acceptance path')

    if level < 2:
        recommendations.append('Add pre-commit hooks or lifecycle guards')

    return {'name': 'Change Safety', 'level': level, 'maxLevel': 5, 'evidence': evidence, 'recommendations': recommendations}


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _exists(workspace: str, relative: str) -> bool:
    """Check if a path exists relative to workspace."""
    return os.path.exists(os.path.join(workspace, relative))


def _list_files(workspace: str, depth: int = 2) -> list[str]:
    """List files up to N levels deep."""
    result = []
    for root, dirs, files in os.walk(workspace):
        # Limit depth
        rel = os.path.relpath(root, workspace)
        if rel.count(os.sep) >= depth:
            dirs.clear()
            continue
        # Skip noise
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.git', '__pycache__', '.venv', 'dist', 'build')]
        for f in files:
            result.append(os.path.join(root, f))
    return result


def _find_files(workspace: str, pattern: str, depth: int = 2) -> list[str]:
    """Find files matching a substring pattern."""
    return [f for f in _list_files(workspace, depth) if pattern in os.path.basename(f).lower()]
