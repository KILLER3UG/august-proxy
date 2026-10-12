"""The `proposals` table has more than one owner, so every statement in this
module must name the type it owns.

Two subsystems write the same table:

  * `spawn_subagents_tool` — `proposal_type = 'subagent_breakdown'`
  * `memory_store.rest.save_proposal` — `'retire-fact'`, `'retire-preference'`,
    and whatever a future memory feature adds

The subagent paths originally queried `WHERE status = 'pending'` and nothing
else, so a memory proposal was simultaneously: listed on the Runs tab as a
zero-item breakdown, hydratable into a subagent spawn, expired when an unrelated
chat was deleted, and flipped to `rejected` by an approval that was not about it.
The last one is the destructive case — `claim_proposal_decision` reads
`from_status='pending'`, so a foreign flip makes the real approval look like
someone already decided, and the fact the user meant to retire is never retired.

Both halves are pinned here: the behavior of each entry point, and the rule that
no statement may address the shared table without naming its type — because a
sixth entry point added next month would otherwise escape the fix exactly the
way the five that exist today did.
"""

from __future__ import annotations

import ast
import inspect
import time

from app.services.memory_store import _conn
from app.services.memory_store.rest import save_proposal
from app.services.tools import spawn_subagents_tool as spawn

OWNED = 'subagent_breakdown'
FOREIGN = 'retire-fact'


def _proposal_statements() -> list[tuple[str, str]]:
    """`(sql, source-of-the-whole-call)` for every `.execute()` in the module
    whose literal SQL names the shared `proposals` table.

    The second half is what a test needs when the type travels as a bound
    parameter rather than a literal in the string.
    """
    src = inspect.getsource(spawn)
    tree = ast.parse(src)
    out: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if not (isinstance(fn, ast.Attribute) and fn.attr == 'execute') or not node.args:
            continue
        try:
            sql = ast.literal_eval(node.args[0])
        except ValueError:
            continue  # f-string: the interpolated value cannot name a table
        if not isinstance(sql, str) or 'proposals' not in sql:
            continue
        source = ast.get_source_segment(src, node) or sql
        out.append((sql, source))
    return out


def _is_pk_addressed(sql: str) -> bool:
    """A write by integer primary key — safe only as the tail of a scoped SELECT,
    which is what the first test checks separately."""
    return 'WHERE id = ?' in sql and sql.lstrip().upper().startswith('UPDATE')


def _row(pid_row_id: int) -> dict:
    row = _conn().execute('SELECT * FROM proposals WHERE id = ?', (pid_row_id,)).fetchone()
    return dict(row)


def _insert_subagent_proposal(session_id: str, proposal_id: str, created_at: float) -> None:
    spawn._persist_proposal(
        proposal_id,
        type('S', (), {'id': session_id})(),
        [{'goal': 'do a thing'}],
        'auto',
        True,
        created_at,
    )


def _fresh() -> float:
    """A `createdAt` the TTL will not eat.

    `list_persisted_proposals()` runs the expiry sweep first, so a test that
    seeds a proposal with a fixed epoch timestamp has its own row expired before
    the call it is measuring — which reads as "the filter hid my row" and is
    really the TTL doing its job.
    """
    return time.time()


def _stale() -> float:
    return time.time() - spawn.PROPOSAL_TTL_S - 1


class TestEveryProposalStatementNamesItsType:
    """A guard on the shape of the module, not on one query.

    Reads the real source: every `conn.execute(...)` whose SQL mentions the
    `proposals` table must either scope by `proposal_type` or address a row by
    its integer primary key — which is safe only because the SELECT that found
    that id was itself type-scoped, so every statement in a chain has to hold
    the rule. An INSERT counts, because the column list names the type it writes.
    """

    def test_all_proposals_statements_are_type_scoped(self):
        offenders = [
            sql[:70]
            for sql, _source in _proposal_statements()
            if 'proposal_type' not in sql and not _is_pk_addressed(sql)
        ]
        assert not offenders, 'unscoped statements:\n' + '\n'.join(offenders)

    def test_the_type_predicate_is_the_one_this_module_owns(self):
        """Not just "some filter" — the filter must be the owned type.

        A statement scoped to the WRONG type would sail through the check above
        and still break the owner it names. The type can arrive as a literal in
        the SQL or as a bound parameter, so the whole call is what gets read.
        """
        calls = _proposal_statements()
        assert calls, 'the module must touch `proposals` at all for this to mean anything'
        for sql, source in calls:
            if _is_pk_addressed(sql):
                continue
            assert OWNED in source, source[:120]


