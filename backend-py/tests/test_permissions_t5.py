"""T5 — two-axis permissions: policy engine unit tests."""

from __future__ import annotations

import pytest
from app.services.workbench.permissions import (
    DEFAULT_AUTO_APPROVE,
    ApprovalPolicy,
    classify_command,
    decide,
    extract_external_paths,
    is_destructive,
    normalize_outcome,
    parse_prefix_rule,
    policy_from_dict,
    rule_matches,
    tokenize_command,
    unattended_denial,
)

WS = '/home/user/project'


# ---------------------------------------------------------------------------
# Tokenization + prefix rules
# ---------------------------------------------------------------------------


class TestTokenizeAndRules:
    def testTokenizeQuotes(self) -> None:
        assert tokenize_command('git commit -m "hello world"') == ['git', 'commit', '-m', 'hello world']

    def testTokenizeEmpty(self) -> None:
        assert tokenize_command('') == []
        assert tokenize_command('   ') == []

    def testParseRule(self) -> None:
        rule = parse_prefix_rule('git commit')
        assert rule is not None
        assert rule.tokens == ('git', 'commit')
        assert rule.arity == 2

    def testParseRuleEmpty(self) -> None:
        assert parse_prefix_rule('') is None
        assert parse_prefix_rule('   ') is None

    def testArityAwareMatch(self) -> None:
        rule = parse_prefix_rule('git commit')
        assert rule is not None
        # Extra args ok.
        assert rule_matches(rule, ['git', 'commit', '-m', 'x'])
        # Exact arity ok.
        assert rule_matches(rule, ['git', 'commit'])
        # Too few tokens — bare `git` must NOT match `git commit`.
        assert not rule_matches(rule, ['git'])
        # Different token.
        assert not rule_matches(rule, ['git', 'commits'])
        assert not rule_matches(rule, ['git', 'push'])

    def testCaseInsensitive(self) -> None:
        rule = parse_prefix_rule('Git Commit')
        assert rule is not None
        assert rule_matches(rule, ['git', 'commit', '-m', 'x'])
        assert rule_matches(rule, ['GIT', 'COMMIT'])


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


class TestClassification:
    def testReadCommands(self) -> None:
        assert 'read' in classify_command('ls -la', WS)
        assert 'read' in classify_command('cat foo.txt', WS)
        assert 'read' in classify_command('grep -rn TODO src/', WS)
        assert 'read' in classify_command('git status', WS)
        assert 'read' in classify_command('git diff HEAD', WS)

    def testBuildCommands(self) -> None:
        assert 'build' in classify_command('npm test', WS)
        assert 'build' in classify_command('cargo build', WS)
        assert 'build' in classify_command('python -m pytest -q', WS)
        assert 'build' in classify_command('uv run ruff check .', WS)

    def testChainedCommandNotRead(self) -> None:
        # `ls && rm -rf /` must not classify as read.
        cats = classify_command('ls && rm -rf /', WS)
        assert 'read' not in cats
        assert 'destructive' in cats

    def testRedirectedCommandNotRead(self) -> None:
        cats = classify_command('cat foo > /etc/passwd', WS)
        assert 'read' not in cats

    def testNetworkCommands(self) -> None:
        assert 'network' in classify_command('curl https://example.com', WS)
        assert 'network' in classify_command('git push origin main', WS)
        assert 'network' in classify_command('git clone https://x/y', WS)
        # Local git ops are not network.
        assert 'network' not in classify_command('git status', WS)

    def testDestructiveDetection(self) -> None:
        assert is_destructive('rm -rf /')
        assert is_destructive('rm -rf node_modules')
        assert is_destructive('rm -f important.txt')
        assert is_destructive('del /s /q C:\\temp')
        assert is_destructive('git push --force origin main')
        assert is_destructive('git reset --hard HEAD~5')
        assert is_destructive('git clean -fd')
        assert is_destructive('mkfs.ext4 /dev/sda1')
        assert is_destructive('dd if=/dev/zero of=/dev/sda')
        assert is_destructive('shutdown -h now')
        assert is_destructive(':(){ :|:& };:')
        assert is_destructive('chmod -R 777 /etc')

    def testNonDestructive(self) -> None:
        assert not is_destructive('rm single.txt')  # single file, no flags
        assert not is_destructive('git push origin main')
        assert not is_destructive('git reset --soft HEAD~1')
        assert not is_destructive('ls -la')
        assert not is_destructive('npm install')

    def testDestructiveInChain(self) -> None:
        cats = classify_command('echo hi && rm -rf /tmp/x', WS)
        assert 'destructive' in cats

    def testExternalPaths(self) -> None:
        assert extract_external_paths('cat /etc/passwd', WS) == ['/etc/passwd']
        assert extract_external_paths('ls ~/Documents', WS) == ['~/Documents']
        assert extract_external_paths('rm -rf /home/user/project/build', WS) == []
        assert extract_external_paths('cat src/main.py', WS) == []  # relative
        assert extract_external_paths('curl https://example.com/file.txt', WS) == []  # URL

    def testExternalCategory(self) -> None:
        assert 'external' in classify_command('cat /etc/passwd', WS)
        assert 'external' not in classify_command('cat src/main.py', WS)

    def testGeneralCommandNoCategories(self) -> None:
        assert classify_command('mycustomtool --do-thing', WS) == frozenset()


