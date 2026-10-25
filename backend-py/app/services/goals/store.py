"""Goal environments — the SQLite over the pure rules.

One door to the brain database (``memory_conn.conn``), the same connection and commit discipline the
memory store uses, so a goal write lands in the same backup and integrity path as a fact. The rules
themselves live in ``records.py``; nothing here decides what is allowed, it only stores what the rules
accepted — with one exception that belongs to storage: ``goal_movements`` records a REFUSAL as a row,
because a blocked write that leaves no trace is a blocked write the model repeats.

Sync by design, like every other ``memory_store`` module. The tool layer is async and calls these
through ``asyncio.to_thread`` so a slow disk never blocks the event loop.
"""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Iterable, Mapping, Sequence

from app.services.goals import records as R
from app.services.memory_conn import commit as brain_commit
from app.services.memory_conn import conn as _conn


def _now() -> float:
    return time.time()


def _rows(sql: str, params: Sequence[object] = ()) -> list[sqlite3.Row]:
    return list(_conn().execute(sql, params).fetchall())


def _env_of(row: sqlite3.Row) -> R.Env:
    return R.Env(
        id=str(row['id']), parent_id=(str(row['parent_id']) if row['parent_id'] else None),
        title=str(row['title']), goal=str(row['goal']),
        inputs=list(json.loads(row['inputs'] or '[]')), outputs=list(json.loads(row['outputs'] or '[]')),
        bound=R.Bound.from_json(row['bound']), status=str(row['status']), owner=str(row['owner']),
        version=int(row['version']), depth=int(row['depth']),
        created_at=float(row['created_at']), updated_at=float(row['updated_at']),
        close_reason=str(row['close_reason'] or ''),
    )


def _run_of(row: sqlite3.Row) -> R.Run:
    return R.Run(
        id=str(row['id']), env_id=str(row['env_id']), status=str(row['status']), round=int(row['round']),
        model=str(row['model'] or ''), session_id=str(row['session_id'] or ''),
        bot_id=str(row['bot_id'] or ''), reason=str(row['reason'] or ''),
        started_at=float(row['started_at']), updated_at=float(row['updated_at']),
    )


def _insert_env(env: R.Env) -> None:
    c = _conn()
    c.execute(
        'INSERT INTO goal_envs (id, parent_id, title, goal, inputs, outputs, bound, status, owner, '
        'version, depth, close_reason, created_at, updated_at) '
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (env.id, env.parent_id, env.title, env.goal, json.dumps(env.inputs), json.dumps(env.outputs),
         env.bound.to_json(), env.status, env.owner, env.version, env.depth, env.close_reason,
         env.created_at, env.updated_at),
    )
    brain_commit(c)


def load_envs() -> list[R.Env]:
    return [_env_of(r) for r in _rows('SELECT * FROM goal_envs ORDER BY depth, created_at')]


def get_env(env_id: str) -> R.Env | None:
    rows = _rows('SELECT * FROM goal_envs WHERE id = ?', (env_id,))
    return _env_of(rows[0]) if rows else None


def ensure_root(seat_tools: Iterable[str]) -> R.Env:
    """The proxy's own environment, seeded once and never re-seeded.

    Never overwritten on a later call: a root that came back with fresh bounds would silently re-widen
    every goal under it, which is the one failure this layer exists to make impossible.
    """
    existing = get_env(R.ROOT_ID)
    if existing is not None:
        return existing
    root = R.seed_root(seat_tools, _now())
    _insert_env(root)
    return root


def create_env(*, parent_id: str, title: str, goal: str, inputs: object = None,
               outputs: object = None, bound: Mapping[str, object] | None = None) -> tuple[R.Env, list[str]]:
    env, removed = R.create_env(load_envs(), parent_id=parent_id, title=title, goal=goal,
                                inputs=inputs, outputs=outputs, bound=bound, now=_now())
    _insert_env(env)
    return env, removed