class TestForeignRowsAreInvisible:
    def test_the_runs_list_shows_only_breakdowns(self):
        _insert_subagent_proposal('wb_runs', 'sp_runs', _fresh())
        save_proposal('wb_runs', FOREIGN, {'proposalId': 'mem_1', 'factKey': 'likes/coffee'})

        listed = spawn.list_persisted_proposals()
        ids = [p['proposalId'] for p in listed]
        assert ids == ['sp_runs']
        assert 'mem_1' not in ids

    def test_a_memory_proposal_cannot_be_hydrated_into_a_spawn(self):
        """Same `proposalId`, different owner.

        The content blob is free-form JSON, so a foreign row can carry the very
        key the breakdown lookup matches on. Only the type predicate separates
        them, and the lookup is the one that ends up launching agents.
        """
        save_proposal('wb_hyd', FOREIGN, {'proposalId': 'shared_id', 'factKey': 'x'})
        assert spawn._load_proposal_from_db('shared_id') is None

        _insert_subagent_proposal('wb_hyd', 'shared_id', _fresh())
        hydrated = spawn._load_proposal_from_db('shared_id')
        assert hydrated is not None
        assert hydrated['workItems'] == [{'goal': 'do a thing'}]

    def test_an_approval_cannot_flip_a_foreign_row(self):
        _insert_subagent_proposal('wb_dec', 'sp_dec', _fresh())
        foreign_id = save_proposal('wb_dec', FOREIGN, {'proposalId': 'sp_dec'})

        spawn._mark_proposal_decided('sp_dec', 'rejected')

        assert _row(foreign_id)['status'] == 'pending', (
            'a subagent approval retired a memory proposal that shares the id'
        )

    def test_deleting_a_chat_does_not_expire_memory_proposals(self):
        foreign_id = save_proposal('wb_del', FOREIGN, {'proposalId': 'mem_del'})
        _insert_subagent_proposal('wb_del', 'sp_del', 1_700_000_000.0)

        expired = spawn.expire_proposals_for_session('wb_del')

        assert _row(foreign_id)['status'] == 'pending'
        assert expired >= 1, 'the breakdown row should still be expired'

    def test_the_ttl_sweep_leaves_other_owners_alone(self):
        now = time.time()
        foreign_id = save_proposal('wb_ttl', FOREIGN, {'proposalId': 'mem_ttl', 'createdAt': 1.0})
        _insert_subagent_proposal('wb_ttl', 'sp_ttl', _stale())

        spawn._expire_stale_proposals(now=now)

        assert _row(foreign_id)['status'] == 'pending'


class TestTheOwnedRowsStillWork:
    """The filter must not be a wall: the module's own rows still flow through
    every path the fix touched."""

    def test_lifecycle_is_intact(self):
        _insert_subagent_proposal('wb_life', 'sp_life', _fresh())
        assert [p['proposalId'] for p in spawn.list_persisted_proposals()] == ['sp_life']
        assert spawn._expire_stale_proposals(now=time.time() + spawn.PROPOSAL_TTL_S + 1) >= 1
        assert spawn.list_persisted_proposals() == []

    def test_session_delete_still_expires_the_breakdown(self):
        _insert_subagent_proposal('wb_sd', 'sp_sd', _fresh())
        assert spawn.expire_proposals_for_session('wb_sd') >= 1
        assert spawn.list_persisted_proposals() == []
