"""v2 hardening — Test skill name sanitizer (Title Case → camelCase)."""
import pytest
from app.services.consolidation_daemon import _sanitize_skill_name


def test_sanitize_title_case():
    """Title Case 'Debug Python Script' → camelCase 'debugPythonScript'."""
    assert _sanitize_skill_name("Debug Python Script") == "debugPythonScript"


def test_sanitize_snake_case():
    """snake_case 'user_preferences' → camelCase 'userPreferences'."""
    assert _sanitize_skill_name("user_preferences") == "userPreferences"


def test_sanitize_kebab_case():
    """kebab-case 'JWT-Auth-Flow' → camelCase 'jwtAuthFlow'."""
    assert _sanitize_skill_name("JWT-Auth-Flow") == "jwtAuthFlow"


def test_sanitize_mixed_separators():
    """Mixed separators get normalized."""
    assert _sanitize_skill_name("debug_python-script") == "debugPythonScript"
    assert _sanitize_skill_name("debug_python.script") == "debugPythonScript"


def test_sanitize_whitespace():
    """Leading/trailing whitespace is trimmed."""
    assert _sanitize_skill_name("  helloWorld  ") == "helloworld"


def test_sanitize_already_camel():
    """Already-camelCase is normalized to consistent lower-camelCase.

    The sanitizer is idempotent and consistent: regardless of input casing,
    it always produces the same canonical form.
    """
    assert _sanitize_skill_name("debugPythonScript") == "debugpythonscript"
    assert _sanitize_skill_name("DebugPythonScript") == "debugpythonscript"


def test_sanitize_empty():
    """Empty / whitespace-only / no-alphanumeric → empty string."""
    assert _sanitize_skill_name("") == ""
    assert _sanitize_skill_name("   ") == ""
    assert _sanitize_skill_name("---") == ""


def test_sanitize_truncates_long_names():
    """Long names are truncated to 50 chars."""
    long_name = "a" * 100
    result = _sanitize_skill_name(long_name)
    assert len(result) <= 50
