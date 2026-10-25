"""Goal environments — the pure rules.

The owner's goal: *the harness is the environment the agent works inside, and the agent may edit it
mid-task*. This module holds the part of that which must never be negotiable, with no I/O so the rules
can be exercised against a temp database (this repo has no unit suite since 2026-10-17):

  * a bound may only ever NARROW — a child cannot gain a tool its parent lacks, drop a refusal, or
    raise a ceiling. A widening request is clamped and the clamp is returned so a receipt can name it;
  * ``done`` needs its named outputs; ``abandoned`` needs nothing, because a gate that blocks stopping
    work is how a run spins;
  * a mark needs a verdict AND an evidence reference that still names a row when it is read back.

The store (``store.py``) and the tools (``tool_registrations/goal_tools.py``) are thin over these, so
the rules have exactly one owner.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

ROOT_ID = 'goal:root'
MAX_DEPTH = 3
MAX_OUTPUTS = 6
MAX_LEDGER = 40
ENV_STATUSES = ('active', 'done', 'abandoned')
RUN_STATUSES = ('running', 'parked', 'woken', 'done', 'failed')
RUN_MOVES: dict[str, tuple[str, ...]] = {
    'running': ('parked', 'done', 'failed'),
    'parked': ('woken', 'running', 'failed'),
    'woken': ('running', 'parked', 'failed'),
    'done': (),
    'failed': (),
}
VERDICTS = ('confirmed', 'refuted', 'partial')

#: Proxy settings are not goal state. The analogue of a trader's risk rails: named here so the write
#: door and the docs refuse the same list instead of each inventing one.
SYSTEM_KEYS = (
    'workbenchToolRounds', 'budgetSoftUsd', 'budgetSoftTokens', 'budgetWallClockSec',
    'memoryEnabled', 'modelMemoryRead', 'memoryAutoInject', 'skillEnforcement',
)


class GoalRefusal(Exception):
    """A rule said no. ``reasons`` is one line per rule, never a bare "denied"."""

    def __init__(self, reasons: Iterable[str]) -> None:
        self.reasons = [r for r in reasons if r]
        super().__init__(' · '.join(self.reasons) or 'refused')


def _slug(text: str, limit: int = 32) -> str:
    s = re.sub(r'[^a-zA-Z0-9]+', '-', text or '').strip('-').lower()
    return s[:limit] or 'goal'


def new_id(prefix: str, seed: str) -> str:
    """``(prefix, seed, time)`` is not unique — two rows made in the same millisecond collide on
    Windows' coarse clock — so the random tail is what makes an id an id."""
    return f'{prefix}:{_slug(seed)}-{uuid.uuid4().hex[:8]}'


def _as_list(value: object, cap: int, what: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        raw = [p.strip() for p in re.split(r'[,;\n]', value)]
    elif isinstance(value, (list, tuple)):
        raw = [str(v).strip() for v in value]
    else:
        raise GoalRefusal([f'{what} must be a list of lines'])
    out: list[str] = []
    for item in raw:
        if not item or item in out:
            continue
        if len(item) > 200:
            raise GoalRefusal([f'{what} line is over 200 chars: {item[:40]}…'])
        out.append(item)
    if len(out) > cap:
        raise GoalRefusal([f'{what} has {len(out)} lines; {cap} is the cap'])
    return out


@dataclass(frozen=True)
class Bound:
    """The part that may only shrink."""
    allow: tuple[str, ...]
    deny: tuple[str, ...]
    max_rounds: int
    context_chars: int

    def to_json(self) -> str:
        return json.dumps({
            'allow': list(self.allow), 'deny': list(self.deny),
            'maxRounds': self.max_rounds, 'contextChars': self.context_chars,
        })

    @classmethod
    def from_json(cls, raw: object) -> 'Bound':
        if not isinstance(raw, str) or not raw.strip():
            return cls((), (), 0, 0)
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return cls((), (), 0, 0)
        if not isinstance(data, dict):
            return cls((), (), 0, 0)
        return cls(
            tuple(str(x) for x in data.get('allow') or ()),
            tuple(str(x) for x in data.get('deny') or ()),
            int(data.get('maxRounds') or 0),
            int(data.get('contextChars') or 0),
        )


def _names(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [p.strip() for p in re.split(r'[,;\s]+', value) if p.strip()]
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v).strip()]
    raise GoalRefusal(['a bound list must be names'])