def edit_env(env_id: str, patch: Mapping[str, object], *, expected_version: int | None = None) -> tuple[R.Env, list[str]]:
    env = get_env(env_id)
    if env is None:
        raise R.GoalRefusal([f'no goal "{env_id}"'])
    unmet = R.unmet_outputs(env, load_artifacts(env_id), str(patch.get('reason') or '')) if patch.get('status') == 'done' else []
    next_env, clamped = R.edit_env(env, patch, unmet=unmet, expected_version=expected_version, now=_now())
    c = _conn()
    # Compare-and-set on the version the caller read: two turns editing the same goal cannot lose one
    # another's change, and a stale write is refused rather than silently overwriting.
    cur = c.execute(
        'UPDATE goal_envs SET title=?, goal=?, inputs=?, outputs=?, bound=?, status=?, version=?, '
        'close_reason=?, updated_at=? WHERE id=? AND version=?',
        (next_env.title, next_env.goal, json.dumps(next_env.inputs), json.dumps(next_env.outputs),
         next_env.bound.to_json(), next_env.status, next_env.version,
         str(patch.get('reason') or env.close_reason), next_env.updated_at, env_id, env.version),
    )
    if cur.rowcount == 0:
        raise R.GoalRefusal([f'"{env.title}" changed while you were editing it — read it again and retry'])
    brain_commit(c)
    return next_env, clamped


# ── artifacts + movements ───────────────────────────────────────────────────


def load_artifacts(env_id: str | None = None) -> list[dict[str, Any]]:
    sql = 'SELECT * FROM goal_artifacts' + (' WHERE env_id = ?' if env_id else '') + ' ORDER BY created_at'
    out: list[dict[str, Any]] = []
    for row in _rows(sql, (env_id,) if env_id else ()):
        item = dict(row)
        item['movements'] = [dict(m) for m in _rows(
            'SELECT at, actor, from_env, to_env, ok, reason FROM goal_movements '
            'WHERE artifact_id = ? ORDER BY id', (row['id'],))]
        out.append(item)
    return out


def record_artifact(*, env_id: str, kind: str, ref: Mapping[str, object], summary: str, produced_by: str) -> dict[str, Any]:
    body = (summary or '').strip()
    if len(body) < 4:
        raise R.GoalRefusal(['summary is too short to say what the artifact is'])
    store = str(ref.get('store') or '')
    key = str(ref.get('key') or ref.get('file_id') or '')
    if not store or not key:
        raise R.GoalRefusal(['a ref must name where the bytes live: store plus key (or file_id)'])
    if get_env(env_id) is None:
        raise R.GoalRefusal([f'no goal "{env_id}" to file this under'])
    art_id = R.new_id('art', body)
    now = _now()
    c = _conn()
    c.execute('INSERT INTO goal_artifacts (id, env_id, kind, ref, summary, produced_by, created_at, updated_at) '
              'VALUES (?,?,?,?,?,?,?,?)',
              (art_id, env_id, kind or 'note', json.dumps({'store': store, 'key': key}), body,
               (produced_by or 'model')[:60], now, now))
    c.execute('INSERT INTO goal_movements (artifact_id, at, actor, from_env, to_env, ok, reason) '
              'VALUES (?,?,?,?,?,?,?)',
              (art_id, now, (produced_by or 'model')[:60], '', env_id, 1, 'recorded'))
    brain_commit(c)
    return {'id': art_id, 'env_id': env_id, 'kind': kind or 'note', 'summary': body,
            'ref': json.dumps({'store': store, 'key': key})}


def move_artifact(artifact_id: str, to_env: str, *, actor: str, reason: str) -> dict[str, Any]:
    """Move, or record the refusal. ``to_env`` must exist; when it does not, the refusal is still a row."""
    rows = _rows('SELECT * FROM goal_artifacts WHERE id = ?', (artifact_id,))
    if not rows:
        raise R.GoalRefusal([f'no artifact "{artifact_id}" — read the goals for its id'])
    art = dict(rows[0])
    now = _now()
    ok = get_env(to_env) is not None
    detail = reason if ok else f'refused: {to_env} is not a goal'
    c = _conn()
    c.execute('INSERT INTO goal_movements (artifact_id, at, actor, from_env, to_env, ok, reason) '
              'VALUES (?,?,?,?,?,?,?)',
              (artifact_id, now, (actor or 'model')[:60], str(art['env_id']), to_env, 1 if ok else 0, detail[:200]))
    if ok:
        c.execute('UPDATE goal_artifacts SET env_id = ?, updated_at = ? WHERE id = ?', (to_env, now, artifact_id))
    brain_commit(c)
    return {'id': artifact_id, 'ok': ok, 'to': to_env, 'reason': detail}


