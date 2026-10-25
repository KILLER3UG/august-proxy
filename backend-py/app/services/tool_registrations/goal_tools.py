"""Goal tools — the four doors a model uses to work inside an environment and edit it.

Registered beside ``harness_tools`` (which stays the self-improvement pipeline: propose, then a
human decides). These are different: an environment is work state the agent owns, so editing it is
not a proposal — but it is also not unconstrained, and every constraint lives in ``records`` /
``policy`` rather than in this file.

Handlers are async and every store call runs in ``asyncio.to_thread``: the store is synchronous
sqlite like the rest of ``memory_store``, and a goal write must never block the event loop.
Refusals come back as ``Blocked: …`` — the marker the receipt layer already reads as a failure — so
a refused write is visible to the model and to the transcript instead of looking like a receipt.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from app.json_narrowing import as_dict, as_str
from app.services import tool_registry
from app.services.goals import records as R
from app.services.goals import store as S
from app.services.goals.policy import deny_refusal, effective, meta_refusal


def _session_id() -> str:
    from app.services.workbench.context import currentSessionId

    return str(currentSessionId.get() or 'default')


def _seat_tools() -> list[str]:
    # No try/except: an empty seat list would make every bound empty, which reads as "this goal
    # permits nothing" — a lie. A registry failure should be loud, not degrade into a lockout.
    return [str(t.get('name') or '') for t in tool_registry.listTools()]


def _blocked(tool: str, reasons: list[str]) -> str:
    return f'Blocked: {tool} refused — ' + ' · '.join(reasons or ['the goal rules refused it'])


def _bound_json(raw: object) -> dict[str, Any] | None:
    if raw is None or raw == '':
        return None
    if isinstance(raw, dict):
        return as_dict(raw)
    text = as_str(raw, '')
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise R.GoalRefusal(['bound_json is not JSON — pass {"allow":[…],"deny":[…],"maxRounds":n,"contextChars":n}']) from exc
    if not isinstance(parsed, dict):
        raise R.GoalRefusal(['bound_json must be a JSON object'])
    return parsed


def _digest(envs: list[R.Env], session_id: str) -> str:
    policy = effective(envs, S.env_of_session(session_id), _seat_tools())
    env = next((e for e in envs if e.id == policy.env_id), envs[0] if envs else None)
    if env is None:
        return 'GOALS — none yet. goal_edit op=create opens one under the root.'
    rows = [f'GOALS — you are in "{env.title}" ({env.id})'
            + (f', under {" › ".join(policy.path)}' if len(policy.path) > 1 else ', the app\u2019s own')]
    rows.append(f'Bound in force: {len(policy.allow)} tool(s) reachable | rounds '
                f'{policy.max_rounds if policy.max_rounds < 10 ** 6 else "uncapped"}'
                + (f' | refused here: {", ".join(n for n, _ in policy.denials[:8])}' if policy.denials else ''))
    for e in envs[:8]:
        filed = len([a for a in S.load_artifacts(e.id)])
        owed = R.unmet_outputs(e, S.load_artifacts(e.id))
        note = f', outputs: {len(e.outputs)} ({filed} filed' + (f', owed: {"; ".join(owed)}' if owed else '') + ')' if e.outputs else ''
        rows.append(f'- {e.id} "{e.title}" [{e.status}] v{e.version}{" (the app\u2019s own, read-only)" if not e.writable else ""}{note}')
    if len(envs) > 8:
        rows.append(f'… and {len(envs) - 8} more goal(s) — goal_read lists them all.')
    from app.services.goals.store import session_run  # local: keeps the module import light

    run = session_run(env.id, session_id)
    if run is not None:
        rows.append(f'Run {run.id} is {run.status} at round {run.round} of {env.bound.max_rounds}'
                    + (f' — {run.reason}' if run.reason else '')
                    + ('. A new turn resumes it.' if run.status != 'parked' else '. It is parked at its ceiling; close it or begin the next goal.'))
    else:
        rows.append('No run open here — goal_run op=open starts one for this goal.')
    claims = S.load_claims(env.id)
    marks = S.load_marks(env.id)
    if claims or marks:
        rows.append(f'{len(marks)} mark(s) with verdicts, {len([c for c in claims if not c["marked"]])} claim(s) waiting for one. A claim is not a finding.')
    return '\n'.join(rows)


async def _read(**kwargs: object) -> str:
    envs = await asyncio.to_thread(S.load_envs)
    if not envs:
        await asyncio.to_thread(S.ensure_root, _seat_tools())
        envs = await asyncio.to_thread(S.load_envs)
    return _digest(envs, _session_id())


async def _edit(**kwargs: object) -> str:
    op = as_str(kwargs.get('op'), '').lower()
    envs = await asyncio.to_thread(S.load_envs)
    if not envs:
        envs = [await asyncio.to_thread(S.ensure_root, _seat_tools())]
    session_id = _session_id()
    policy = effective(envs, S.env_of_session(session_id), _seat_tools())

    if op == 'create':
        parent_id = as_str(kwargs.get('parent_id'), '') or S.env_of_session(session_id)
        parent = next((e for e in envs if e.id == parent_id), None)
        if parent is None:
            return _blocked('goal_edit', [f'no goal "{parent_id}" to work under — goal_read lists the ids'])
        # Creating under the root is the normal case: only the DENY list applies to a parent.
        refusal = deny_refusal(policy, 'goal_edit')
        if refusal:
            return _blocked('goal_edit', [refusal])
        try:
            bound = _bound_json(kwargs.get('bound_json'))
            env, removed = await asyncio.to_thread(
                lambda: S.create_env(parent_id=parent_id, title=as_str(kwargs.get('title'), ''),
                                     goal=as_str(kwargs.get('goal'), ''), inputs=kwargs.get('inputs'),
                                     outputs=kwargs.get('outputs'), bound=bound))
        except R.GoalRefusal as exc:
            return _blocked('goal_edit', exc.reasons)
        return (f'Created {env.id} "{env.title}" under {parent_id} (depth {env.depth}). '
                f'Bound: allow {len(env.bound.allow)}, deny {", ".join(env.bound.deny) or "none"}, rounds {env.bound.max_rounds}. '
                + (f'CLAMPED TO THE PARENT: {" · ".join(removed)}. ' if removed else '')
                + 'Name its outputs, or "done" has no meaning here.')

    if op != 'update':
        return _blocked('goal_edit', [f'op "{op or "(missing)"}" is not one of create | update'])
    env_id = as_str(kwargs.get('id'), '')
    target = next((e for e in envs if e.id == env_id), None)
    if target is None:
        return _blocked('goal_edit', [f'no goal "{env_id}"'])
    refusal = meta_refusal(policy, 'goal_edit', target)
    if refusal:
        return _blocked('goal_edit', [refusal])
    patch: dict[str, object] = {}
    for key in ('title', 'goal', 'inputs', 'outputs', 'status', 'reason'):
        if kwargs.get(key) not in (None, ''):
            patch[key] = kwargs.get(key)
    if kwargs.get('bound_json') not in (None, ''):
        try:
            patch['bound'] = _bound_json(kwargs.get('bound_json'))
        except R.GoalRefusal as exc:
            return _blocked('goal_edit', exc.reasons)
    if not patch:
        return _blocked('goal_edit', ['nothing to change — pass title, goal, inputs, outputs, bound_json, status or reason'])
    raw_version = kwargs.get('version')
    version: int | None = None
    if raw_version not in (None, ''):
        try:
            # A tool argument arrives as JSON, so the version is usually an int already; as_str
            # returns its default for non-strings, and int('') then refused a perfectly good 99.
            version = int(raw_version) if isinstance(raw_version, (int, float)) else int(as_str(raw_version, ''))
        except (TypeError, ValueError):
            return _blocked('goal_edit', [f'version must be a number, got {raw_version!r}'])
    try:
        next_env, clamped = await asyncio.to_thread(
            lambda: S.edit_env(env_id, patch, expected_version=version))
    except R.GoalRefusal as exc:
        return _blocked('goal_edit', exc.reasons)
    return (f'Updated {next_env.id} "{next_env.title}" to v{next_env.version} [{next_env.status}].'
            + (f' CLAMPED: {" · ".join(clamped)} — a goal may only narrow, never widen.' if clamped else '')
            + (' Closed as done: every named output is on file or named in your reason.' if next_env.status == 'done' else ''))


async def _output(**kwargs: object) -> str:
    op = as_str(kwargs.get('op'), '').lower()
    op0 = as_str(kwargs.get('op'), '').lower()
    # A mark rules on a claim, so its goal is the CLAIM's; everything else defaults to the
    # session's goal.
    env_id = (as_str(kwargs.get('env_id'), '')
              or (S.claim_env(as_str(kwargs.get('claim_id'), '')) or '' if op0 == 'mark' else '')
              or S.env_of_session(_session_id()))
    env = await asyncio.to_thread(S.get_env, env_id)
    if env is None:
        return _blocked('goal_output', [f'no goal "{env_id}"'])
    envs = await asyncio.to_thread(S.load_envs)
    policy = effective(envs, S.env_of_session(_session_id()), _seat_tools())
    refusal = meta_refusal(policy, 'goal_output', env)
    if refusal:
        return _blocked('goal_output', [refusal])

    try:
        if op == 'record':
            ref = {'store': as_str(kwargs.get('ref_store'), '') or 'facts',
                   'key': as_str(kwargs.get('ref_key'), '') or as_str(kwargs.get('ref_file_id'), '')}
            art = await asyncio.to_thread(lambda: S.record_artifact(
                env_id=env_id, kind=as_str(kwargs.get('kind'), '') or 'note', ref=ref,
                summary=as_str(kwargs.get('summary'), ''), produced_by='model'))
            return (f'Filed {art["id"]} under {env_id}: {art["summary"]} → {ref["store"]}/{ref["key"]}. '
                    'This is what lets the goal close as done.')
        if op == 'move':
            res = await asyncio.to_thread(lambda: S.move_artifact(
                as_str(kwargs.get('id'), ''), as_str(kwargs.get('to'), ''),
                actor='model', reason=as_str(kwargs.get('reason'), '') or 're-filed'))
            if not res['ok']:
                return _blocked('goal_output', [str(res['reason'])])
            return f'Moved {res["id"]} to {res["to"]}.'
        if op == 'claim':
            claim = await asyncio.to_thread(lambda: S.add_claim(
                env_id, as_str(kwargs.get('text'), ''), 'model', as_str(kwargs.get('about_artifact_id'), '')))
            return f'Claim {claim["id"]} recorded (NOT confirmed). Make it a mark with the row that proves it.'
        if op == 'mark':
            evidence = {'store': as_str(kwargs.get('evidence_store'), '') or 'facts',
                        'key': as_str(kwargs.get('evidence_key'), '') or as_str(kwargs.get('evidence_file_id'), '')}
            mark = await asyncio.to_thread(lambda: S.add_mark(
                as_str(kwargs.get('claim_id'), ''), as_str(kwargs.get('verdict'), '') or 'partial', evidence, 'model'))
            return f'Mark {mark["id"]}: {mark["verdict"].upper()} — {mark["text"]}'
    except R.GoalRefusal as exc:
        return _blocked('goal_output', exc.reasons)
    return _blocked('goal_output', [f'op "{op or "(missing)"}" is not one of record | move | claim | mark'])


async def _run(**kwargs: object) -> str:
    op = as_str(kwargs.get('op'), '').lower()
    session_id = _session_id()
    env_id = as_str(kwargs.get('env_id'), '') or S.env_of_session(session_id)
    envs = await asyncio.to_thread(S.load_envs)
    env = next((e for e in envs if e.id == env_id), None)
    if env is None:
        return _blocked('goal_run', [f'no goal "{env_id}"'])
    policy = effective(envs, S.env_of_session(session_id), _seat_tools())
    refusal = meta_refusal(policy, 'goal_run', env)
    if refusal:
        return _blocked('goal_run', [refusal])

    try:
        if op == 'open':
            run, notes = await asyncio.to_thread(lambda: S.open_or_resume_run(
                env_id, session_id=session_id, model=as_str(kwargs.get('model'), '')))
            return (f'{" ".join(notes)} ' if notes else '') + \
                f'Run {run.id} in {env_id} is {run.status} at round {run.round} of {env.bound.max_rounds}.'
        run_id = as_str(kwargs.get('run_id'), '')
        if not run_id:
            live = await asyncio.to_thread(S.live_run, env_id, session_id)
            if live is None:
                return _blocked('goal_run', [f'{op} needs a run_id — this session has no open run in {env_id}; call op=open first'])
            run_id = live.id
        if op == 'round':
            spent, notes = await asyncio.to_thread(S.spend_rounds, run_id, 1)
            return f'Run {run_id} at round {spent.round}' + (f' — {" · ".join(notes)}' if notes else '.')
        if op in ('park', 'close'):
            to = 'parked' if op == 'park' else ('failed' if as_str(kwargs.get('status'), '') == 'failed' else 'done')
            moved = await asyncio.to_thread(S.move_run, run_id, to, as_str(kwargs.get('reason'), '') or op)
            return f'Run {run_id} {moved.status} after {moved.round} round(s) — {moved.reason}.'
    except R.GoalRefusal as exc:
        return _blocked('goal_run', exc.reasons)
    return _blocked('goal_run', [f'op "{op or "(missing)"}" is not one of open | park | close | round'])


def register() -> None:
    tool_registry.register(
        'goal_read',
        'Read the goal environment you are working inside: the goal and its ancestors, the bound in '
        'force (which tools this goal can reach, its round ceiling), every open goal, the live run and '
        'its rounds, the outputs still owed, and claims versus marks. Call it BEFORE editing anything — '
        'ids come from here. Read-only.',
        _read,
        {'type': 'object', 'properties': {}},
        keywords=['goal', 'environment', 'run', 'harness', 'plan'],
    )
    tool_registry.register(
        'goal_edit',
        'Edit your working environment while the task runs. op=create opens a sub-goal under a parent '
        '(title, goal, inputs, outputs, optional bound_json with allow/deny/maxRounds/contextChars); '
        'op=update rewrites a goal you own (pass version to avoid clobbering a concurrent edit, and a '
        'reason when closing). No approval is queued — this is work state, not a skill. What you cannot '
        'do is WIDEN: a sub-goal may only lose tools, gain refusals and lower its ceilings, and the '
        'app-owned root and its settings are read-only to you.',
        _edit,
        {
            'type': 'object',
            'properties': {
                'op': {'type': 'string', 'description': 'create | update'},
                'id': {'type': 'string', 'description': 'update: the goal id from goal_read.'},
                'parent_id': {'type': 'string', 'description': 'create: the goal to work under (default: this session\u2019s goal).'},
                'title': {'type': 'string', 'description': '3-80 chars, what this goal is.'},
                'goal': {'type': 'string', 'description': '10-600 chars: what the work is FOR.'},
                'inputs': {'type': 'array', 'items': {'type': 'string'}, 'description': 'What the work reads.'},
                'outputs': {'type': 'array', 'items': {'type': 'string'}, 'description': 'What has to exist for this to be done. Name them.'},
                'bound_json': {'type': 'string', 'description': 'JSON: {"allow":[names],"deny":[names],"maxRounds":n,"contextChars":n}. Clamped to the parent.'},
                'status': {'type': 'string', 'description': 'update: active | done | abandoned. done needs its outputs accounted for; abandoned never needs anything.'},
                'version': {'type': 'number', 'description': 'update: the version you read. A stale one is refused WITH the current version.'},
                'reason': {'type': 'string', 'description': 'Why — required in practice when closing, and it counts as evidence for an output it names.'},
            },
            'required': ['op'],
        },
        keywords=['goal', 'environment', 'create', 'edit', 'narrow'],
    )
    tool_registry.register(
        'goal_output',
        'File what you produced and rule on what you concluded. op=record attaches a MANIFEST to a goal '
        '(kind, ref_store, ref_key or ref_file_id, summary) — the bytes stay where they are, nothing is '
        'copied. op=move re-files it (the attempt is recorded either way). op=claim states a conclusion. '
        'op=mark turns a claim into a verdict and REQUIRES the row that proves it: "confirmed" with no '
        'evidence is the one thing this app must not let you mint.',
        _output,
        {
            'type': 'object',
            'properties': {
                'op': {'type': 'string', 'description': 'record | move | claim | mark'},
                'env_id': {'type': 'string', 'description': 'record/claim: the goal (default: this session\u2019s).'},
                'kind': {'type': 'string', 'description': 'record: note | plan | report | skill | fact | file | other.'},
                'ref_store': {'type': 'string', 'description': 'record: facts | notebook | skills | file | strategy (default facts).'},
                'ref_key': {'type': 'string', 'description': 'record: the slug or name in that store.'},
                'ref_file_id': {'type': 'string', 'description': 'record: a file path/id, when that is what you have.'},
                'summary': {'type': 'string', 'description': 'record: one line saying what this is, in the words of the output it satisfies.'},
                'id': {'type': 'string', 'description': 'move: the artifact id.'},
                'to': {'type': 'string', 'description': 'move: the goal to file it under.'},
                'text': {'type': 'string', 'description': 'claim: the sentence you are standing behind.'},
                'about_artifact_id': {'type': 'string', 'description': 'claim: the artifact it is about, when there is one.'},
                'claim_id': {'type': 'string', 'description': 'mark: the claim this rules on.'},
                'verdict': {'type': 'string', 'description': 'mark: confirmed | refuted | partial.'},
                'evidence_store': {'type': 'string', 'description': 'mark: where the proof lives.'},
                'evidence_key': {'type': 'string', 'description': 'mark: the slug/name of the proof.'},
                'evidence_file_id': {'type': 'string', 'description': 'mark: a path/id proof.'},
                'reason': {'type': 'string', 'description': 'move: why it is being re-filed.'},
            },
            'required': ['op'],
        },
        keywords=['goal', 'output', 'artifact', 'claim', 'mark', 'evidence'],
    )
    tool_registry.register(
        'goal_run',
        'The work record that survives this turn. op=open starts or RESUMES the run for this session in '
        'a goal — a turn is not a task, and a resumed run keeps its spent rounds, so a model switch does '
        'not restart the ceiling. op=round spends one against the goal\u2019s own ceiling, op=park stops it '
        'with a reason, op=close ends it (done or failed). Close it yourself when the goal closes; '
        'nothing closes it for you.',
        _run,
        {
            'type': 'object',
            'properties': {
                'op': {'type': 'string', 'description': 'open | round | park | close'},
                'env_id': {'type': 'string', 'description': 'open: the goal (default: this session\u2019s).'},
                'run_id': {'type': 'string', 'description': 'round/park/close: the run (default: this session\u2019s open run).'},
                'status': {'type': 'string', 'description': 'close: done | failed.'},
                'reason': {'type': 'string', 'description': 'Why the run moved. Read back next turn.'},
                'model': {'type': 'string', 'description': 'open: the model carrying this turn, for the receipt.'},
            },
            'required': ['op'],
        },
        keywords=['goal', 'run', 'rounds', 'ceiling', 'resume'],
    )