def assert_narrower(parent: Bound, child: Bound) -> list[str]:
    """The four ways a bound may differ, all in the narrowing direction. Empty list means it holds."""
    reasons: list[str] = []
    gained = [n for n in child.allow if n not in parent.allow]
    if gained:
        reasons.append(f"allow adds {', '.join(gained)} — not in the parent's allow list")
    dropped = [n for n in parent.deny if n not in child.deny]
    if dropped:
        reasons.append(f"deny drops {', '.join(dropped)} — the parent refuses these")
    if child.max_rounds > parent.max_rounds:
        reasons.append(f'max_rounds {child.max_rounds} exceeds the parent {parent.max_rounds}')
    if child.context_chars > parent.context_chars:
        reasons.append(f'context_chars {child.context_chars} exceeds the parent {parent.context_chars}')
    return reasons


def _as_int(value: object, field_name: str) -> int:
    """A number or a numeric string; anything else is refused with the field's name. Written out
    rather than `int(value)` so the refusal is a rule, not a traceback."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise GoalRefusal([f'{field_name} must be a number, got {value!r}'])
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise GoalRefusal([f'{field_name} must be a number, got {value!r}']) from exc


def clamp_bound(parent: Bound, want: Mapping[str, object] | None) -> tuple[Bound, list[str]]:
    """Honour every part of the request that is inside the ceiling, and SAY what was removed.

    A silent clamp is a lie about what got created: the agent asked for a tool it does not have and
    would only find out by trying it.
    """
    want = want or {}
    locked = [k for k in want if k in SYSTEM_KEYS]
    if locked:
        raise GoalRefusal([
            f'{", ".join(locked)} is proxy settings, not part of a goal bound — the agent does not edit '
            'the app settings from inside a goal',
        ])
    unknown = [k for k in want if k not in ('allow', 'deny', 'maxRounds', 'max_rounds', 'contextChars', 'context_chars')]
    if unknown:
        raise GoalRefusal([
            f'{", ".join(unknown)} is not a bound field — the bound has exactly allow, deny, maxRounds, contextChars',
        ])
    removed: list[str] = []
    allow: list[str] = []
    for name in _names(want.get('allow')) or list(parent.allow):
        if name in parent.allow:
            allow.append(name)
        else:
            removed.append(f"{name} (not in the parent's allow list)")
    deny = list(parent.deny)
    for name in _names(want.get('deny')):
        if name not in deny:
            deny.append(name)
    want_rounds = want.get('maxRounds', want.get('max_rounds'))
    max_rounds = parent.max_rounds
    if want_rounds is not None:
        asked = _as_int(want_rounds, 'maxRounds')
        max_rounds = max(1, min(asked, parent.max_rounds))
        if asked > parent.max_rounds:
            removed.append(f'maxRounds {asked} → {max_rounds} (the parent ceiling)')
    want_chars = want.get('contextChars', want.get('context_chars'))
    context_chars = parent.context_chars
    if want_chars is not None:
        asked_chars = _as_int(want_chars, 'contextChars')
        context_chars = max(200, min(asked_chars, parent.context_chars))
        if asked_chars > parent.context_chars:
            removed.append(f'contextChars {asked_chars} → {context_chars} (the parent ceiling)')
    return Bound(tuple(allow), tuple(deny), max_rounds, context_chars), removed


@dataclass
class Env:
    id: str
    parent_id: str | None
    title: str
    goal: str
    inputs: list[str]
    outputs: list[str]
    bound: Bound
    status: str
    owner: str
    version: int
    depth: int
    created_at: float
    updated_at: float
    close_reason: str = ''

    @property
    def writable(self) -> bool:
        """The root is the proxy's own environment: read-only to a model, always."""
        return self.id != ROOT_ID and self.owner == 'agent'


def root_bound(seat_tools: Iterable[str], context_chars: int = 1400, max_rounds: int = 150) -> Bound:
    """What the root starts as: the seat's real surface, no refusals, and the app's own ceilings."""
    return Bound(tuple(dict.fromkeys(seat_tools)), (), max_rounds, context_chars)


def seed_root(seat_tools: Iterable[str], now: float) -> Env:
    return Env(
        id=ROOT_ID, parent_id=None,
        title='The app',
        goal='Work the user\u2019s own session: the app settings are the ceiling, and every goal under this one may only narrow them.',
        inputs=[], outputs=[], bound=root_bound(seat_tools), status='active', owner='system',
        version=1, depth=0, created_at=now, updated_at=now,
    )