# ── claims + marks ──────────────────────────────────────────────────────────


def load_claims(env_id: str | None = None) -> list[dict[str, Any]]:
    sql = 'SELECT * FROM goal_claims' + (' WHERE env_id = ?' if env_id else '') + ' ORDER BY made_at'
    claims = [dict(r) for r in _rows(sql, (env_id,) if env_id else ())]
    marked = {str(r['claim_id']) for r in _rows('SELECT claim_id FROM goal_marks')}
    for c in claims:
        c['marked'] = c['id'] in marked
    return claims


def load_marks(env_id: str | None = None) -> list[dict[str, Any]]:
    sql = 'SELECT * FROM goal_marks' + (' WHERE env_id = ?' if env_id else '') + ' ORDER BY at'
    return [dict(r) for r in _rows(sql, (env_id,) if env_id else ())]


def claim_env(claim_id: str) -> str | None:
    """The goal a claim belongs to. A mark rules on a CLAIM, so its environment is the claim's —
    resolving it from the session instead aimed the verdict at whatever goal the turn happened to be
    in, and the app-owned root refused it."""
    rows = _rows('SELECT env_id FROM goal_claims WHERE id = ?', (claim_id,))
    return str(rows[0]['env_id']) if rows else None


def add_claim(env_id: str, text: str, by: str, about_artifact_id: str = '') -> dict[str, Any]:
    if get_env(env_id) is None:
        raise R.GoalRefusal([f'no goal "{env_id}"'])
    claim = R.make_claim(env_id, text, by, _now(), about_artifact_id)
    c = _conn()
    c.execute('INSERT INTO goal_claims (id, env_id, text, about_artifact_id, made_by, made_at) '
              'VALUES (?,?,?,?,?,?)',
              (claim.id, claim.env_id, claim.text, claim.about_artifact_id, claim.made_by, claim.made_at))
    brain_commit(c)
    return {'id': claim.id, 'env_id': claim.env_id, 'text': claim.text}


def add_mark(claim_id: str, verdict: str, evidence: Mapping[str, object] | None, by: str) -> dict[str, Any]:
    rows = _rows('SELECT * FROM goal_claims WHERE id = ?', (claim_id,))
    if not rows:
        raise R.GoalRefusal([f'no claim "{claim_id}" — a mark rules on a claim that exists'])
    row = rows[0]
    claim = R.Claim(id=str(row['id']), env_id=str(row['env_id']), text=str(row['text']),
                    made_by=str(row['made_by']), made_at=float(row['made_at']))
    mark = R.to_mark(claim, verdict, evidence, by, _now())
    c = _conn()
    c.execute('INSERT INTO goal_marks (id, env_id, claim_id, text, verdict, evidence, by, at) '
              'VALUES (?,?,?,?,?,?,?,?)',
              (mark['id'], mark['env_id'], mark['claim_id'], mark['text'], mark['verdict'],
               mark['evidence'], mark['by'], mark['at']))
    brain_commit(c)
    return mark


# ── runs ────────────────────────────────────────────────────────────────────


def live_run(env_id: str, session_id: str) -> R.Run | None:
    for row in _rows('SELECT * FROM goal_runs WHERE env_id = ? AND session_id = ? AND status IN '
                     "('running','woken') ORDER BY started_at DESC", (env_id, session_id)):
        return _run_of(row)
    return None


def session_run(env_id: str, session_id: str) -> R.Run | None:
    """The run this session has in a goal — live first, then PARKED.

    A parked run is still the session's run: the digest that reported "no run open here" while one sat
    parked at its ceiling told the model to open a new one, which is exactly how a ceiling gets reset."""
    live = live_run(env_id, session_id)
    if live is not None:
        return live
    rows = _rows('SELECT * FROM goal_runs WHERE env_id = ? AND session_id = ? AND status = \x27parked\x27 '
                 'ORDER BY started_at DESC', (env_id, session_id))
    return _run_of(rows[0]) if rows else None


def env_of_session(session_id: str) -> str:
    """The goal this session is working in: its live run's, its parked run's, else the root."""
    for status in ("('running','woken')", "('parked')"):
        rows = _rows(f'SELECT env_id FROM goal_runs WHERE session_id = ? AND status IN {status} '
                     'ORDER BY started_at DESC', (session_id,))
        if rows:
            return str(rows[0]['env_id'])
    return R.ROOT_ID


