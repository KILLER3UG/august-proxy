"""Facts, proposals, lifecycle, topics, usage, timeline, stats."""
from __future__ import annotations

import json
import logging
import sqlite3
from collections.abc import Sequence
from typing import cast

from app.json_narrowing import as_int, as_str
from app.services.hooks.secret_guard import scan_secrets
from app.services.memory_conn import commit as brain_commit
from app.services.memory_conn import conn as _conn
from app.services.memory_conn import db_path as _db_path
from app.services.memory_store.timeutil import utc_now_text
from app.services.memory_store.wire import _json, _row_as_wire
from app.services.sensitive_topics import sensitiveMemoryReason
from app.type_aliases import FactDict, JsonValue, ProposalDict

logger = logging.getLogger('august.memory_store.rest')

# The one durable-entry-kind vocabulary (the write door validates against it;
# retrieval reads from it). '' on a write means "unspecified" — see save_fact.
#
# 'profile' (2026-09-15) is the always-on "who the user is" lane: a fact about
# the user must not compete with every other fact for a keyword-matched BM25
# slot, so recall for this kind is never gated on lexical overlap — see
# fact_retrieval.build_profile_block. The DB column is plain TEXT with no CHECK
# constraint, so this frozenset (plus the `remember` tool's schema enum) is the
# whole surface; no migration and no new store.
PROFILE_FACT_KIND = 'profile'
_FACT_KINDS = frozenset({'fact', 'lesson', 'preference', 'skill-note', 'person', PROFILE_FACT_KIND})


class FactVersionConflict(ValueError):
    """An ``if_updated_at`` write lost its compare-and-swap; nothing was written.

    Carries the row as it stands NOW so the caller can merge and retry inside the
    same turn rather than overwrite a change it never read. It subclasses
    ``ValueError`` because every existing caller already treats that as "this
    write was refused" — a caller that has not learned the new class still refuses
    the write instead of treating it as success.
    """

    def __init__(self, factKey: str, current: FactDict) -> None:
        super().__init__(
            f'fact "{factKey}" changed since the version this write expected; nothing was written'
        )
        self.factKey = factKey
        self.current = current


def derive_fact_title(text: str) -> str:
    """Short human label for a fact (readability ruling 2026-08-26: titled
    entries, not raw blobs). First sentence/clause, capped at 60 chars."""
    cleaned = ' '.join((text or '').split())
    for sep in ('. ', '! ', '? ', '; ', ' — ', ': '):
        at = cleaned.find(sep)
        if 8 <= at <= 80:
            cleaned = cleaned[:at]
            break
    if len(cleaned) > 60:
        cleaned = cleaned[:60].rstrip() + '…'
    return cleaned