def create_env(
    envs: Iterable[Env], *, parent_id: str, title: str, goal: str,
    inputs: object = None, outputs: object = None, bound: Mapping[str, object] | None = None,
    now: float,
) -> tuple[Env, list[str]]:
    """A sub-goal under ``parent_id``, clamped to the parent. Returns the env and what the clamp removed."""
    parent = next((e for e in envs if e.id == parent_id), None)
    if parent is None:
        raise GoalRefusal([f'no goal "{parent_id}" to work under — read the goals first, then create under the active one'])
    if parent.status != 'active':
        raise GoalRefusal([f'"{parent.title}" is {parent.status}; a sub-goal under it could never be woken'])
    if parent.depth >= MAX_DEPTH:
        raise GoalRefusal([f'depth {parent.depth} is the deepest a goal may nest ({MAX_DEPTH})'])
    title = (title or '').strip()
    goal = (goal or '').strip()
    if not 3 <= len(title) <= 80:
        raise GoalRefusal(['title must be 3-80 characters'])
    if not 10 <= len(goal) <= 600:
        raise GoalRefusal(['goal must be 10-600 characters — say what the work is FOR'])
    clamped, removed = clamp_bound(parent.bound, bound)
    env = Env(
        id=new_id('goal', title), parent_id=parent.id, title=title, goal=goal,
        inputs=_as_list(inputs, MAX_OUTPUTS, 'inputs'),
        outputs=_as_list(outputs, MAX_OUTPUTS, 'outputs'),
        bound=clamped, status='active', owner='agent', version=1,
        depth=parent.depth + 1, created_at=now, updated_at=now,
    )
    bad = assert_narrower(parent.bound, env.bound)
    if bad:
        raise GoalRefusal([f'clamp produced a bound the narrowing rule refuses: {r}' for r in bad])
    return env, removed


def unmet_outputs(env: Env, artifacts: Iterable[Mapping[str, object]], close_reason: str = '') -> list[str]:
    """Outputs with nothing behind them. Matched on the artifact's own words: the whole line, or one
    distinctive word of it. A close reason that names the output counts — the agent may explain itself,
    it may not be unexplained."""
    reason = (close_reason or '').lower()
    stop = {'with', 'that', 'this', 'from', 'into', 'upon', 'their', 'there', 'these', 'those', 'have',
            'been', 'being', 'must', 'shall', 'should', 'would', 'could', 'about', 'which', 'while',
            'when', 'then', 'than', 'over', 'under', 'again', 'once', 'some', 'such'}
    mine = [a for a in artifacts if str(a.get('env_id') or '') == env.id]
    missing: list[str] = []
    for out in env.outputs:
        needle = out.lower()
        if needle in reason:
            continue
        words = [w for w in re.split(r'[^0-9A-Za-z]+', needle) if len(w) >= 4 and w not in stop]
        hit = any(
            needle in f"{a.get('summary') or ''} {_ref_key(a.get('ref'))}".lower()
            or any(w in f"{a.get('summary') or ''} {_ref_key(a.get('ref'))}".lower() for w in words)
            for a in mine
        )
        if not hit:
            missing.append(out)
    return missing


def edit_env(
    env: Env, patch: Mapping[str, object], *, unmet: Iterable[str] = (), expected_version: int | None = None,
    now: float,
) -> tuple[Env, list[str]]:
    """Rewrite the fields of a goal the agent owns. Raises ``GoalRefusal`` with the reason per field."""
    if not env.writable:
        raise GoalRefusal([f'"{env.title}" is the app\u2019s own environment — its bound is the ceiling every goal narrows from and the agent does not edit it'])
    if expected_version is not None and expected_version != env.version:
        raise GoalRefusal([f'"{env.title}" is at version {env.version}, your copy is {expected_version} — read it again, merge, and retry in this turn'])
    editable = {'title', 'goal', 'inputs', 'outputs', 'bound', 'status'}
    stray = [k for k in patch if k not in editable]
    if stray:
        raise GoalRefusal([f'{", ".join(stray)} is not editable on a goal (only {", ".join(sorted(editable))})'])
    locked = [k for k in patch if k in SYSTEM_KEYS]
    if locked:
        raise GoalRefusal([f'{", ".join(locked)} is proxy settings, not goal state'])
    reasons: list[str] = []
    clamped: list[str] = []
    next_env = Env(**{**env.__dict__})
    if 'title' in patch:
        t = str(patch['title'] or '').strip()
        if not 3 <= len(t) <= 80:
            reasons.append('title must be 3-80 characters')
        else:
            next_env.title = t
    if 'goal' in patch:
        g = str(patch['goal'] or '').strip()
        if not 10 <= len(g) <= 600:
            reasons.append('goal must be 10-600 characters')
        else:
            next_env.goal = g
    if 'inputs' in patch:
        try:
            next_env.inputs = _as_list(patch['inputs'], MAX_OUTPUTS, 'inputs')
        except GoalRefusal as exc:
            reasons.extend(exc.reasons)
    if 'outputs' in patch:
        try:
            next_env.outputs = _as_list(patch['outputs'], MAX_OUTPUTS, 'outputs')
        except GoalRefusal as exc:
            reasons.extend(exc.reasons)
    if 'bound' in patch:
        want = patch['bound']
        if not isinstance(want, dict):
            reasons.append('bound must be an object')
        else:
            try:
                next_env.bound, clamped = clamp_bound(env.bound, want)
            except GoalRefusal as exc:
                reasons.extend(exc.reasons)
    if 'status' in patch:
        status = str(patch['status'] or '')
        if status not in ENV_STATUSES:
            reasons.append(f'"{status}" is not a goal status')
        elif env.status != 'active':
            reasons.append(f'"{env.title}" is already {env.status}')
        elif status == 'done' and list(unmet):
            reasons.append('cannot close as done: no output or close reason names '
                           + '; '.join(unmet) + ' — file the output, or close it abandoned')
        else:
            next_env.status = status
    if reasons:
        raise GoalRefusal(reasons)
    next_env.version = env.version + 1
    next_env.updated_at = now
    return next_env, clamped