# ---------------------------------------------------------------------------
# Decision precedence
# ---------------------------------------------------------------------------


def _policy(**kw: object) -> ApprovalPolicy:
    base: dict[str, object] = {'enabled': True}
    base.update(kw)
    return policy_from_dict(base)


class TestDecide:
    def testAxisDisabledAllowsEverything(self) -> None:
        p = ApprovalPolicy(enabled=False)
        assert decide('rm -rf /', WS, p).action == 'allow'

    def testDenyRuleWins(self) -> None:
        p = _policy(denyRules=['git push --force'])
        d = decide('git push --force origin main', WS, p)
        assert d.action == 'deny'
        assert 'deny rule' in d.reason
        assert '[permission:denied]' in d.feedback
        assert 'Do not retry' in d.feedback

    def testDenyRuleBeatsAllowRule(self) -> None:
        p = _policy(denyRules=['git push'], allowRules=['git push'])
        assert decide('git push origin main', WS, p).action == 'deny'

    def testDestructiveAlwaysAsksEvenIfAutoApproved(self) -> None:
        p = _policy(autoApprove=['read', 'build', 'general', 'destructive'])
        d = decide('rm -rf node_modules', WS, p)
        assert d.action == 'ask'
        assert 'destructive' in d.reason

    def testDestructiveBeatsAllowRule(self) -> None:
        p = _policy(allowRules=['rm'])
        # rm -rf is destructive — the allow rule must not cover it.
        assert decide('rm -rf x', WS, p).action == 'ask'
        # Non-destructive rm under an allow rule is allowed.
        assert decide('rm single.txt', WS, p).action == 'allow'

    def testAllowRule(self) -> None:
        p = _policy(allowRules=['git commit'], autoApprove=[])
        assert decide('git commit -m "x"', WS, p).action == 'allow'
        assert decide('git push origin main', WS, p).action == 'ask'

    def testAutoApproveCategories(self) -> None:
        p = _policy(autoApprove=['read', 'build'])
        assert decide('ls -la', WS, p).action == 'allow'
        assert decide('npm test', WS, p).action == 'allow'
        assert decide('mycustomtool', WS, p).action == 'ask'  # general not approved

    def testGeneralAutoApprovedByDefault(self) -> None:
        p = _policy()  # default auto-approve includes general
        assert decide('mycustomtool --x', WS, p).action == 'allow'

    def testModelFlagForcesAsk(self) -> None:
        p = _policy(autoApprove=['read', 'build', 'general'])
        d = decide('mycustomtool --x', WS, p, requires_approval=True)
        assert d.action == 'ask'
        assert 'model flagged' in d.reason

    def testModelFlagCannotForceAllow(self) -> None:
        # requires_approval never overrides a deny rule.
        p = _policy(denyRules=['mycustomtool'])
        assert decide('mycustomtool', WS, p, requires_approval=True).action == 'deny'

    def testExternalAsks(self) -> None:
        p = _policy(autoApprove=['read', 'build', 'general'])
        d = decide('cat /etc/passwd', WS, p)
        assert d.action == 'ask'
        assert 'outside the workspace' in d.reason

    def testNetworkAsksByDefault(self) -> None:
        p = _policy()
        assert decide('curl https://example.com', WS, p).action == 'ask'

    def testNetworkAutoApprovable(self) -> None:
        p = _policy(autoApprove=['read', 'build', 'general', 'network'])
        assert decide('curl https://example.com', WS, p).action == 'allow'