def save_fact(
    factKey: str,
    factValue: JsonValue,
    category: str = 'general',
    source: str = '',
    confidence: float = 1.0,
    expires_at: str | None = None,
    title: str = '',
    kind: str = '',
    scope: str = 'global',
    allow_scope_override: bool = False,
    description: str = '',
    verified: bool = False,
    if_updated_at: str = '',
    aliases: list[str] | tuple[str, ...] | str | None = None,
    subject_type: str = '',
    tag: str = '',
    source_session: str = '',
    sensitive: bool | None = None,
    derived_from: list[str] | tuple[str, ...] | str | None = None,
) -> None:
    """Save a structured fact. ``expires_at`` (ISO-8601 TEXT) is optional; the
    cognitive boot sweep purges facts whose expiry has passed.

    Upsert over the row's identity — ``(scope, fact_key)`` since 055, when
    ``fact_key`` stopped being unique store-wide. An update keeps the row id,
    ``created_at`` and usage counters, and only overwrites ``title``/``kind``/
    ``description`` when the caller actually supplies them (plan §3.3 — facts
    are titled, typed entries; 044 adds the ZCode-parity one-line recall
    ``description`` hook).

    M-2 (Part 21): ``scope`` ('global' | 'bot:<agentId>') stamps the row's
    memory home on INSERT, and is normalized here — the same normalizer
    retrieval uses — so a scope nothing can produce cannot be written either.
    An update never rewrites scope — a fact keeps the home it was born in.
    Part 26 6.2 (tightened): a key has exactly one home *per scope*. A write is
    only accepted when it comes from the row's own scope: a bot may update a
    GLOBAL fact by re-affirming it through the model doors
    *in a global session*, but a ``bot:<id>``-scoped write against a
    GLOBAL row is refused (it would otherwise replace the shared value while
    the row stayed ``global``), and a write against a row from a DIFFERENT
    private scope is likewise refused.

    Part 26 6.5: a write whose caller scope differs from the existing row's
    NON-GLOBAL scope is refused (raises ``ValueError``) instead of silently
    overwriting another bot's private value under its original scope —
    reachable from the Settings-UI manage endpoint, bulk import, and rollback
    restore. Callers that legitimately move/merge rows across scopes
    (consolidation) pass ``allow_scope_override=True``.

    2.4 (Part 25): an upsert resets ``status`` to 'active' — re-remembering a
    key that consolidation had superseded/retired must revive it, or the model
    believes it saved while retrieval keeps filtering the stale row out.

    ``if_updated_at`` turns the write into a compare-and-swap: the row is only
    updated while its ``updated_at`` still equals that stamp. The stamp is the
    one ``list_facts`` and the Memory page already hand out and it carries
    microseconds (see timeutil), so this needs no new column, table or store. A
    mismatch raises ``FactVersionConflict`` with the row as it stands now; an
    ``if_updated_at`` against no row at all is refused, because the token is a
    claim that the entry exists — letting it insert would write a row the caller
    believes it is updating.
    """
    from app.lib.paths import assertPytestDataDirIsolated
    from app.services.session_scope import GLOBAL_SCOPE, normalize_scope

    # The per-writer isolation guard `save_episode`, `save_internal` and the
    # workbench session writer all call. `save_fact` — the door with the most
    # callers and the only one that can fill the always-on profile lane — was
    # the one without it. The `dataDir()` hard raise added on 2026-09-26 is what
    # stopped the leak; this names the site so the next one is greppable rather
    # than inferred. That same day a test wrote 13 `profile:` fixture rows
    # ("Profile detail 7 describing the person reading this right now") into one
    # install's brain DB, and they are still injected into every turn: `profile`
    # rides the lane with no keyword gate, so test junk there is prompt junk
    # until a human deletes it.
    assertPytestDataDirIsolated('memory_store.save_fact')

    # Scope is normalized here, once, by the only authority — a caller cannot
    # write a scope retrieval could never produce (see normalize_scope).
    scope = normalize_scope(scope)

    if_updated_at = (if_updated_at or '').strip()
    if if_updated_at and get_fact(factKey) is None:
        raise ValueError(
            f'no stored fact "{factKey}" matches version "{if_updated_at}": '
            'there is nothing to update. Drop if_updated_at to create, or '
            're-read the key list first.'
        )

    if not allow_scope_override:
        existing = get_fact(factKey)
        if existing is not None:
            existingScope = str(existing.get('scope') or GLOBAL_SCOPE)
            requested = normalize_scope(scope)
            if existingScope != GLOBAL_SCOPE and requested != existingScope:
                raise ValueError(
                    f'fact "{factKey}" belongs to scope "{existingScope}"; '
                    f'refusing a write from scope "{requested}"'
                )
            # Part 26 6.2 (tightened): a bot-scoped write must NOT overwrite a
            # GLOBAL fact. The UPSERT never rewrites ``scope``, so a
            # ``bot:<id>`` write against a global row used to replace the
            # shared value while the row stayed ``global`` — the bot's private
            # note silently became every session's global fact, and the
            # original shared value was lost. A key has exactly one home: to
            # write a global key, write it from a global scope; a bot that
            # wants its own value must use a distinct key. Callers that
            # legitimately move/merge rows across scopes (consolidation,
            # rollback restore) pass ``allow_scope_override=True``.
            if requested != GLOBAL_SCOPE and existingScope == GLOBAL_SCOPE:
                raise ValueError(
                    f'fact "{factKey}" is a global fact; refusing to overwrite it '
                    f'from scope "{requested}" — write the global key from a '
                    'global scope, or use a distinct key for this scope.'
                )
    # The record shape is server-stamped. `tag` names the writer's code path
    # (never the model's claim); `subject_type` is the one-word identity the
    # index/UI groups by; `sensitive` is a durable copy of the write-door
    # detector so a read door can filter without re-running the regex.
    tagValue = (tag or '').strip().lower()
    if tagValue not in _TAG_VALUES:
        tagValue = _deriveFactTag(source)
    subjectValue = (subject_type or '').strip().lower()
    if subjectValue not in _SUBJECT_TYPES:
        subjectValue = _deriveSubjectType(kind, category)
    aliasesJson = _json(_normalizedStringList(aliases))
    derivedJson = _json(_normalizedStringList(derived_from, cap=8, item_cap=80))
    _valueText = factValue if isinstance(factValue, str) else str(factValue or '')
    sensitiveFlag = 1 if (
        sensitive
        if sensitive is not None
        else sensitiveMemoryReason(_valueText, title or '', description or '')
    ) else 0

    # A durable fact is re-injected into later turns — the <memory> tail and the
    # always-in profile lane carry whatever is stored here out to every provider
    # request. A credential saved as a fact is therefore published onward
    # indefinitely, and read back into any session that unions the scope, so the
    # shape is refused at this one door (the same door that refuses
    # project-scoped rows and cross-scope overwrites). Labels only, never the
    # matched value, matching hooks/secret_guard.scan_secrets' own contract.
    _secret_hits = scan_secrets(' '.join([
        factValue if isinstance(factValue, str) else str(factValue or ''),
        title or '',
        description or '',
    ]))
    if _secret_hits:
        raise ValueError(
            f'refusing to store secret-shaped content in durable memory '
            f'({", ".join(_secret_hits)}); keep credentials in a provider '
            'config or a secret store, not in a fact'
        )

    conn = _conn()
    # '' = unspecified: fresh inserts default to 'fact', updates keep the
    # existing kind (a remember-without-kind must not downgrade a lesson).
    kindParam = kind if kind in _FACT_KINDS else ''
    # The guard belongs INSIDE the statement. Reading the stamp and then writing
    # when it still matches leaves a window in which another writer moves the row
    # and this write clobbers it — which is the exact race being closed.
    # `if_version` accepts the microsecond `updated_at` stamp (the original
    # token) or the integer `version` the record now carries.
    _versionToken = bool(if_updated_at) and if_updated_at.isdigit()
    if _versionToken:
        casClause = '\n            WHERE facts.version = ?'
        casValue: object = int(if_updated_at)
    else:
        casClause = '\n            WHERE facts.updated_at = ?' if if_updated_at else ''
        casValue = if_updated_at
    cur = conn.execute(
        f"""
        INSERT INTO facts (fact_key, fact_value, title, kind, description, category, source, confidence, expires_at, scope, verified_at, updated_at, aliases, subject_type, tag, source_session, sensitive, version, derived_from)
        VALUES (?, ?, ?, COALESCE(NULLIF(?, ''), 'fact'), ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END, ?, ?, ?, ?, ?, ?, 1, ?)
        -- The conflict target is the row's IDENTITY, scope + key, not the key
        -- alone. `fact_key` unique store-wide (pre-055) meant one key had one
        -- home in the whole install, which is why per-scope memory had to be
        -- hand-namespaced — and the namespacing made the same content in two
        -- scopes unmergeable. With UNIQUE(scope, fact_key) an update targets
        -- the row this caller owns, so a Bot writing `model:note` updates its
        -- own row and never the user's global one.
        ON CONFLICT(scope, fact_key) DO UPDATE SET
            fact_value = excluded.fact_value,
            title = CASE WHEN excluded.title != '' THEN excluded.title ELSE facts.title END,
            kind = CASE WHEN excluded.kind != '' THEN excluded.kind ELSE facts.kind END,
            description = CASE WHEN excluded.description != '' THEN excluded.description ELSE facts.description END,
            category = excluded.category,
            source = excluded.source,
            confidence = excluded.confidence,
            expires_at = excluded.expires_at,
            status = 'active',
            aliases = CASE WHEN excluded.aliases != '[]' THEN excluded.aliases ELSE facts.aliases END,
            subject_type = CASE WHEN excluded.subject_type != '' THEN excluded.subject_type ELSE facts.subject_type END,
            tag = CASE WHEN excluded.tag != '' THEN excluded.tag ELSE facts.tag END,
            source_session = CASE WHEN excluded.source_session != '' THEN excluded.source_session ELSE facts.source_session END,
            sensitive = CASE WHEN excluded.sensitive = 1 OR COALESCE(facts.sensitive, 0) = 1 THEN 1 ELSE 0 END,
            version = COALESCE(facts.version, 1) + 1,
            derived_from = CASE WHEN excluded.derived_from != '[]' THEN excluded.derived_from ELSE facts.derived_from END,
            -- M-8: a RE-STATEMENT is the only verification this store can
            -- observe. `verified` is the caller's claim that a HUMAN wrote
            -- or restated the fact (the Settings write and the bulk import
            -- pass it); a model's `remember`, a consolidation merge and a
            -- rollback restore leave the existing stamp alone. A human
            -- INSERT stamps it; a machine INSERT leaves it NULL — nothing
            -- has confirmed the fact yet.
            verified_at = CASE WHEN ? THEN datetime('now') ELSE facts.verified_at END,
            updated_at = excluded.updated_at{casClause}
        """,
        (
            factKey,
            _json(factValue),
            (title or '').strip(),
            kindParam,
            ' '.join((description or '').split())[:200],
            category,
            source,
            confidence,
            expires_at,
            normalize_scope(scope),
            1 if verified else 0,
            utc_now_text(),
            aliasesJson,
            subjectValue,
            tagValue,
            (source_session or '').strip(),
            sensitiveFlag,
            derivedJson,
        )
        + ((1 if verified else 0),)
        + ((casValue,) if if_updated_at else ()),
    )
    if if_updated_at and int(cur.rowcount or 0) == 0:
        # Nothing changed, so the row exists with a DIFFERENT stamp: whoever read
        # this version is looking at a stale entry. Report the live row rather
        # than a bare no, so the caller can merge and retry in the same turn.
        conflictCurrent = get_fact(factKey) or cast('FactDict', {})
        brain_commit(conn)
        raise FactVersionConflict(factKey, conflictCurrent)
    brain_commit(conn)
    try:
        from app.services.memory_store.fact_retrieval import invalidate_fact_index

        invalidate_fact_index(scope)
    except Exception:
        pass


