"""Part 16 Phase C — tier-2 judge + distiller (2026-08-30).

One model call per flagged cluster (batches of ≤5 episodes), piggybacking
the consolidation cadence — no new scheduler. The judge sees ONLY the
flagged episode windows (typed events + short excerpts) plus skill
TITLES/DESCRIPTIONS — never whole conversations, never full skill bodies.
Never runs inside a live turn or a sub-agent.

Verdict actions (strict JSON):
  none / memory / create_skill / amend_trigger / amend_body

Wiring:
  * ``memory``          → save_fact(source='harness', kind='lesson') — the
    server-side path `remember` uses; consolidation-deduped; human-deletable
    in the Memory UI.
  * ``create_skill`` /
    ``amend_trigger``   → harness_self_improve.save_proposal — the existing
    human-gated queue. Bodies normalize through _ensure_canonical_body at
    PROPOSE time so reviewers see the final shape.
  * ``amend_body``      → gated on the precision ship bar (≥0.8 on ≥30
    hand-labeled episodes, test_distiller_precision.py); until met the
    verdict downgrades to a proposal-with-note (OQ 2 recommended default:
    the judge is not trusted to rewrite human-authored bodies at birth).
Every drafted summary/body passes the shared sensitive-topic denylist.
Judge failures (bad JSON/timeout) log to lifecycle and return the episode
to tier 1 with a cooldown — no retry storms.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services.memory_conn import conn as _conn

logger = logging.getLogger(__name__)

_BATCH_SIZE = 5
_JUDGE_TIMEOUT_S = 60
_JUDGE_COOLDOWN_MIN = 30
_PRECISION_SHIP_BAR = 0.8
_PRECISION_MIN_LABELED = 30
_EXCERPT_CAP = 240
_DRAFT_CAP = 1200

_JUDGE_SYSTEM = (
    'You are the distiller judge for August\'s self-improvement loop. You '
    'receive a batch of flagged episode windows (failure/recovery, '
    'correction, abandoned-approach) and the titles/descriptions of the '
    'user\'s existing skills. Decide per episode whether anything durable '
    'should be learned. Reply with STRICT JSON only — no prose, no code '
    'fences:\n'
    '{"verdicts": [{"episode": <id>, "action": "none|memory|create_skill|'
    'amend_trigger|amend_body", "reason": "<short>",'
    ' "summary": "<one-line fact>", "category": "project|reference|feedback|general",'
    ' "title": "<short title>", "expires_days": <int>,'
    ' "name": "<skill-name>", "description": "<when to use>",'
    ' "trigger": "<trigger phrase>", "body_markdown": "<skill body>",'
    ' "skill": "<existing skill name>", "patch_markdown": "<amended section>"}]}'
    ' Omit fields irrelevant to the chosen action. Prefer "none" for one-offs.'
)


# ── model resolution (§4: explicit → background-review → titler) ────────


def resolve_judge_model() -> str:
    """Dedicated ``skillLearningJudgeModel`` → first reader of the dead
    ``auxiliary.background_review.autoMemoryModel`` selector → the titler's
    ``titleModel``. Empty when nothing resolves (judge skips the pass)."""
    try:
        from app.services.brain_config_service import getRuntimeConfig

        explicit = str(getRuntimeConfig().get('skillLearningJudgeModel', '') or '').strip()
        if explicit:
            return explicit
    except Exception:
        pass
    try:
        from app.services.background_review_service import getConfig

        bg = str((getConfig() or {}).get('autoMemoryModel', '') or '').strip()
        if bg:
            return bg
    except Exception:
        pass
    try:
        from app.services.brain_config_service import getRuntimeConfig

        return str(getRuntimeConfig().get('titleModel', '') or '').strip()
    except Exception:
        return ''


def _resolveProvider(model: str) -> dict[str, object] | None:
    if not model:
        return None
    try:
        from app.providers import resolver as providerResolver

        return providerResolver.resolve(model)
    except Exception:
        logger.debug('judge provider resolve failed for %r', model, exc_info=True)
        return None


# ── judge I/O ────────────────────────────────────────────────────────────


def _skillIndex() -> list[dict[str, str]]:
    """Titles/descriptions ONLY — the judge never sees full bodies."""
    try:
        from app.services.skill_service import list_all

        return [
            {
                'name': str(s.get('name', '')),
                'description': str(s.get('description', '')),
            }
            for s in list_all()
        ]
    except Exception:
        return []


def _episodeWindow(ep: dict[str, Any]) -> str:
    events = ep.get('events')
    if isinstance(events, str):
        try:
            events = json.loads(events)
        except Exception:
            events = []
    lines = [f"episode {ep.get('id')} [{ep.get('kind')}] outcome={ep.get('outcome')}"]
    for e in events or []:
        excerpt = str(e.get('excerpt', ''))[:_EXCERPT_CAP]
        lines.append(f"  - {e.get('type')}: {excerpt}")
    return '\n'.join(lines)


def build_judge_prompt(batch: list[dict[str, Any]]) -> str:
    skills = _skillIndex()
    skillLines = '\n'.join(
        f"- {s['name']}: {s['description'][:160]}" for s in skills[:40]
    ) or '(no skills yet)'
    windows = '\n\n'.join(_episodeWindow(ep) for ep in batch)
    return (
        f'Existing skills (titles/descriptions only):\n{skillLines}\n\n'
        f'Flagged episode windows:\n{windows}\n\n'
        'Return verdicts for every episode id above.'
    )


def _extractJson(raw: str) -> dict[str, Any]:
    """Strict JSON out — tolerate a code fence, nothing else."""
    text = (raw or '').strip()
    fence = re.search(r'```(?:json)?\s*(\{.*\})\s*```', text, re.DOTALL)
    if fence:
        text = fence.group(1)
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get('verdicts'), list):
        raise ValueError('judge JSON missing verdicts array')
    return data


async def call_judge(prompt: str) -> dict[str, Any] | None:
    """One judge model call. Returns parsed JSON or None (judge failed).

    §12 F-7: uses an UNPOOLED client, closed after the call — judge batches
    run on throwaway event loops (one ``asyncio.run`` per pass), and a
    pooled client's keep-alive connections bind to the loop that made them,
    so the next pass hits "Event loop is closed" every other time."""
    model = resolve_judge_model()
    provider = _resolveProvider(model)
    if not provider or not model:
        logger.info('distiller judge skipped: no judge model resolves')
        return None
    try:
        from app.providers.clients import getUnpooledClient

        client = getUnpooledClient(provider)
        if not client:
            return None
        try:
            client.config = {**dict(client.config or {}), 'model': model}
            raw = await client.generate(prompt, system=_JUDGE_SYSTEM)
            return _extractJson(str(raw))
        finally:
            try:
                await client.close()
            except Exception:
                pass
    except Exception as exc:
        logger.warning('distiller judge call failed: %s', exc)
        return None


# ── anti-drift: one draft per (fingerprint, action, target) ─────────────


def _draftExists(fp: str, action: str, target: str) -> bool:
    """One draft per (fingerprint, action, target) — across ALL statuses.

    §12 F-8: matching only ``open`` meant a human-REJECTED suggestion
    re-filed on every pass (the queue refilled with rejected noise), and an
    APPLIED draft could be filed again. Anti-drift (plan §3.4): once the
    judge has produced a draft for a fingerprint/action/target, the loop
    never re-files it."""
    try:
        from app.services.harness_self_improve import list_proposals

        for p in list_proposals():
            payload = p.get('payload')
            if not isinstance(payload, dict):
                continue
            if (
                str(payload.get('fingerprint', '')) == fp
                and str(payload.get('action', '')) == action
                and str(payload.get('target', '')) == target
            ):
                return True
    except Exception:
        pass
    return False


# ── precision ship bar (OQ 2: amend_body is NOT trusted at birth) ───────


def precision_state() -> dict[str, Any]:
    """Judge precision over hand-labeled episodes (test_distiller_precision
    harness feeds this store). ``amend_body_enabled`` is the ship bar."""
    try:
        from app.lib.paths import dataPath

        path = dataPath('skill_learning_precision.json')
        data = json.loads(path.read_text('utf-8')) if path.exists() else {}
    except Exception:
        data = {}
    labeled = int(data.get('labeled', 0))
    correct = int(data.get('correct', 0))
    precision = (correct / labeled) if labeled else 0.0
    return {
        'labeled': labeled,
        'correct': correct,
        'precision': round(precision, 4),
        'amendBodyEnabled': labeled >= _PRECISION_MIN_LABELED and precision >= _PRECISION_SHIP_BAR,
    }


def record_precision_run(labeled: int, correct: int) -> dict[str, Any]:
    """Accumulate one harness run into the precision store."""
    from app.lib.paths import dataPath

    path = dataPath('skill_learning_precision.json')
    try:
        data = json.loads(path.read_text('utf-8')) if path.exists() else {}
    except Exception:
        data = {}
    data['labeled'] = int(data.get('labeled', 0)) + int(labeled)
    data['correct'] = int(data.get('correct', 0)) + int(correct)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), 'utf-8')
    return precision_state()


# ── verdict application ──────────────────────────────────────────────────


def _isBundledSkill(name: str) -> bool:
    try:
        from app.services.skill_service import SKILLS_DIR

        return (SKILLS_DIR / name).is_dir()
    except Exception:
        return False


def _learnedSkillText(name: str) -> tuple[str, str] | None:
    """(description, current body) of a LEARNED skill — the amend_body
    target. None when the skill doesn't exist (bundled skills are handled
    by the caller before this)."""
    try:
        from app.services.skill_service import _agentSkillsDir

        md = _agentSkillsDir() / name / 'SKILL.md'
        if not md.exists():
            return None
        text = md.read_text('utf-8')
    except Exception:
        return None
    description = ''
    body = text
    if text.startswith('---'):
        try:
            _, fm, rest = text.split('---', 2)
            for line in fm.split('\n'):
                if line.strip().startswith('description:'):
                    description = line.partition(':')[2].strip().strip('"').strip("'")
            body = rest.lstrip('\n')
        except ValueError:
            body = text
    return description, body


def apply_verdict(
    verdict: dict[str, Any], fingerprint: str, mode: str = 'extract-only', scope: str = ''
) -> str:
    """Apply one judge verdict. Returns a short result label.

    ``mode``: extract-only (ship default) applies memory verdicts only —
    skill drafting requires ``full``; ``off`` never reaches here.
    ``scope``: the M-2 scope of the source episode (Part 26 6.4) — a Bot's
    distilled lessons land in the Bot's own memory home instead of global.
    """
    action = str(verdict.get('action', 'none') or 'none').strip().lower()
    episodeId = verdict.get('episode')

    if action in ('create_skill', 'amend_trigger', 'amend_body') and mode != 'full':
        return 'skipped-extract-only'

    if action == 'memory':
        from app.services.memory_store import save_fact
        from app.services.sensitive_topics import isSensitiveMemory
        from app.services.session_scope import GLOBAL_SCOPE, normalize_scope

        summary = str(verdict.get('summary', '')).strip()
        title = str(verdict.get('title', '')).strip()
        if not summary or isSensitiveMemory(summary, title):
            return 'rejected-denylist'
        factScope = normalize_scope(scope) if (scope or '').strip() else GLOBAL_SCOPE
        expiresDays = verdict.get('expires_days')
        expiresAt = (
            (datetime.now(timezone.utc) + timedelta(days=int(expiresDays))).date().isoformat()
            if isinstance(expiresDays, (int, float)) and int(expiresDays) > 0
            else None
        )
        key = re.sub(r'[^a-z0-9-]+', '-', (title or summary).lower()).strip('-')[:48] or 'distilled-lesson'
        save_fact(
            f'distilled:{key}',
            summary,
            category=str(verdict.get('category', 'general') or 'general'),
            source='harness',
            kind='lesson',
            expires_at=expiresAt,
            title=title,
            scope=factScope,
        )
        return 'memory-saved'

    if action in ('create_skill', 'amend_trigger', 'amend_body'):
        # §3.3 denylist: applies to EVERY drafted text before persist —
        # description/body/trigger of skill drafts and amend patches, not just
        # memory verdicts. A health/ID/belief detail must not survive inside a
        # skill file just because the verdict's action was skill-shaped.
        from app.services.sensitive_topics import isSensitiveMemory

        _sensitive_blob = ' '.join(
            str(verdict.get(k, '') or '')
            for k in ('description', 'body_markdown', 'trigger', 'patch_markdown')
        )
        if isSensitiveMemory(_sensitive_blob):
            return 'rejected-denylist'

    if action in ('create_skill', 'amend_trigger'):
        # Bundled skills are never amended in place — an amend against one
        # becomes a FRESH draft referencing it (supersedes lineage).
        if action == 'amend_trigger' and _isBundledSkill(str(verdict.get('skill', '')).strip()):
            verdict = {
                **verdict,
                'action': 'create_skill',
                'name': f"{str(verdict.get('skill')).strip()}-revised",
                'supersedes': str(verdict.get('skill')).strip(),
            }
            action = 'create_skill'
        from app.services.harness_self_improve import save_proposal
        from app.services.skill_service import (
            SkillValidationError,
            _ensure_canonical_body,
            _validateName,
        )

        name = str(verdict.get('name', '') or verdict.get('skill', '')).strip()
        description = str(verdict.get('description', '')).strip()
        body = str(verdict.get('body_markdown', '')).strip()
        trigger = str(verdict.get('trigger', '')).strip()
        target = name
        try:
            _validateName(name)
        except SkillValidationError as exc:
            logger.info('distiller draft refused: %s', exc)
            return 'rejected-name'
        if _draftExists(fingerprint, action, target):
            return 'duplicate-draft'
        normalized = _ensure_canonical_body(body or description, name=name, description=description or name, is_learned=True)
        try:
            save_proposal(
                problem=f'distiller {action} for fingerprint {fingerprint} (episode {episodeId})',
                evidence=_episodeWindow({'id': episodeId, 'kind': '', 'outcome': '', 'events': verdict.get('events') or []})[:4000]
                or f'flagged fingerprint {fingerprint}',
                proposal=(f'{action}: {name}' + (f' — {description}' if description else ''))[:4000],
                rollback=(
                    f'skill_delete proposal for {name!r} or hand-delete the skill dir; '
                    'the draft never took effect until a human approved it.'
                ),
                kind='skill_create' if action == 'create_skill' else 'skill_patch',
                expected_metric='recurrence stops within 30 days of approval',
                payload={
                    'name': name,
                    'description': description or name,
                    'body': normalized,
                    'trigger': trigger,
                    'fingerprint': fingerprint,
                    'action': action,
                    'target': target,
                    'origin': 'distilled',
                    'episodeIds': [episodeId] if episodeId is not None else [],
                    'supersedes': str(verdict.get('supersedes', '') or ''),
                },
            )
        except ValueError as exc:
            logger.info('distiller draft proposal refused: %s', exc)
            return 'refused'
        # §12 F-10: the fingerprint's status clock starts at ship time, not
        # at the last mined occurrence.
        try:
            from app.services.episode_miner import set_fingerprint_status

            set_fingerprint_status(fingerprint, 'skill_drafted')
        except Exception:
            pass
        return 'proposal-filed'

    if action == 'amend_body':
        # OQ 2: human-authored bodies are off-limits until the precision
        # ship bar is met. §12 F-5: the downgrade MUST NOT file an
        # approvable skill_patch — its payload has no body, and approving
        # that used to overwrite the target SKILL.md with placeholder
        # canonical text. Downgrades are review-only observations.
        state = precision_state()
        skill = str(verdict.get('skill', '')).strip()
        if not state['amendBodyEnabled']:
            if skill and not _draftExists(fingerprint, 'amend_body_downgrade', skill):
                from app.services.harness_self_improve import save_proposal

                save_proposal(
                    problem=f'amend_body downgrade for {skill!r} (precision bar unmet: '
                    f"{state['precision']} over {state['labeled']} labels)",
                    evidence=f'flagged fingerprint {fingerprint}',
                    proposal=str(verdict.get('patch_markdown', ''))[:4000] or 'no patch text',
                    rollback='reject the observation; the existing skill body is untouched.',
                    kind='observation',
                    payload={
                        'name': skill,
                        'fingerprint': fingerprint,
                        # Distinct dedupe key from a GENUINE amend_trigger: the
                        # observation is review-only and must never consume
                        # (fp, 'amend_trigger', skill) — a later real amend
                        # verdict for the same fingerprint+skill would read as
                        # duplicate and be silently dropped. 'amend_body_downgrade'
                        # dedupes this observation against ITSELF across passes
                        # (F-8 re-file suppression preserved).
                        'action': 'amend_body_downgrade',
                        'target': skill,
                        'origin': 'distilled',
                        'note': 'amend_body downgraded — judge precision below ship bar',
                    },
                )
            return 'downgraded-proposal'
        # Ship bar MET (plan §3.3): file a REAL skill_patch — still
        # human-approved, never auto-applied. The judge never sees skill
        # bodies, so ``patch_markdown`` is an amendment to APPEND, not a
        # replacement: the parent merges it onto the current body
        # deterministically (nothing is lost on approval).
        if not skill:
            return 'amend_body-no-target'
        if _isBundledSkill(skill):
            # Bundled skills are never amended in place — fresh draft with
            # supersession lineage, same rule as amend_trigger.
            return apply_verdict(
                {
                    **verdict,
                    'action': 'create_skill',
                    'name': f'{skill}-revised',
                    'supersedes': skill,
                },
                fingerprint,
                mode,
                scope=scope,
            )
        if _draftExists(fingerprint, 'amend_body', skill):
            return 'duplicate-draft'
        current = _learnedSkillText(skill)
        if current is None:
            return 'amend_body-target-missing'
        desc, body = current
        patch = str(verdict.get('patch_markdown', '')).strip()
        if not patch:
            return 'amend_body-empty-patch'
        merged = f'{body}\n\n{patch}'.strip()
        from app.services.harness_self_improve import save_proposal
        from app.services.skill_service import (
            SkillValidationError,
            _ensure_canonical_body,
            _validateName,
        )

        try:
            _validateName(skill)
        except SkillValidationError as exc:
            logger.info('amend_body refused: %s', exc)
            return 'rejected-name'
        normalized = _ensure_canonical_body(merged, name=skill, description=desc or skill, is_learned=True)
        try:
            save_proposal(
                problem=f'amend_body for {skill!r} (episode {episodeId}, precision '
                f"{state['precision']} over {state['labeled']} labels)",
                evidence=f'flagged fingerprint {fingerprint}',
                proposal=f'amend_body: {skill} — appends the amended section to the current body',
                rollback='reject the patch; the current SKILL.md body is untouched until approval.',
                kind='skill_patch',
                expected_metric='recurrence stops within 30 days of approval',
                payload={
                    'name': skill,
                    'description': desc or skill,
                    'body': normalized,
                    'fingerprint': fingerprint,
                    'action': 'amend_body',
                    'target': skill,
                    'origin': 'distilled',
                    'episodeIds': [episodeId] if episodeId is not None else [],
                },
            )
        except ValueError as exc:
            logger.info('amend_body proposal refused: %s', exc)
            return 'refused'
        try:
            from app.services.episode_miner import set_fingerprint_status

            set_fingerprint_status(fingerprint, 'skill_drafted')
        except Exception:
            pass
        return 'patch-proposal-filed'

    return 'none'


# ── the pass (piggybacks the consolidation cadence) ─────────────────────


def run_distiller_pass(dryRun: bool = False) -> dict[str, Any]:
    """One batched judge pass over flagged tier-2 episodes."""
    from app.services.episode_miner import flagged_episodes, set_judge_verdict

    try:
        from app.services.brain_config_service import getRuntimeConfig

        mode = str(getRuntimeConfig().get('skillLearning', 'extract-only') or 'extract-only')
    except Exception:
        mode = 'extract-only'
    if mode == 'off':
        return {'skipped': 'skillLearning=off'}
    if _in_cooldown():
        return {'skipped': 'judge cooldown'}

    flagged = flagged_episodes(limit=50)
    unjudged = [
        ep
        for ep in flagged
        if not str(ep.get('judge_verdict') or '').strip()
    ]
    if not unjudged:
        return {'batches': 0, 'verdicts': 0}

    results: list[dict[str, Any]] = []
    for i in range(0, min(len(unjudged), _BATCH_SIZE * 4), _BATCH_SIZE):
        batch = unjudged[i : i + _BATCH_SIZE]
        if dryRun:
            results.append({'batch': len(batch), 'dryRun': True})
            continue
        verdicts = _run_batch(batch)
        if verdicts is None:
            # Judge failed: log + cooldown — the batch stays tier-2 unjudged
            # and the pass is skipped until the cooldown expires (no retry
            # storms).
            _cooldown_batch(len(batch))
            results.append({'batch': len(batch), 'judgeFailed': True})
            break
        for v in verdicts.get('verdicts', []):
            epId = v.get('episode')
            fpRow = _conn().execute(
                'SELECT fingerprint_id, scope FROM episodes WHERE id = ?', (epId,)
            ).fetchone()
            fp = str(fpRow['fingerprint_id']) if fpRow and fpRow['fingerprint_id'] else 'unknown'
            # Part 26 6.4: the distilled fact lands in the episode's scope —
            # bot-private episodes must not leak lessons into global memory.
            epScope = str(fpRow['scope'] or '') if fpRow and 'scope' in fpRow.keys() else ''
            label = apply_verdict(v, fp, mode, scope=epScope)
            if epId is not None:
                set_judge_verdict(int(epId), json.dumps(v, ensure_ascii=False)[:2000])
            results.append({'episode': epId, 'label': label})
    return {'verdicts': len(results), 'results': results}


def _run_batch(batch: list[dict[str, Any]]) -> dict[str, Any] | None:
    """One judge model call over a batch. None = judge failed."""
    import asyncio

    prompt = build_judge_prompt(batch)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        # §12 F-4: a live loop (e.g. the runCurator API handler) must NOT
        # block on the judge — but it must not silently skip either. Offload
        # to a worker thread that owns a fresh event loop.
        return _run_batch_off_loop(prompt)
    try:
        return asyncio.run(asyncio.wait_for(call_judge(prompt), timeout=_JUDGE_TIMEOUT_S))
    except Exception as exc:
        logger.warning('distiller judge batch failed: %s', exc)
        return None


def _run_batch_off_loop(prompt: str) -> dict[str, Any] | None:
    """Run one judge call on a worker thread (§12 F-4). None = judge failed
    or timed out past the grace window."""
    import asyncio
    import threading

    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box['result'] = asyncio.run(asyncio.wait_for(call_judge(prompt), timeout=_JUDGE_TIMEOUT_S))
        except Exception as exc:
            logger.warning('distiller judge batch failed: %s', exc)
            box['result'] = None

    thread = threading.Thread(target=worker, daemon=True, name='august-distiller-judge')
    thread.start()
    thread.join(_JUDGE_TIMEOUT_S + 15)
    return box.get('result')


def _cooldownKey() -> str:
    return 'skill_distiller_judge_cooldown'


def _in_cooldown() -> bool:
    from app.services.memory_store import get_internal_state

    raw = str(get_internal_state(_cooldownKey()) or '')
    if not raw:
        return False
    try:
        return datetime.fromisoformat(raw) > datetime.now(timezone.utc)
    except Exception:
        return False


def _cooldown_batch(batchSize: int) -> None:
    from app.services.memory_store import record_lifecycle, set_internal_state

    until = datetime.now(timezone.utc) + timedelta(minutes=_JUDGE_COOLDOWN_MIN)
    try:
        set_internal_state(_cooldownKey(), until.isoformat())
        record_lifecycle(
            '',
            'distiller_judge_failed',
            {'batchSize': batchSize, 'cooldownUntil': until.isoformat()},
        )
    except Exception:
        logger.debug('distiller cooldown bookkeeping failed', exc_info=True)