def open_or_resume_run(env_id: str, *, session_id: str, model: str = '', bot_id: str = '') -> tuple[R.Run, list[str]]:
    """Open a run, or resume the one this session already has — including a PARKED one.

    The parked arm is the point: a turn starting and a model calling open must share one rule, or the
    ceiling can be reset by asking again. Started by ``ensure_root`` having run, so the environments
    exist before any run names one.
    """
    env = get_env(env_id)
    if env is None:
        raise R.GoalRefusal([f'no goal "{env_id}"'])
    if env.status != 'active':
        raise R.GoalRefusal([f'"{env.title}" is {env.status}; a run cannot work in a closed goal'])
    live = live_run(env_id, session_id)
    if live is not None:
        if model and live.model != model:
            _update_run(live.id, model=model)
            return R.Run(**{**live.__dict__, 'model': model}), [f'resumed the same run on {model} — round {live.round} stays spent']
        return live, []
    for row in _rows('SELECT * FROM goal_runs WHERE env_id = ? AND session_id = ? AND status = \'parked\' '
                     'ORDER BY started_at DESC', (env_id, session_id)):
        parked = _run_of(row)
        # A wake opens a NEW window: the ceiling is per window, so the count starts again and the
        # previous window's work is named in the reason. Keeping the count would print "round 5 of
        # 4" forever after the first park — the impossible receipt this layer exists to avoid.
        woken = R.Run(**{**parked.__dict__, 'status': 'running', 'round': 0,
                         'reason': f'resumed after {parked.round} round(s) at the ceiling',
                         'updated_at': _now()})
        _write_run(woken, insert=False)
        return woken, [f'resumed the parked run after {parked.round} round(s) at its ceiling — this window starts at round 0']
    run = R.open_run(env_id, _now(), session_id=session_id, model=model, bot_id=bot_id)
    _write_run(run, insert=True)
    return run, []


def _write_run(run: R.Run, *, insert: bool) -> None:
    c = _conn()
    if insert:
        c.execute('INSERT INTO goal_runs (id, env_id, session_id, bot_id, status, round, model, reason, '
                  'started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
                  (run.id, run.env_id, run.session_id, run.bot_id, run.status, run.round, run.model,
                   run.reason, run.started_at, run.updated_at))
    else:
        c.execute('UPDATE goal_runs SET status=?, round=?, model=?, reason=?, updated_at=? WHERE id=?',
                  (run.status, run.round, run.model, run.reason, run.updated_at, run.id))
    brain_commit(c)


def _update_run(run_id: str, *, model: str) -> None:
    c = _conn()
    c.execute('UPDATE goal_runs SET model=?, updated_at=? WHERE id=?', (model, _now(), run_id))
    brain_commit(c)


def get_run(run_id: str) -> R.Run | None:
    rows = _rows('SELECT * FROM goal_runs WHERE id = ?', (run_id,))
    return _run_of(rows[0]) if rows else None


def spend_rounds(run_id: str, count: int) -> tuple[R.Run, list[str]]:
    """Spend rounds against the run's OWN environment ceiling, parking at the round that crosses it."""
    run = get_run(run_id)
    if run is None:
        raise R.GoalRefusal([f'no run "{run_id}"'])
    if run.status not in ('running', 'woken'):
        raise R.GoalRefusal([f'a run that is "{run.status}" spends no rounds'])
    env = get_env(run.env_id)
    ceiling = env.bound.max_rounds if env is not None else 0
    notes: list[str] = []
    current = R.Run(**{**run.__dict__, 'status': 'running'})
    for _ in range(max(0, int(count))):
        current, parked = R.spend_round(current, ceiling, _now())
        if parked:
            notes.append(f'round ceiling {ceiling} on {run.env_id} reached — the run parked with its count kept')
            break
    _write_run(current, insert=False)
    return current, notes


def move_run(run_id: str, to: str, reason: str) -> R.Run:
    run = get_run(run_id)
    if run is None:
        raise R.GoalRefusal([f'no run "{run_id}"'])
    moved = R.move_run(run, to, reason, _now())
    _write_run(moved, insert=False)
    return moved