def touch_fact_usage(factKeys: list[str]) -> int:
    """Increment ``use_count`` / ``last_used_at`` for referenced facts.

    M3 usage feedback: an injected fact the model quotes (or updates via
    ``remember``) is marked as used; BM25 retrieval gives a small rank boost
    to high-use entries. Returns the number of rows touched. Since M-1's
    usage decoupling this does NOT touch the cached BM25 corpus — ranking
    reads fresh usage per query.
    """
    if not factKeys:
        return 0
    conn = _conn()
    touched = 0
    for key in factKeys:
        key = (key or '').strip()
        if not key:
            continue
        cur = conn.execute(
            "UPDATE facts SET use_count = COALESCE(use_count, 0) + 1, "
            "last_used_at = datetime('now') WHERE fact_key = ?",
            (key,),
        )
        touched += max(0, int(cur.rowcount))
    if touched:
        brain_commit(conn)
        # M-1 usage decoupling: NO invalidate_fact_index here.
        # The cached corpus no longer carries use_count/last_used_at —
        # ranking fetches fresh usage per query for the candidate set — so
        # a touch no longer triggers the full-corpus rebuild cliff.
    return touched


_TAG_VALUES = ('stated', 'observed', 'inferred')
_SUBJECT_TYPES = ('profile', 'preference', 'topic', 'area', 'person')


def _deriveFactTag(source: str) -> str:
    """The record's provenance tag, derived from the writer's code path.

    ``stated`` is the chat agent's and the human's door; ``inferred`` is the
    distiller/promotion path; ``observed`` is a bench/import observation.
    Never a model-supplied value — a tag the model can write is a claim
    nothing can check.
    """
    src = (source or '').strip().lower()
    if src in ('user', 'model', ''):
        return 'stated'
    if src == 'bench' or src.startswith('imported'):
        return 'observed'
    return 'inferred'


def _deriveSubjectType(kind: str, category: str) -> str:
    k = (kind or '').strip().lower()
    c = (category or '').strip().lower()
    if k == 'profile':
        return 'profile'
    if k == 'preference':
        return 'preference'
    if k == 'person' or c == 'person':
        return 'person'
    if k == 'project' or c == 'project':
        return 'area'
    return 'topic'


def _normalizedStringList(values: object, *, cap: int = 8, item_cap: int = 60) -> list[str]:
    if isinstance(values, str):
        raw: list[object] = [v.strip() for v in values.split(',')]
    elif isinstance(values, (list, tuple)):
        raw = list(values)
    else:
        raw = []
    out: list[str] = []
    for v in raw:
        s = ' '.join(str(v or '').split())[:item_cap]
        if s and s.lower() not in {x.lower() for x in out}:
            out.append(s)
        if len(out) >= cap:
            break
    return out


