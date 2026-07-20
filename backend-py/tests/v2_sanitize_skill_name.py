"""Skill name sanitizer — kebab-case matching skill_service validation."""

from app.services.consolidation_daemon import _sanitizeSkillName


def testSanitizeTitleCase():
    assert _sanitizeSkillName('Debug Python Script') == 'debug-python-script'


def testSanitizeSnakeCase():
    assert _sanitizeSkillName('user_preferences') == 'user-preferences'


def testSanitizeKebabCase():
    assert _sanitizeSkillName('JWT-Auth-Flow') == 'jwt-auth-flow'


def testSanitizeMixedSeparators():
    assert _sanitizeSkillName('debug_python-script') == 'debug-python-script'
    assert _sanitizeSkillName('debug_python.script') == 'debug-python-script'


def testSanitizeWhitespace():
    assert _sanitizeSkillName('  helloWorld  ') == 'hello-world'


def testSanitizeCamelCase():
    assert _sanitizeSkillName('debugPythonScript') == 'debug-python-script'
    assert _sanitizeSkillName('DebugPythonScript') == 'debug-python-script'


def testSanitizeEmpty():
    assert _sanitizeSkillName('') == ''
    assert _sanitizeSkillName('   ') == ''
    assert _sanitizeSkillName('---') == ''


def testSanitizeTruncatesLongNames():
    longName = 'a' * 100
    result = _sanitizeSkillName(longName)
    assert len(result) <= 50
