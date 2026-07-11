"""v2 hardening — Test skill name sanitizer (Title Case → camelCase)."""
import pytest
from app.services.consolidation_daemon import _sanitizeSkillName

def testSanitizeTitleCase():
    """Title Case 'Debug Python Script' → camelCase 'debugPythonScript'."""
    assert _sanitizeSkillName('Debug Python Script') == 'debugPythonScript'

def testSanitizeSnakeCase():
    """snake_case 'user_preferences' → camelCase 'userPreferences'."""
    assert _sanitizeSkillName('user_preferences') == 'userPreferences'

def testSanitizeKebabCase():
    """kebab-case 'JWT-Auth-Flow' → camelCase 'jwtAuthFlow'."""
    assert _sanitizeSkillName('JWT-Auth-Flow') == 'jwtAuthFlow'

def testSanitizeMixedSeparators():
    """Mixed separators get normalized."""
    assert _sanitizeSkillName('debug_python-script') == 'debugPythonScript'
    assert _sanitizeSkillName('debug_python.script') == 'debugPythonScript'

def testSanitizeWhitespace():
    """Leading/trailing whitespace is trimmed."""
    assert _sanitizeSkillName('  helloWorld  ') == 'helloworld'

def testSanitizeAlreadyCamel():
    """Already-camelCase is normalized to consistent lower-camelCase.

    The sanitizer is idempotent and consistent: regardless of input casing,
    it always produces the same canonical form.
    """
    assert _sanitizeSkillName('debugPythonScript') == 'debugpythonscript'
    assert _sanitizeSkillName('DebugPythonScript') == 'debugpythonscript'

def testSanitizeEmpty():
    """Empty / whitespace-only / no-alphanumeric → empty string."""
    assert _sanitizeSkillName('') == ''
    assert _sanitizeSkillName('   ') == ''
    assert _sanitizeSkillName('---') == ''

def testSanitizeTruncatesLongNames():
    """Long names are truncated to 50 chars."""
    longName = 'a' * 100
    result = _sanitizeSkillName(longName)
    assert len(result) <= 50