def _factRow(row: sqlite3.Row | dict[str, object]) -> FactDict:
    """A fact row with the record shape normalized on read.

    Legacy rows (before 056) or raw-SQL writers can leave ``tag`` /
    ``subject_type`` empty; derive the honest value from the fields that
    already encode it rather than printing a blank marker. ``aliases`` and
    ``derivedFrom`` are stored as JSON text and handed out as lists.
    """
    d = cast(dict[str, object], _row_as_wire(row))
    if not d.get('tag'):
        d['tag'] = _deriveFactTag(str(d.get('source') or ''))
    if not d.get('subjectType'):
        d['subjectType'] = _deriveSubjectType(
            str(d.get('kind') or ''), str(d.get('category') or '')
        )
    for field in ('aliases', 'derivedFrom'):
        raw = d.get(field)
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                parsed = []
            d[field] = parsed if isinstance(parsed, list) else []
    d['sensitive'] = bool(d.get('sensitive'))
    return cast(FactDict, d)


def get_fact(factKey: str) -> FactDict | None:
    """Get a fact by key."""
    conn = _conn()
    row = conn.execute('SELECT * FROM facts WHERE fact_key = ?', (factKey,)).fetchone()
    if not row:
        return None
    return _factRow(row)


def _visibility_where(
    scope: str, *, include_retired: bool = False
) -> tuple[str, list[object]]:
    """2.2: the shared read-visibility clause for the facts store —
    active + unexpired + the M-2 scope union (global ∪ this-scope). Every
    non-ranked facts read (list_facts / search_facts) must apply it, or a Bot
    sees every other Bot's private keys plus superseded/retired/expired rows.

    ``include_retired`` drops ONLY the status clause, for the model's audit
    door: a row parked by consolidation is still stored memory, and an actor
    that cannot see it can neither correct it nor explain why the store looks
    empty. Expiry and scope still apply — those describe whose memory it is,
    not whether it is parked.
    """
    from app.services.session_scope import GLOBAL_SCOPE, normalize_scope

    s = normalize_scope(scope)
    parts = [
        "(expires_at IS NULL OR expires_at = '' OR julianday(expires_at) > julianday('now'))",
    ]
    if not include_retired:
        parts.insert(0, "(status IS NULL OR status = 'active')")
    params: list[object] = []
    if s == GLOBAL_SCOPE:
        parts.append("(scope IS NULL OR scope = 'global')")
    else:
        parts.append("(scope IS NULL OR scope = 'global' OR scope = ?)")
        params.append(s)
    return ' AND '.join(parts), params


def search_facts(query: str, category: str = '', scope: str = 'global') -> list[FactDict]:
    """Search facts by key or value (visible-to-``scope`` only — 2.2)."""
    conn = _conn()
    # Escape LIKE wildcards so `100%` / `my_note` don't over-match.
    escaped = (query or '').replace('%', r'\%').replace('_', r'\_')
    like = f'%{escaped}%'
    vis, visParams = _visibility_where(scope)
    if category:
        rows = conn.execute(
            "SELECT * FROM facts WHERE (fact_key LIKE ? ESCAPE '\\' OR fact_value LIKE ? ESCAPE '\\') "
            f"AND category = ? AND {vis} ORDER BY updated_at DESC LIMIT 20",
            (like, like, category, *visParams),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM facts WHERE (fact_key LIKE ? ESCAPE '\\' OR fact_value LIKE ? ESCAPE '\\') "
            f"AND {vis} ORDER BY updated_at DESC LIMIT 20",
            (like, like, *visParams),
        ).fetchall()
    return [_factRow(r) for r in rows]


def list_facts(
    category: str = '',
    scope: str = 'global',
    limit: int = 500,
    offset: int = 0,
    include_retired: bool = False,
) -> list[FactDict]:
    """List facts visible to ``scope`` (active + unexpired — 2.2), optionally
    filtered by category. 5.3 (Part 25): the bound is pushed into SQL (was an
    unbounded fetch capped only in Python).

    ``offset`` is what makes the store ENUMERABLE: a model that can only ever
    read the newest N rows cannot audit memory it wrote earlier, so a capped
    first page used to be the whole story. ``include_retired`` adds the rows
    consolidation parked (see :func:`_visibility_where`).
    """
    conn = _conn()
    vis, visParams = _visibility_where(scope, include_retired=include_retired)
    lim = max(1, min(int(limit or 500), 2000))
    off = max(0, int(offset or 0))
    if category:
        rows = conn.execute(
            f'SELECT * FROM facts WHERE category = ? AND {vis} '
            # `id DESC` is a tie-break, not a nicety: legacy rows share
            # second-resolution stamps (new writes carry microseconds, but a
            # bulk import can still share one), so SQLite's order among equals
            # is unspecified — paging that set duplicated rows on one page and
            # dropped them from the next.
            'ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?',
            (category, *visParams, lim, off),
        ).fetchall()
    else:
        rows = conn.execute(
            f'SELECT * FROM facts WHERE {vis} '
            'ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?',
            (*visParams, lim, off),
        ).fetchall()
    return [_factRow(r) for r in rows]


def count_facts(
    category: str = '',
    scope: str = 'global',
    include_retired: bool = False,
) -> int:
    """Total rows :func:`list_facts` would page through — so a caller can say
    "3 of 57" instead of implying its page is the store."""
    conn = _conn()
    vis, visParams = _visibility_where(scope, include_retired=include_retired)
    if category:
        row = conn.execute(
            f'SELECT COUNT(*) FROM facts WHERE category = ? AND {vis}',
            (category, *visParams),
        ).fetchone()
    else:
        row = conn.execute(
            f'SELECT COUNT(*) FROM facts WHERE {vis}', tuple(visParams)
        ).fetchone()
    return int(row[0]) if row else 0


