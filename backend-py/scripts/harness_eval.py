"""Dev-only harness eval — the measurement the learning loop never had.

Two reference harnesses were deep-dived for this (DeepSeek-Bot `dev/`,
empero-org/abacus `eval --state both`) and the one idea worth taking is that the
question "does the learning loop help?" is *measured* rather than assumed: a
labelled case file, run through the real prompt and the real doors, scored and
printed. August removed its shipped harness evals by request (see AGENTS.md), so
this is a developer script: no endpoint, no UI, nothing the app loads.

Run it:

    cd backend-py
    uv run python -m scripts.harness_eval                # rails mode, no tokens
    uv run python -m scripts.harness_eval --only thin-rule,memory-junk
    uv run python -m scripts.harness_eval --out /tmp/eval.json
    uv run python -m scripts.harness_eval --judge --provider <name> --model <id> \
                                          --confirm-tokens      # real model calls
    uv run python -m scripts.harness_eval --overflow --context-window 4096

Modes
-----
`rails` (default) sends each case's labelled verdict payload through the doors
the judge's answer actually passes — `parse_verdicts` then `apply_verdict` — in
an isolated data directory, and checks BOTH the result label and the side effect
(a proposal filed, a fact written, nothing at all). It costs no tokens, so it
runs anywhere, and it measures the thing the loop cannot see about itself:
whether a thin lesson really becomes a memory instead of a padded skill, whether
task-state really is refused, whether a duplicate really is dropped.

`--judge` sends the real `build_judge_prompt(...)` for the same cases through
`call_judge` to a real model and scores the returned action against the label.
That costs tokens and needs a key, so it is opt-in twice over (`--judge` plus
`--confirm-tokens`). It answers the other question: does the judge, on today's
prompt, still reach the verdict we hand-wrote for it? A case that flips is a
prompt-contract change, not a test failure.

`--overflow` runs the REACTIVE overflow bench: the rescue that only fires when
a provider refuses a request for being too big, which is the least-measured
path in the loop. The window is SHRUNK (`--context-window`) instead of the
transcript being made enormous — the reference harness forces an overflow the
same way (`ds-bot/dev/bench.sh` shrinks `CONTEXT_WINDOW`). It measures the
detection (in the shapes gateways actually send) and the rescue (does the
surface shrink, does it report its split, and does it DECLINE when there is
nothing to gain) with the real functions. No tokens, no provider.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from typing import Any

# Bootstrap BEFORE any `app` import, so both documented forms work. This used to
# sit at the end of `main()`, after `_isolateData()` had already imported
# `app.config` — a no-op for `-m`, and a `ModuleNotFoundError` for a direct
# `python scripts/harness_eval.py`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── cases ────────────────────────────────────────────────────────────────────
# `expect` is a prediction made here, not read out of the code. Where the rails
# disagree with a prediction, that is the finding — do not "fix" the label
# without checking which of the two is wrong.

# The body of a real draft. `create_skill` verdicts send SECTIONS, not markdown:
# the renderer (`skill_service.renderSkillBody`) owns the headings, and the
# substance bar (`bodySubstance`) counts bullets inside the sections the judge
# actually authored — a section left out renders as a placeholder and counts as
# missing, which is the whole reason a one-sentence rule can no longer ship as a
# skill with every heading present.
SKILL_SECTIONS: dict[str, Any] = {
    'intro': 'A brain SQLite lock that only appears under parallel tests is a '
    'fixture race, not flake.',
    'when_to_use': ['- `pytest -n auto` fails with `database is locked`.',
                    '- The same test passes when run alone.'],
    'steps': ['Re-run the failing test file alone and confirm it passes.',
              'Check whether the fixture runs a PRAGMA that gets no busy handler.'],
    'pitfalls': ['Fixing it by dropping `-n auto`, which AGENTS.md forbids.'],
    'verification': ['The single-file run and the parallel run agree.'],
}

CASES: list[dict[str, Any]] = [
    {
        'id': 'nothing-to-learn',
        'note': 'A plain question that went fine must not create memory.',
        'judge': 'none',
        'events': [
            {'type': 'user', 'excerpt': 'What does `uv run pytest -n auto` actually do?'},
            {'type': 'assistant', 'excerpt': 'It runs the suite across one worker per core, '
             'so independent tests execute in parallel.'},
        ],
        'verdict': {'action': 'none', 'episode': 1, 'reason': 'no durable lesson'},
        'expect': {'label': 'none', 'proposals': 0, 'facts': 0},
    },
    {
        'id': 'memory-durable',
        'note': 'A real rule: passes the memory bar and writes with no human in the loop.',
        'judge': 'memory',
        'events': [
            {'type': 'user', 'excerpt': 'Build the FPGA image.'},
            {'type': 'tool', 'excerpt': 'run_command -> quartus: command not found'},
            {'type': 'assistant', 'excerpt': 'The toolchains are not on PATH globally, they ship '
             'under the bundled tools directory — the build has to call them by workspace-relative '
             'path. Fixed and it compiled.'},
        ],
        'verdict': {
            'action': 'memory',
            'episode': 2,
            'title': 'Quartus paths',
            'summary': 'Quartus toolchains live under the bundled tools directory, so a build '
            'must call them through the workspace-relative path rather than a global install.',
            'category': 'general',
        },
        'expect': {'label': 'memory-saved', 'proposals': 0, 'facts': 1},
    },
    {
        'id': 'memory-junk',
        'note': 'Task state: true while the turn ran, stale the moment it is written. '
        'Judge mode expects `none` here, not `memory` — the door drops a verdict that '
        'should never have been filed, and that asymmetry is the point.',
        'judge': 'none',
        'events': [
            {'type': 'user', 'excerpt': 'Migrate src/api to TypeScript, directory by directory.'},
            {'type': 'assistant', 'excerpt': 'I am now migrating src/api and have finished 7 files.'},
        ],
        'verdict': {
            'action': 'memory',
            'episode': 3,
            'summary': 'I am now migrating src/api to TypeScript and have finished 7 files.',
        },
        'expect': {'label': 'dropped-not-durable', 'proposals': 0, 'facts': 0},
    },
    {
        'id': 'memory-question',
        'note': 'A question is not a memory, however durable the topic.',
        'judge': 'none',
        'events': [
            {'type': 'user', 'excerpt': 'Does the desktop release have to ship backend changes '
             'even when only the UI was rebuilt?'},
            {'type': 'assistant', 'excerpt': 'Yes — installed builds re-copy bundled backend-py from '
             'the installer stamp, so a UI-only rebuild would not carry a backend fix.'},
        ],
        'verdict': {
            'action': 'memory',
            'episode': 4,
            'summary': 'Should the desktop release include backend changes with a UI-only rebuild?',
        },
        'expect': {'label': 'dropped-not-durable', 'proposals': 0, 'facts': 0},
    },
    {
        'id': 'memory-secret',
        'note': 'The credential door must refuse one verdict, not abort the batch: '
        'the raise used to escape `apply_verdict`, kill the remaining verdicts and '
        'stop the review cursor advancing.',
        'verdict': {
            'action': 'memory',
            'episode': 5,
            'summary': 'The staging Anthropic key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 '
            'and it works against the proxy base URL.',
        },
        'expect': {'label': 'rejected-write-door', 'proposals': 0, 'facts': 0},
    },
    {
        'id': 'thin-rule',
        'note': 'The substance bar: one sentence of advice is a lesson, not a skill. '
        'From the outside a downgrade is a memory write and no proposal. Judge mode '
        'legitimately expects `create_skill` here — drafting is the judge\'s job, and '
        'the bar that turns the draft into a lesson belongs to the door, which is '
        'exactly why the two modes cannot share one expectation.',
        'judge': 'create_skill',
        'events': [
            {'type': 'user', 'excerpt': 'The suite keeps failing on flaky tests.'},
            {'type': 'assistant', 'excerpt': 'Retry the test suite when it fails.'},
        ],
        'verdict': {
            'action': 'create_skill',
            'episode': 6,
            'name': 'always-retry-tests',
            'description': 'Retry the test suite when it fails.',
            'body_markdown': 'Retry the test suite when it fails.',
        },
        'expect': {'label': 'memory-saved', 'proposals': 0, 'facts': 1},
    },
    {
        'id': 'real-skill',
        'note': 'Authored sections file a proposal; a human still decides.',
        'judge': 'create_skill',
        'events': [
            {'type': 'user', 'excerpt': 'Why does the brain database lock only under -n auto?'},
            {'type': 'tool', 'excerpt': 'run_command -> pytest -q -n auto  (database is locked)'},
            {'type': 'tool', 'excerpt': 'run_command -> pytest -q tests/test_x.py  (passes)'},
            {'type': 'assistant', 'excerpt': 'It is a fixture race: the per-test SQLite swap runs a '
             'PRAGMA that SQLite gives no busy handler. Re-run alone to confirm, then check the pragma.'},
        ],
        'verdict': {
            'action': 'create_skill',
            'episode': 7,
            'name': 'diagnose-locked-sqlite',
            'description': 'Diagnose a brain SQLite lock that only appears under parallel tests.',
            **SKILL_SECTIONS,
        },
        'expect': {'label': 'proposal-filed', 'proposals': 1, 'facts': 0},
    },
    {
        'id': 'duplicate-skill',
        'note': 'The draft dedupe keys on the SOURCE EPISODE fingerprint, not on the '
        'skill name: re-judging the same episode files one proposal, not two. An '
        'installed skill of the same name is a different door (`_draftExists` vs the '
        'catalogue), so a fresh fingerprint on a known name is allowed through by design.',
        'repeat': 2,
        'verdict': {
            'action': 'create_skill',
            'episode': 8,
            'name': 'diagnose-locked-sqlite',
            'description': 'Diagnose a brain SQLite lock that only appears under parallel tests.',
            **SKILL_SECTIONS,
        },
        'expect': {'label': ['proposal-filed', 'duplicate-draft'], 'proposals': 1, 'facts': 0},
    },
    {
        'id': 'extract-only',
        'note': 'In extract-only mode no skill verdict may become a draft at all.',
        'verdict': {
            'action': 'create_skill',
            'episode': 9,
            'name': 'another-skill',
            'description': 'Anything at all.',
            **SKILL_SECTIONS,
        },
        'mode': 'extract-only',
        'expect': {'label': 'skipped-extract-only', 'proposals': 0, 'facts': 0},
    },
    {
        'id': 'amend-no-target',
        'note': 'An amend naming a skill that does not exist does not create one; it '
        'downgrades to a proposal a human reads, which is the door\'s documented route.',
        'verdict': {
            'action': 'amend_body',
            'episode': 10,
            'skill': 'no-such-skill-here',
            'patch_markdown': '## Pitfalls\n\n- A pitfall worth adding.\n',
        },
        'expect': {'label': 'downgraded-proposal', 'proposals': 1, 'facts': 0},
    },
    {
        'id': 'unknown-action',
        'note': 'A verdict the judge invented is dropped with its reason recorded.',
        'verdict': {'action': 'rewrite_everything', 'episode': 11},
        'expect': {'label': 'DROPPED', 'proposals': 0, 'facts': 0},
    },
    {
        'id': 'memory-no-summary',
        'note': 'A memory verdict without the payload dies at the schema, before the '
        'applier — the reason field is required and the applier never sees it.',
        'verdict': {'action': 'memory', 'episode': 12, 'title': 'Orphan'},
        'expect': {'label': 'DROPPED', 'proposals': 0, 'facts': 0},
    },
    {
        'id': 'duplicate-memory',
        'note': 'The same lesson twice is one lesson — dedupe lives behind the same door.',
        'repeat': 2,
        'verdict': {
            'action': 'memory',
            'episode': 13,
            'summary': 'Provider pricing must be read through cost_estimator, because a second '
            'rate table and the usage page would then disagree with each other.',
        },
        'expect': {'label': ['memory-saved', 'dropped-duplicate'], 'proposals': 0, 'facts': 1},
    },
]

# One episode window per case, in the shape `_episodeWindow` renders. Judge mode
# sends these; rails mode does not need them but shares the ids.
def _episode(case: dict[str, Any], n: int) -> dict[str, Any]:
    """The episode the judge actually reads.

    A placeholder excerpt cannot be judged: the model would be asked to distill
    'case thin-rule: the ask' and any verdict would be a guess about the fixture,
    not about a conversation. So a case that wants judge mode carries its own
    `events`, and `run_judge` refuses the ones that do not rather than scoring
    noise.
    """
    events = case.get('events')
    if not events:
        return {
            'id': n,
            'kind': 'episode',
            'outcome': 'success',
            'events': [
                {'type': 'user', 'excerpt': f"case {case['id']}: the ask, in the user's words"},
                {'type': 'tool', 'excerpt': 'run_command -> pytest -q -n auto'},
                {'type': 'assistant', 'excerpt': f'case {case["id"]}: what the turn concluded'},
            ],
        }
    return {'id': n, 'kind': 'episode', 'outcome': str(case.get('outcome', 'success')), 'events': events}


# ── the runner ───────────────────────────────────────────────────────────────


def _isolateData() -> str:
    """A throwaway data dir + brain, so the eval cannot touch a real install.

    The env var is set BEFORE `app.config` is imported, because
    `settings.dataDir` — which the proposal store and `skill_service._skillRoots`
    both read — is resolved from the environment at import. The explicit
    `settings.dataDir` assignment after `reload()` is the belt: a caller that
    imported the app first would otherwise file proposals into the developer's
    real inbox.
    """
    home = tempfile.mkdtemp(prefix='harness-eval-')
    os.environ['HARNESS_DATA_DIR'] = home
    os.environ['HARNESS_BRAIN_SQLITE_FILE'] = os.path.join(home, 'eval_brain.sqlite')
    os.environ.setdefault('GATEWAY_API_KEY', '')
    from pathlib import Path

    from app.config import settings

    settings.reload()
    settings.dataDir = Path(home)
    return home


def _counts() -> tuple[int, int]:
    from app.services.harness_self_improve import list_proposals
    from app.services.memory_store import list_facts

    return len(list_proposals()), len(list_facts())


def run_rails(only: set[str] | None) -> list[dict[str, Any]]:
    from app.services import memory_store
    from app.services.skill_distiller import apply_verdict, parse_verdicts

    memory_store.init()
    results: list[dict[str, Any]] = []
    for case in CASES:
        if only and case['id'] not in only:
            continue
        verdict = dict(case['verdict'])
        fingerprint = f'eval:{case["id"]}'
        mode = str(case.get('mode', 'propose'))
        expected = dict(case['expect'])
        wantLabels = expected['label']
        if isinstance(wantLabels, str):
            wantLabels = [wantLabels]
        gotLabels: list[str] = []
        error = ''
        applicable: list[dict[str, Any]] = []
        beforeProposals, beforeFacts = _counts()
        for _ in range(int(case.get('repeat', 1))):
            # The real doors: parse first (so an invented action dies there),
            # then apply, in `mode` — exactly the sequence a distiller pass runs.
            batch, dropped = parse_verdicts({'verdicts': [dict(verdict)]})
            applicable += batch
            if not batch:
                gotLabels.append('DROPPED' if not dropped else f"DROPPED:{dropped[0].get('why')}")
                continue
            try:
                gotLabels.append(str(apply_verdict(batch[0], fingerprint, mode=mode)))
            except Exception as exc:  # noqa: BLE001 — the eval reports, never raises
                error = f'{type(exc).__name__}: {exc}'[:200]
                gotLabels.append('ERROR')
        afterProposals, afterFacts = _counts()
        proposals = afterProposals - beforeProposals
        facts = afterFacts - beforeFacts
        # Compared positionally: a `repeat` case labels each turn it runs, so
        # "the first write saves, the second is a duplicate" is one expectation,
        # not two alternatives. A `DROPPED:reason` satisfies a bare `DROPPED`.
        ok = (
            not error
            and len(gotLabels) == len(wantLabels)
            and all(g == w or g.startswith(f'{w}:') for g, w in zip(gotLabels, wantLabels))
            and proposals == expected['proposals']
            and facts == expected['facts']
        )
        results.append(
            {
                'id': case['id'],
                'note': case['note'],
                'mode': mode,
                'expected': wantLabels,
                'got': gotLabels,
                'proposals': proposals,
                'facts': facts,
                'expectedProposals': expected['proposals'],
                'expectedFacts': expected['facts'],
                'error': error,
                'pass': bool(ok),
            }
        )
    return results


def run_judge(only: set[str] | None, model: str, provider: str) -> list[dict[str, Any]]:
    """Send the real judge prompt for each case to a real model and score it.

    `resolve_judge` is pointed at the CLI's model rather than at an invented
    environment variable: the whole point of this mode is that the prompt, the
    client and the parser are the ones the loop uses, so the only thing the eval
    may swap is which model answers.
    """
    import asyncio

    from app.services import skill_distiller as sd

    def _resolve() -> tuple[str, str]:
        # Same shape as `resolve_judge`: an empty provider is the "no hint"
        # value `_resolveProvider` already handles, not a None.
        return model, provider

    sd.resolve_judge = _resolve
    results: list[dict[str, Any]] = []
    for case in CASES:
        if only and case['id'] not in only:
            continue
        verdict = case['verdict']
        want = str(case.get('judge') or '')
        if not want:
            # A case whose subject is a door or a mode has no judge-side answer to
            # predict. Scoring it anyway would produce a number about the fixture.
            results.append(
                {
                    'id': case['id'],
                    'note': case['note'],
                    'expected': ['(not judgeable)'],
                    'got': ['skipped'],
                    'proposals': 0,
                    'facts': 0,
                    'expectedProposals': 0,
                    'expectedFacts': 0,
                    'error': '',
                    'pass': True,
                    'skipped': True,
                }
            )
            continue
        prompt = sd.build_judge_prompt([_episode(case, int(verdict.get('episode', 1) or 1))])
        payload = asyncio.run(sd.call_judge(prompt))
        chosen = ''
        if payload:
            applicable, _dropped = sd.parse_verdicts(payload)
            if applicable:
                chosen = str(applicable[0].get('action', 'none') or 'none').lower()
        results.append(
            {
                'id': case['id'],
                'note': str(payload.get('_note', '')) if payload else 'judge returned nothing',
                'expected': [want],
                'got': [chosen or 'no-answer'],
                'proposals': 0,
                'facts': 0,
                'expectedProposals': 0,
                'expectedFacts': 0,
                'error': '',
                'pass': chosen == want,
            }
        )
    return results


def _overflow_transcript(rounds: int = 16) -> list[dict[str, object]]:
    """A transcript long enough to overflow a SHRUNK window.

    The reference harness forces an overflow by shrinking `CONTEXT_WINDOW`
    (`ds-bot/dev/bench.sh`) rather than by writing a huge transcript: a
    transcript long enough to overflow a real 200k window is not a fixture
    anybody can read, and the point is to make the RESCUE run, not to make
    the prompt big.
    """
    filler = ' the weather in Berlin is unsettled and the forecast keeps changing. ' * 14
    out: list[dict[str, object]] = []
    for i in range(rounds):
        out.append({'role': 'user', 'content': f'question {i} about the weather in Berlin{filler}'})
        out.append(
            {'role': 'assistant', 'content': f'answer {i}: it is raining in Berlin{filler}'}
        )
    return out


def run_overflow_bench(contextWindow: int) -> list[dict[str, Any]]:
    """Measure the REACTIVE overflow rescue — the least-measured one.

    Three rescue paths exist (pre-turn auto-compact, the budget ladder's
    middle rung, and this one) and this is the one with no measurement at
    all: it only runs when a provider REFUSES a request for being too big,
    which needs a provider that says no. So the bench measures the two
    halves separately, with the real functions:

    * the DETECTION — does the loop recognize an overflow (in the shapes
      gateways actually send) and NOT confuse it with a shape refusal?
      The two ladders must not both fire: a shape repair flattens the tool
      pairing, an overflow rescue compacts, and running both on one error
      is the confusion this bench exists to catch.
    * the RESCUE — does `_reactiveContextReduction` actually shrink the
      surface under a shrunken window, and does it DECLINE when there is
      nothing to gain? A rescue that always reports a win is a rescue that
      buys nothing, and the loop's own gate (`_reductionIsWorthwhile`)
      exists precisely to stop that.
    """
    from app.providers.clients.base import estimateTokens
    from app.services.workbench.loop.recovery import (
        _isContextOverflowError,
        _isShapeRefusal,
        _reactiveContextReduction,
    )
    from app.services.workbench.sessions import create_workbench_session

    results: list[dict[str, Any]] = []

    def _case(
        caseId: str,
        note: str,
        ok: bool,
        got: str,
        expected: str = 'ok',
        error: str = '',
    ) -> None:
        results.append(
            {
                'id': caseId,
                'note': note,
                'expected': [expected],
                'got': [got],
                'proposals': 0,
                'facts': 0,
                'expectedProposals': 0,
                'expectedFacts': 0,
                'error': error,
                'pass': bool(ok),
            }
        )

    # ── detection ────────────────────────────────────────────────────────
    # The shapes a gateway actually sends. A flat `error` string is the
    # minority; most nest the message, and a probe that only reads the flat
    # field misses every one of them.
    overflowShapes: list[tuple[str, object]] = [
        ('flat', {'error': 'context length exceeded'}),
        ('nested', {'error': {'message': "This model's maximum context length is 8192 tokens"}}),
        ('code-only', {'code': 'context_length_exceeded'}),
        ('double-wrapped', {'error': {'error': {'message': 'prompt is too long'}}}),
        ('list', {'error': [{'message': 'maximum context length is 4096 tokens'}]}),
    ]
    for shapeName, payload in overflowShapes:
        try:
            detected = _isContextOverflowError(payload)
        except Exception as exc:  # noqa: BLE001 — the bench reports, never raises
            _case(
                f'overflow-detected-{shapeName}',
                'the overflow probe must not raise',
                False,
                f'{type(exc).__name__}: {exc}'[:200],
                expected='detected',
                error=f'{type(exc).__name__}: {exc}'[:200],
            )
            continue
        _case(
            f'overflow-detected-{shapeName}',
            f'an overflow in the {shapeName} shape must be recognized',
            detected,
            'detected' if detected else 'not detected',
            expected='detected',
        )
    try:
        shapeRefusal = _isShapeRefusal({'error': {'message': 'context length exceeded'}})
    except Exception as exc:  # noqa: BLE001
        shapeRefusal = True
        _case('overflow-not-a-shape-refusal', 'the shape probe must not raise', False, str(exc)[:120])
    else:
        _case(
            'overflow-not-a-shape-refusal',
            'an overflow is not a shape refusal — the two ladders must not both fire',
            not shapeRefusal,
            'shape refusal' if shapeRefusal else 'overflow only',
            expected='overflow only',
        )

    # ── the rescue ───────────────────────────────────────────────────────
    session = create_workbench_session(
        provider='local', agentId='', guardMode='full', goal='overflow bench'
    )
    messages = _overflow_transcript()
    before = estimateTokens(messages)
    split: dict[str, object] = {}
    reduced = None
    try:
        import asyncio

        reduced = asyncio.run(
            _reactiveContextReduction(messages, contextWindow, session, statsOut=split)
        )
    except Exception as exc:  # noqa: BLE001
        _case(
            'overflow-rescue-shrinks',
            'the rescue must not raise',
            False,
            f'{type(exc).__name__}: {exc}'[:200],
            error=f'{type(exc).__name__}: {exc}'[:200],
        )
        reduced = None
    if reduced is not None:
        after = estimateTokens(reduced)
        _case(
            'overflow-rescue-shrinks',
            f'with the window shrunk to {contextWindow} tokens the rescue must shrink '
            'the surface',
            after < before,
            f'{before}->{after} tokens',
            expected='smaller',
        )
        _case(
            'overflow-rescue-reports-its-split',
            'the rescue reports the split it used, so the card can name it',
            bool(split.get('head') is not None and split.get('tail') is not None),
            f"head={split.get('head')} tail={split.get('tail')}",
            expected='split reported',
        )
    else:
        _case(
            'overflow-rescue-shrinks',
            f'with the window shrunk to {contextWindow} tokens the rescue must shrink '
            'the surface',
            False,
            'no reduction',
            expected='smaller',
        )
    # The negative case: a window the transcript already fits buys nothing, and
    # the rescue must SAY so rather than report a win.
    bigWindow = max(contextWindow * 8, before * 4)
    split2: dict[str, object] = {}
    try:
        import asyncio

        declined = asyncio.run(
            _reactiveContextReduction(messages, bigWindow, session, statsOut=split2)
        )
    except Exception as exc:  # noqa: BLE001
        declined = None
        _case('overflow-rescue-declines', 'the rescue must not raise', False, str(exc)[:120])
    else:
        _case(
            'overflow-rescue-declines',
            'a window the transcript already fits must buy no reduction, and the '
            'rescue must decline rather than report a win',
            declined is None,
            'declined' if declined is None else 'reduced anyway',
            expected='declined',
        )
    return results


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='harness_eval', description=__doc__.splitlines()[0])
    ap.add_argument('--judge', action='store_true', help='ask a real model instead of the rails')
    ap.add_argument('--provider', default='', help='provider name for --judge')
    ap.add_argument('--model', default='', help='model id for --judge')
    ap.add_argument('--confirm-tokens', action='store_true', help='required with --judge')
    ap.add_argument('--only', default='', help='comma-separated case ids')
    ap.add_argument('--out', default='', help='write the full result JSON here')
    ap.add_argument(
        '--overflow',
        action='store_true',
        help='run the reactive-overflow bench instead of the rails',
    )
    ap.add_argument(
        '--context-window',
        type=int,
        default=4096,
        help='the shrunken context window the overflow bench forces (default 4096)',
    )
    args = ap.parse_args(argv)

    only = {s.strip() for s in args.only.split(',') if s.strip()}
    unknown = only - {str(c['id']) for c in CASES}
    if unknown:
        # A typo in `--only` selected nothing, and an empty selection used to
        # print "0/0 cases behaved as labelled" and exit 0 — a green run that
        # measured nothing is worse than a red one.
        print(f'no such case id(s): {", ".join(sorted(unknown))}', file=sys.stderr)
        print('known: ' + ', '.join(str(c['id']) for c in CASES), file=sys.stderr)
        return 2

    if args.judge:
        if not args.confirm_tokens:
            print('--judge costs real tokens; re-run with --confirm-tokens', file=sys.stderr)
            return 2
        if not args.model:
            print('--judge needs --model <id> (and usually --provider <name>)', file=sys.stderr)
            return 2
        # Judge mode writes NOTHING: it reads the provider store to resolve a
        # client, asks one question, and scores the answer. Isolating the data
        # dir would hide the providers it needs and make every case come back
        # 'no-answer' — a green-looking harness that had never reached a model.
        results = run_judge(only, args.model, args.provider)
    else:
        home = _isolateData()
        try:
            if args.overflow:
                # The overflow bench needs the store (it holds the session the
                # rescue runs against), and it must not touch a real install.
                from app.services import memory_store

                memory_store.init()
                results = run_overflow_bench(max(1, int(args.context_window or 4096)))
            else:
                results = run_rails(only)
        finally:
            # Close the store first: on Windows an open SQLite handle makes
            # `rmtree` fail, and it fails SILENTLY under `ignore_errors=True`, so
            # every run used to leave a throwaway data dir (with its brain DB) in
            # %TEMP% — 21 of them measured before this line existed. If a handle
            # still wins the race, say where the residue is instead of pretending.
            try:
                from app.services.memory_store import close as _closeStore

                _closeStore()
            except Exception:
                pass
            shutil.rmtree(home, ignore_errors=True)
            if os.path.exists(home):
                print(f'left behind (open handle): {home}', file=sys.stderr)

    executed = [r for r in results if not r.get('skipped')]
    if not executed:
        print('no case executed, so nothing was measured', file=sys.stderr)
        return 2
    passed = sum(1 for r in executed if r['pass'])
    width = max(len(str(r['id'])) for r in results)
    for r in results:
        flag = 'SKIP' if r.get('skipped') else ('PASS' if r['pass'] else 'FAIL')
        print(
            f'{flag}  {str(r["id"]).ljust(width)}  expected={",".join(r["expected"]):<24} '
            f'got={",".join(r["got"])}'
            + (f'  ({r["proposals"]} proposals, {r["facts"]} facts)' if not r['pass'] and not r.get('skipped') else '')
            + (f'  error={r["error"]}' if r.get('error') else '')
        )
    skippedNote = f'  ({len(results) - len(executed)} skipped as not judgeable)' if len(results) != len(executed) else ''
    print(f'\n{passed}/{len(executed)} cases behaved as labelled{skippedNote}')
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            json.dump({'passed': passed, 'total': len(executed), 'cases': results}, fh, indent=2)
        print(f'wrote {args.out}')
    return 0 if passed == len(executed) else 1


if __name__ == '__main__':
    raise SystemExit(main())