@dataclass
class Run:
    id: str
    env_id: str
    status: str
    round: int
    model: str = ''
    session_id: str = ''
    bot_id: str = ''
    reason: str = ''
    started_at: float = 0.0
    updated_at: float = 0.0


def open_run(env_id: str, now: float, *, session_id: str = '', model: str = '', bot_id: str = '') -> Run:
    return Run(id=new_id('run', env_id), env_id=env_id, status='running', round=0,
               model=model, session_id=session_id, bot_id=bot_id, reason='opened',
               started_at=now, updated_at=now)


def move_run(run: Run, to: str, reason: str, now: float) -> Run:
    if to not in RUN_STATUSES:
        raise GoalRefusal([f'"{to}" is not a run status'])
    if to not in RUN_MOVES[run.status]:
        legal = ', '.join(RUN_MOVES[run.status]) or 'none (terminal)'
        raise GoalRefusal([f'a run that is "{run.status}" cannot go to "{to}" — legal moves from here: {legal}'])
    return Run(**{**run.__dict__, 'status': to, 'reason': reason[:200], 'updated_at': now})


def spend_round(run: Run, max_rounds: int, now: float) -> tuple[Run, bool]:
    """One round against the run's OWN environment ceiling. Returns the run and whether it parked."""
    nxt = run.round + 1
    if max_rounds > 0 and nxt >= max_rounds:
        return Run(**{**run.__dict__, 'round': nxt, 'status': 'parked',
                      'reason': f'round ceiling {max_rounds} spent', 'updated_at': now}), True
    return Run(**{**run.__dict__, 'round': nxt, 'updated_at': now}), False


@dataclass
class Claim:
    id: str
    env_id: str
    text: str
    made_by: str
    made_at: float
    about_artifact_id: str = ''


def make_claim(env_id: str, text: str, by: str, now: float, about_artifact_id: str = '') -> Claim:
    body = (text or '').strip()
    if len(body) < 8:
        raise GoalRefusal(['a claim needs a sentence, not a word'])
    if len(body) > 400:
        raise GoalRefusal(['a claim is over 400 characters'])
    return Claim(id=new_id('claim', body), env_id=env_id, text=body,
                 made_by=by[:60] or 'model', made_at=now, about_artifact_id=about_artifact_id)


def to_mark(claim: Claim, verdict: str, evidence: Mapping[str, object] | None, by: str, now: float) -> dict[str, Any]:
    """A verdict with the row that earned it. Both are required, and both are re-checked when the row is
    read back, because a type does not survive JSON."""
    if verdict not in VERDICTS:
        raise GoalRefusal([f'"{verdict}" is not a verdict'])
    if not evidence or not isinstance(evidence, Mapping):
        raise GoalRefusal(['a mark needs an evidence reference — name the fact, skill, file or output this was checked against'])
    store = str(evidence.get('store') or '')
    key = str(evidence.get('key') or evidence.get('file_id') or '')
    if not store or not key:
        raise GoalRefusal(['an evidence reference must carry store and key (or file_id)'])
    return {
        'id': new_id('mark', claim.text), 'env_id': claim.env_id, 'claim_id': claim.id,
        'text': claim.text, 'verdict': verdict,
        'evidence': json.dumps({'store': store, 'key': key}),
        'by': (by or 'model')[:60], 'at': now,
    }


def _ref_key(ref: object) -> str:
    if isinstance(ref, str):
        try:
            data = json.loads(ref)
        except (TypeError, ValueError):
            return ref
    elif isinstance(ref, Mapping):
        data = ref
    else:
        return ''
    if not isinstance(data, Mapping):
        return ''
    return str(data.get('key') or data.get('file_id') or '')


@dataclass(frozen=True)
class Movement:
    """One move of an artifact, including the ones that did not happen — a refusal is a row."""
    artifact_id: str
    at: float
    actor: str
    from_env: str
    to_env: str
    ok: bool
    reason: str = field(default='')