def update_fact_value(
    factKey: str,
    factValue: JsonValue,
    category: str = '',
    title: str = '',
    verified: bool = False,
) -> bool:
    """Change an EXISTING fact's value in place — the partial write door.

    ``save_fact`` is an upsert, so it also rewrites what a value change has no
    business touching: ``expires_at = excluded.expires_at`` clears a TTL, and
    ``status = 'active'`` revives a row consolidation had parked. A door whose
    UI shows the user the value it is about to replace may change that value
    and nothing else. Returns ``False`` when the key is not there, so the
    caller can fall back to a create.

    The refusals ``save_fact`` makes apply here too, because this is a second
    way into the same store: a non-global row is not writable from the settings
    door, and secret-shaped content is refused (facts are re-injected into
    later turns, so a credential saved here is published onward).
    """
    from app.lib.paths import assertPytestDataDirIsolated
    from app.services.session_scope import GLOBAL_SCOPE

    assertPytestDataDirIsolated('memory_store.update_fact_value')

    existing = get_fact(factKey)
    if existing is None:
        return False
    existingScope = str(existing.get('scope') or GLOBAL_SCOPE)
    if existingScope != GLOBAL_SCOPE:
        raise ValueError(
            f'fact "{factKey}" belongs to scope "{existingScope}"; a partial '
            'update from this door is refused'
        )

    hits = scan_secrets(' '.join([
        factValue if isinstance(factValue, str) else str(factValue or ''),
        title or '',
    ]))
    if hits:
        raise ValueError(
            f'refusing to store secret-shaped content in durable memory '
            f'({", ".join(hits)}); keep credentials in a provider config or a '
            'secret store, not in a fact'
        )

    stripped = (title or '').strip()
    conn = _conn()
    conn.execute(
        """
        UPDATE facts
        SET fact_value = ?,
            title = CASE WHEN ? != '' THEN ? ELSE title END,
            category = CASE WHEN ? != '' THEN ? ELSE category END,
            verified_at = CASE WHEN ? THEN datetime('now') ELSE verified_at END,
            updated_at = ?
        WHERE fact_key = ?
        """,
        (
            _json(factValue),
            stripped,
            stripped,
            category,
            category,
            1 if verified else 0,
            utc_now_text(),
            factKey,
        ),
    )
    brain_commit(conn)
    try:
        from app.services.memory_store.fact_retrieval import invalidate_fact_index

        invalidate_fact_index()
    except Exception:
        pass
    return True


def _superseded_keys(raw: object) -> list[str]:
    """The keys a fact replaced, read back from the ``supersedes`` column.

    Tolerant on purpose: the column is a JSON array in a TEXT column, and a
    row written by something else (or hand-edited) must not make the delete
    door throw.
    """
    if isinstance(raw, list):
        return [str(x) for x in raw if str(x)]
    if isinstance(raw, str) and raw.strip():
        try:
            loaded = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
        if isinstance(loaded, list):
            return [str(x) for x in loaded if str(x)]
    return []


def restore_superseded_losers(factKey: str) -> list[str]:
    """Bring back the entries ``factKey`` replaced (M-3).

    A superseded row is KEPT, not deleted — so the content that lost to a
    newer statement is still stored. But if the WINNER is deleted, those rows
    would stay parked forever with a link to a fact that no longer exists:
    invisible to recall, invisible to the UI's active list, and never
    proposed for anything. The content would be gone in every sense except
    that the bytes are on disk.

    So deleting a winner restores what it replaced: the status flips back to
    ``active`` and the lineage is cleared. The user asked for one memory to
    go; the entries that memory had replaced are a different memory, and
    bringing them back is the conservative reading.

    Returns the keys that were restored (empty when the fact replaced
    nothing, or when the columns are not there).
    """
    conn = _conn()
    try:
        row = conn.execute('SELECT supersedes FROM facts WHERE fact_key = ?', (factKey,)).fetchone()
    except Exception:
        return []
    if row is None:
        return []
    raw = row['supersedes'] if hasattr(row, 'keys') else row[0]
    losers = [k for k in _superseded_keys(raw) if k and k != factKey]
    if not losers:
        return []
    restored: list[str] = []
    try:
        now = utc_now_text()
        for key in losers:
            cur = conn.execute(
                "UPDATE facts SET status = 'active', superseded_by = NULL, contradicts = NULL, "
                "updated_at = ? "
                "WHERE fact_key = ? AND (status IS NULL OR status IN ('superseded', 'contested', 'archived'))",
                (now, key),
            )
            if cur.rowcount:
                restored.append(key)
        if restored:
            brain_commit(conn)
            try:
                from app.services.memory_store.fact_retrieval import invalidate_fact_index

                invalidate_fact_index()
            except Exception:
                pass
    except Exception:
        logger.debug('superseded restore failed', exc_info=True)
    return restored


def dependent_facts(factKey: str) -> list[FactDict]:
    """Every fact derived SOLELY from ``factKey`` (transitively).

    A row is a dependent only when every key in its ``derived_from`` list is
    already in the forgotten set — a row that also derives from a surviving
    parent is a different memory and stays. The walk repeats because deleting
    a dependent can make ITS children solely derived. Returns the rows to
    delete, children last (callers delete in order).
    """
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT * FROM facts WHERE derived_from IS NOT NULL AND derived_from != '' AND derived_from != '[]'"
        ).fetchall()
    except sqlite3.Error:
        return []
    deleted = {factKey}
    out: list[FactDict] = []
    changed = True
    while changed:
        changed = False
        for row in rows:
            try:
                parents = json.loads(str(row['derived_from'] or '[]'))
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(parents, list) or not parents:
                continue
            key = str(row['fact_key'] or '')
            if not key or key in deleted:
                continue
            if {str(p) for p in parents} <= deleted:
                deleted.add(key)
                out.append(_factRow(row))
                changed = True
    return out


def delete_fact(factKey: str) -> bool:
    """Delete a fact by key.

    M-3: the entries this fact REPLACED are restored first (see
    :func:`restore_superseded_losers`) — a winner that is deleted must not
    leave its losers parked against a fact that no longer exists.
    """
    restore_superseded_losers(factKey)
    conn = _conn()
    cursor = conn.execute('DELETE FROM facts WHERE fact_key = ?', (factKey,))
    brain_commit(conn)
    if cursor.rowcount > 0:
        try:
            from app.services.memory_store.fact_retrieval import invalidate_fact_index

            invalidate_fact_index()
        except Exception:
            pass
    return cursor.rowcount > 0