# ---------------------------------------------------------------------------
# Outcome enum + headless
# ---------------------------------------------------------------------------


class TestOutcomeAndHeadless:
    def testClosedOutcomeEnum(self) -> None:
        assert normalize_outcome('allow') == 'allow_once'
        assert normalize_outcome('once') == 'allow_once'
        assert normalize_outcome('always') == 'allow_always'
        assert normalize_outcome('deny') == 'deny'
        assert normalize_outcome('no') == 'deny'
        # Unknown / missing / garbage → deny (fail-closed).
        assert normalize_outcome(None) == 'deny'
        assert normalize_outcome('') == 'deny'
        assert normalize_outcome('maybe') == 'deny'
        assert normalize_outcome('allow everything forever') == 'deny'

    def testUnattendedDenialHasFeedback(self) -> None:
        p = _policy()
        d = decide('rm -rf node_modules', WS, p)
        text = unattended_denial('rm -rf node_modules', d)
        assert '[permission:denied]' in text
        assert 'unattended' in text
        assert 'Do not retry' in text


# ---------------------------------------------------------------------------
# Policy serialization round-trip
# ---------------------------------------------------------------------------


class TestPolicyRoundTrip:
    def testRoundTrip(self) -> None:
        p = _policy(
            autoApprove=['read', 'network'],
            allowRules=['git commit', 'npm test'],
            denyRules=['rm -rf'],
            neverAsk=True,
        )
        d = p.to_dict()
        p2 = policy_from_dict(d)
        assert p2.enabled is True
        assert p2.auto_approve == frozenset({'read', 'network'})
        assert [r.tokens for r in p2.allow_rules] == [('git', 'commit'), ('npm', 'test')]
        assert [r.tokens for r in p2.deny_rules] == [('rm', '-rf')]
        assert p2.never_ask is True

    def testMalformedDictTolerated(self) -> None:
        p = policy_from_dict({'enabled': True, 'autoApprove': 'nonsense', 'allowRules': 42})
        assert p.enabled is True
        assert p.auto_approve == DEFAULT_AUTO_APPROVE  # falls back
        assert p.allow_rules == ()

    def testUnknownCategoriesDropped(self) -> None:
        p = policy_from_dict({'enabled': True, 'autoApprove': ['read', 'bogus']})
        assert p.auto_approve == frozenset({'read'})

    def testNoneDict(self) -> None:
        p = policy_from_dict(None)
        assert p.enabled is False


class TestDurablePolicyConfig:
    """get/set_approval_policy_config persist to config.json (data-dir scoped)."""

    def testDefaultIsDisabled(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        from app.services.workbench.workbench import get_approval_policy_config

        cfg = get_approval_policy_config()
        assert cfg['enabled'] is False

    def testSetGetRoundTrip(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        from app.services.workbench.workbench import (
            get_approval_policy_config,
            set_approval_policy_config,
        )

        result = set_approval_policy_config(
            {
                'enabled': True,
                'autoApprove': ['read', 'build'],
                'allowRules': ['git commit'],
                'denyRules': ['rm -rf', 'bogus rule   '],
                'neverAsk': True,
            }
        )
        assert result['ok'] is True
        stored = get_approval_policy_config()
        assert stored['enabled'] is True
        assert stored['autoApprove'] == ['build', 'read']  # normalized + sorted
        assert stored['allowRules'] == ['git commit']
        # Normalized: rules are trimmed; empty rules dropped.
        assert stored['denyRules'] == ['rm -rf', 'bogus rule']
        assert stored['neverAsk'] is True

    def testSetNormalizesGarbage(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
        from app.services.workbench.workbench import set_approval_policy_config

        result = set_approval_policy_config({'enabled': True, 'autoApprove': 'junk', 'allowRules': 5})
        assert result['ok'] is True
        policy = result['policy']
        assert policy['autoApprove'] == sorted(DEFAULT_AUTO_APPROVE)
        assert policy['allowRules'] == []