def save_proposal(sessionId: str, proposalType: str, content: JsonValue) -> int:
    """Save a proposal (plan, mutation, etc.)."""
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO proposals (session_id, proposal_type, content) VALUES (?, ?, ?)',
        (sessionId, proposalType, _json(content)),
    )
    brain_commit(conn)
    return as_int(cursor.lastrowid)


def get_proposal(proposalId: int) -> ProposalDict | None:
    """Get a proposal by ID."""
    conn = _conn()
    row = conn.execute('SELECT * FROM proposals WHERE id = ?', (proposalId,)).fetchone()
    return cast(ProposalDict, _row_as_wire(row)) if row else None


def list_proposals(sessionId: str, status: str = '') -> list[ProposalDict]:
    """List proposals for a session, optionally filtered by status."""
    conn = _conn()
    if status:
        rows = conn.execute(
            'SELECT * FROM proposals WHERE session_id = ? AND status = ? ORDER BY created_at DESC',
            (sessionId, status),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM proposals WHERE session_id = ? ORDER BY created_at DESC', (sessionId,)
        ).fetchall()
    return [cast(ProposalDict, _row_as_wire(r)) for r in rows]


def claim_proposal_decision(
    conn: sqlite3.Connection,
    proposalId: int,
    status: str,
    decidedBy: str = '',
    from_status: str | None = 'pending',
) -> bool:
    """Move a proposal out of `from_status`, on the caller's connection, WITHOUT
    committing.

    This is the guard, not a convenience: the UPDATE matches only rows still in
    `from_status`, so a proposal is decided once. A second approver, a retry
    after a crash, or an approval of something already rejected, gets False and
    changes nothing. `decide_proposal` below is the one-statement version; a
    flow that also writes facts calls this one so the claim and the write share
    a transaction. Pass `from_status=None` for an unconditional rewrite.
    """
    guard = '' if from_status is None else ' AND status = ?'
    params: list[object] = [status, decidedBy, proposalId]
    if from_status is not None:
        params.append(from_status)
    cursor = conn.execute(
        f"UPDATE proposals SET status = ?, decided_at = datetime('now'), decided_by = ? "
        f'WHERE id = ?{guard}',
        tuple(params),
    )
    return cursor.rowcount > 0


def decide_proposal(proposalId: int, status: str, decidedBy: str = '') -> bool:
    """Decide (approve/reject) a proposal. False means it was already decided."""
    conn = _conn()
    ok = claim_proposal_decision(conn, proposalId, status, decidedBy)
    brain_commit(conn)
    return ok


def record_lifecycle(sessionId: str, eventType: str, detail: JsonValue = None) -> int:
    """Record a lifecycle event."""
    from app.services.deferred_writes import defer_commit

    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO lifecycle (session_id, event_type, detail) VALUES (?, ?, ?)',
        (sessionId, eventType, _json(detail) if detail else None),
    )
    # P4.2: lifecycle rows are diagnostics, not read back
    # cross-thread within the turn — debounce the commit (≤2s).
    defer_commit(conn)
    return as_int(cursor.lastrowid)


def list_lifecycle(sessionId: str, eventType: str = '', limit: int = 100) -> list[dict[str, object]]:
    """List lifecycle events for a session."""
    conn = _conn()
    if eventType:
        rows = conn.execute(
            'SELECT * FROM lifecycle WHERE session_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?',
            (sessionId, eventType, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM lifecycle WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
            (sessionId, limit),
        ).fetchall()
    return [_row_as_wire(r) for r in rows]


def record_config_audit(
    category: str, action: str, actor: str = '', before: JsonValue = None, after: JsonValue = None
) -> int:
    """Record a structured config-change audit entry.

    Used by alias, fallback, and agent mutation paths so that every
    self-configuration change is traceable.
    """
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO config_audit (category, action, actor, before_json, after_json) VALUES (?, ?, ?, ?, ?)',
        (
            category,
            action,
            actor,
            _json(before) if before is not None else None,
            _json(after) if after is not None else None,
        ),
    )
    brain_commit(conn)
    return as_int(cursor.lastrowid)


def list_config_audit(category: str = '', limit: int = 200) -> list[dict[str, object]]:
    """List config-change audit entries, newest first."""
    conn = _conn()
    if category:
        rows = conn.execute(
            'SELECT * FROM config_audit WHERE category = ? ORDER BY created_at DESC LIMIT ?',
            (category, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM config_audit ORDER BY created_at DESC LIMIT ?', (limit,)
        ).fetchall()
    results = []
    for r in rows:
        entry: dict[str, object] = {
            'id': r['id'],
            'category': r['category'],
            'action': r['action'],
            'actor': r['actor'] or '',
            'createdAt': r['created_at'],
        }
        for rawKey, outKey in (('before_json', 'before'), ('after_json', 'after')):
            raw = r[rawKey]
            if isinstance(raw, str):
                try:
                    entry[outKey] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    entry[outKey] = raw
            else:
                entry[outKey] = raw
        results.append(entry)
    return results


def index_session_topic(
    sessionId: str, topic: str, parentTopic: str | None = None, confidence: float = 0.75
) -> bool:
    """Record or update the topic for a session."""
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO session_topics (session_id, topic, parent_topic, confidence, classified_at)\n               VALUES (?, ?, ?, ?, datetime('now'))\n               ON CONFLICT(session_id) DO UPDATE SET\n                   topic=excluded.topic,\n                   parent_topic=excluded.parent_topic,\n                   confidence=excluded.confidence,\n                   classified_at=excluded.classified_at",
            (sessionId, topic, parentTopic, confidence),
        )
        brain_commit(conn)
        return True
    except Exception:
        return False


def get_session_topic(sessionId: str) -> dict[str, object] | None:
    """Get the classified topic for a session."""
    conn = _conn()
    row = conn.execute('SELECT * FROM session_topics WHERE session_id = ?', (sessionId,)).fetchone()
    return _row_as_wire(row) if row else None


def list_topics(limit: int = 50) -> list[dict[str, object]]:
    """List all classified session topics, most recent first."""
    conn = _conn()
    rows = conn.execute(
        'SELECT * FROM session_topics ORDER BY classified_at DESC LIMIT ?', (limit,)
    ).fetchall()
    return [_row_as_wire(r) for r in rows]


def search_sessions_by_topic(topic: str) -> list[dict[str, object]]:
    """Find sessions with a given topic classification."""
    conn = _conn()
    rows = conn.execute(
        'SELECT * FROM session_topics WHERE topic = ? ORDER BY classified_at DESC', (topic,)
    ).fetchall()
    return [_row_as_wire(r) for r in rows]


def resolve_sot_session_id(sessionId: str) -> str:
    """Prefer a workbench / sessions-table SoT id when recording or looking up usage.

    If ``sessionId`` already exists on ``sessions``, keep it. If a workbench
    blob exists with that id, keep it. Otherwise return the given id unchanged
    (callers may pass a provisional frontend id before linking).
    """
    sid = (sessionId or '').strip()
    if not sid:
        return sid
    conn = _conn()
    row = conn.execute('SELECT id FROM sessions WHERE id = ? LIMIT 1', (sid,)).fetchone()
    if row:
        return str(row['id'] if isinstance(row, dict) or hasattr(row, 'keys') else row[0])
    # Also accept ids that only appear on usage already (historical)
    return sid


def record_usage(
    sessionId: str,
    model: str,
    inputTokens: int = 0,
    outputTokens: int = 0,
    contextTokens: int = 0,
    cacheHitTokens: int = 0,
    cacheMissTokens: int = 0,
    turn_id: int | None = None,
) -> int:
    """Record a usage event against the session SoT id when known.

    ``contextTokens`` captures the provider-reported ``inputTokens`` of the
    FINAL sub-call in the agentic turn — i.e. the true current context fill
    (system prompt + tools + messages, counted once). The cumulative
    ``inputTokens``/``outputTokens`` are still recorded for Usage-page totals.

    ``cacheHitTokens``/``cacheMissTokens`` carry the universal prompt-cache
    split (Anthropic cache_read/cache_creation vs OpenAI-compatible
    prompt_cache_hit/miss) so the UI can show the cache hit rate.

    ``turn_id`` is the 053 join key: the ``turn_outcomes.id`` this usage belongs
    to. It was the missing link between "what this call cost" and "how the turn
    ended", which is why no query could rank models or tools by cost per
    success. NULL means "no turn row" (a direct API call, or a turn whose
    telemetry write failed), never zero.
    """
    sot_id = resolve_sot_session_id(sessionId)
    conn = _conn()
    try:
        cursor = conn.execute(
            'INSERT INTO usage_events (session_id, model, input_tokens, output_tokens, '
            'context_tokens, cache_hit_tokens, cache_miss_tokens, turn_id) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (
                sot_id,
                model,
                inputTokens,
                outputTokens,
                contextTokens,
                cacheHitTokens,
                cacheMissTokens,
                turn_id,
            ),
        )
    except Exception as exc:
        # 053 not applied yet (a DB whose migration budget is spent): keep the
        # usage row, lose only the join key. Same rule as 046 in turn_outcomes.
        msg = str(exc).lower()
        if 'no such column' not in msg and 'has no column' not in msg:
            raise
        cursor = conn.execute(
            'INSERT INTO usage_events (session_id, model, input_tokens, output_tokens, context_tokens, cache_hit_tokens, cache_miss_tokens) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (sot_id, model, inputTokens, outputTokens, contextTokens, cacheHitTokens, cacheMissTokens),
        )
    brain_commit(conn)
    return as_int(cursor.lastrowid)


def list_usage(*, limit: int = 200) -> list[dict[str, object]]:
    """List recent usage events (newest first), for GET /api/usage."""
    conn = _conn()
    lim = max(1, min(int(limit), 1000))
    rows = conn.execute(
        'SELECT id, session_id, model, input_tokens, output_tokens, context_tokens, created_at '
        'FROM usage_events ORDER BY created_at DESC, id DESC LIMIT ?',
        (lim,),
    ).fetchall()
    return [_row_as_wire(r) for r in rows]


#: Most session ids one batched sidebar read will ask about. The sidebar caps
#: what it renders before calling (GROUP_RENDER_CAP per group), so this is a
#: backstop against an unbounded `IN (...)` rather than the normal size — and it
#: stays well under SQLite's default 999 bound-parameter ceiling.
MAX_USAGE_BATCH_IDS = 250


def get_usage_batch(session_ids: Sequence[str]) -> dict[str, dict[str, object]]:
    """Input/output token totals for MANY sessions in ONE grouped query.

    The sidebar renders a ``+input / -output`` delta on every visible chat row.
    Asking :func:`get_usage` per row cost one HTTP request per row AND, behind
    each one, a 500-row per-event fetch plus a per-event pricing sweep — the
    list's own render was driving all of it. This is the single ``GROUP BY
    session_id`` that replaces the N.

    Keyed by the id the caller ASKED FOR, not a resolved one, so the caller can
    index the result directly. Ids with no usage rows are simply absent (an
    absent row and a zero row mean the same thing to a delta readout, and
    emitting zeros for every unseen id would grow the payload for no fact).
    """
    ids: list[str] = []
    seen: set[str] = set()
    for raw in session_ids:
        sid = (raw or '').strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        ids.append(sid)
        if len(ids) >= MAX_USAGE_BATCH_IDS:
            break
    if not ids:
        return {}
    conn = _conn()
    placeholders = ','.join('?' * len(ids))
    rows = conn.execute(
        'SELECT session_id, COALESCE(SUM(input_tokens), 0) AS total_input, '
        'COALESCE(SUM(output_tokens), 0) AS total_output, COUNT(*) AS event_count '
        f'FROM usage_events WHERE session_id IN ({placeholders}) GROUP BY session_id',
        tuple(ids),
    ).fetchall()
    out: dict[str, dict[str, object]] = {}
    for r in rows:
        key = as_str(r['session_id'], '')
        total_in = as_int(r['total_input'], 0)
        total_out = as_int(r['total_output'], 0)
        out[key] = {
            'sessionId': key,
            'totalEvents': as_int(r['event_count'], 0),
            'totalInputTokens': total_in,
            'totalOutputTokens': total_out,
            'totalTokens': total_in + total_out,
        }
    return out


def get_usage(sessionId: str) -> dict[str, object]:
    """Get aggregated usage for a session.

    Resolves to the session SoT id when the id exists on ``sessions``.
    Returns cumulative totals (for the Usage page) plus ``latestContextTokens``
    — the ``contextTokens`` of the most recent usage event: the FULL prompt
    of the final sub-call of the latest turn (uncached + cache-read +
    cache-creation), i.e. the true current context fill. Earlier rows
    recorded only the raw ``input_tokens``, which on the Anthropic shape
    excludes cache tokens and under-reports a warm session. Also returns the
    per-event list ordered newest-first so the caller can derive the same
    value independently.
    """
    sessionId = resolve_sot_session_id(sessionId)
    conn = _conn()
    row = conn.execute(
        'SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, '
        'SUM(cache_hit_tokens) as total_cache_hit, SUM(cache_miss_tokens) as total_cache_miss, '
        'COUNT(*) as request_count FROM usage_events WHERE session_id = ?',
        (sessionId,),
    ).fetchone()
    totals = dict(row) if row else {
        'total_input': 0, 'total_output': 0, 'total_cache_hit': 0, 'total_cache_miss': 0, 'request_count': 0
    }
    latest = conn.execute(
        'SELECT context_tokens, input_tokens FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        (sessionId,),
    ).fetchone()
    if latest:
        latestCtx = latest['context_tokens'] or latest['input_tokens']
    else:
        latestCtx = 0
    events = [
        {
            'id': e['id'],
            'model': e['model'],
            'inputTokens': e['input_tokens'],
            'outputTokens': e['output_tokens'],
            'contextTokens': e['context_tokens'] or e['input_tokens'],
            'totalTokens': (e['input_tokens'] or 0) + (e['output_tokens'] or 0),
            'createdAt': e['created_at'],
        }
        for e in conn.execute(
            'SELECT id, model, input_tokens, output_tokens, context_tokens, cache_hit_tokens, cache_miss_tokens, created_at FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 500',
            (sessionId,),
        ).fetchall()
    ]
    cache_hit = totals.get('total_cache_hit', 0) or 0
    cache_miss = totals.get('total_cache_miss', 0) or 0
    cache_total = cache_hit + cache_miss
    # Cost: per-event sum using the shared pricing table (the composer chip,
    # the spend ceiling, and this endpoint must agree). Never raises.
    total_cost = 0.0
    cost_estimated = False
    try:
        from app.services.cost_estimator import session_cost_estimate

        for e in conn.execute(
            'SELECT model, input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens FROM usage_events WHERE session_id = ?',
            (sessionId,),
        ).fetchall():
            cost, estimated = session_cost_estimate(
                model_id=as_str(e['model'], ''),
                total_in=as_int(e['input_tokens'], 0),
                total_out=as_int(e['output_tokens'], 0),
                cache_hit=as_int(e['cache_hit_tokens'], 0),
                cache_miss=as_int(e['cache_miss_tokens'], 0),
            )
            total_cost += cost
            # One guessed price in a mixed-model session makes the whole sum a
            # guess; one exact price cannot make the others exact.
            cost_estimated = cost_estimated or estimated
        total_cost = round(total_cost, 4)
    except Exception:
        total_cost = 0.0
    return {
        'sessionId': sessionId,
        'totalEvents': totals.get('request_count', 0) or 0,
        'totalInputTokens': totals.get('total_input', 0) or 0,
        'totalOutputTokens': totals.get('total_output', 0) or 0,
        'totalTokens': (totals.get('total_input', 0) or 0) + (totals.get('total_output', 0) or 0),
        'cacheHitTokens': cache_hit,
        'cacheMissTokens': cache_miss,
        'cacheHitRate': round(cache_hit / cache_total, 3) if cache_total else 0.0,
        'totalCost': total_cost,
        'costEstimated': cost_estimated,
        'model': events[0]['model'] if events else None,
        'provider': None,
        'contextTokens': latestCtx,
        'latestContextTokens': latestCtx,
        'events': events,
    }


def get_stats() -> dict[str, object]:
    """Get database statistics.

    Keys are camelCase table aliases for wire compatibility (e.g. memoryStore).
    """
    conn = _conn()
    # SQL table → wire key
    tables = [
        ('memory_store', 'memoryStore'),
        ('facts', 'facts'),
        ('proposals', 'proposals'),
        ('sessions', 'sessions'),
        ('messages', 'messages'),
        ('usage_events', 'usageEvents'),
        ('session_topics', 'sessionTopics'),
    ]
    stats: dict[str, object] = {}
    for table, wire_key in tables:
        try:
            row = conn.execute(f'SELECT COUNT(*) as count FROM {table}').fetchone()
            stats[wire_key] = row['count'] if row else 0
        except Exception:
            stats[wire_key] = 0
    stats['db_size_bytes'] = _db_path().stat().st_size if _db_path().exists() else 0
    return stats


def write_timeline_event(
    sessionId: str | None, eventSummary: str, category: str = 'general', scope: str = 'global'
) -> int:
    """v2: Append an entry to episodic_timeline. Returns the new row's id.

    ``sessionId`` is optional — system events (e.g. memory lifecycle) have
    no owning session. ``scope`` (Part 27 T1) fences the entry so a Bot's
    private timeline never rides into a global session's boot index.
    """
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO episodic_timeline (timestamp, session_id, event_summary, category, scope) "
        "VALUES (datetime('now'), ?, ?, ?, ?)",
        (sessionId, eventSummary, category, scope or 'global'),
    )
    brain_commit(conn)
    return as_int(cur.lastrowid)
