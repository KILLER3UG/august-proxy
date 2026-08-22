"""Skill curator — lifecycle management for agent-authored skills.

Modeled on Hermes ``agent/curator.py`` (skill maintenance) + ``tools/skill_usage.py``
(usage telemetry).  Only touches skills with ``created_by: "agent"`` provenance;
never deletes (archives only); pinned skills are exempt from every auto-transition.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.json_narrowing import as_float, as_int, as_list, as_str
from app.services import skill_service

log = logging.getLogger(__name__)
_STALEAfterDays = 14
_ARCHIVEAfterDays = 60
_CURATIONIntervalSeconds = 3600
_USAGEFilename = '.usage.json'
_AGENTCreatedTag = 'agent'
_EVOLVINGCreatedTags = frozenset({'agent', 'auto-gen'})


@dataclass
class SkillUsageRecord:
    """Per-skill telemetry sidecar row (not the HTTP ``UsageRecord`` body)."""

    name: str
    useCount: int = 0
    viewCount: int = 0
    patchCount: int = 0
    lastUsedAt: Optional[float] = None
    lastViewedAt: Optional[float] = None
    lastPatchedAt: Optional[float] = None
    state: str = 'active'
    pinned: bool = False
    archivedAt: Optional[float] = None


class SkillCurator:
    """Manages the sidecar usage file and lifecycle transitions."""

    def __init__(self, dataDir: Path | str | None = None) -> None:
        if dataDir is None:
            try:
                from app.config import settings

                dataDir = Path(settings.dataDir)
            except Exception:
                dataDir = Path.cwd()
        self._usagePath = Path(dataDir) / 'skills' / _USAGEFilename
        # RLock: bump_* → _ensure → (save) recurse on the same thread; the
        # lock serializes read-modify-write cycles against concurrent tool
        # bumps from other threads, which previously lost increments because
        # every caller constructed a fresh instance from the sidecar file.
        self._mutex = threading.RLock()
        self._usage: dict[str, SkillUsageRecord] = {}
        self._load()

    def _load(self) -> None:
        try:
            if self._usagePath.exists():
                raw = json.loads(self._usagePath.read_text('utf-8'))
                if isinstance(raw, dict):
                    self._usage = {k: SkillUsageRecord(**v) for k, v in raw.items()}
        except Exception as exc:
            log.warning('curator: could not load usage: %s', exc)

    def _save(self) -> None:
        try:
            self._usagePath.parent.mkdir(parents=True, exist_ok=True)
            raw = {
                k: {
                    'name': v.name,
                    'useCount': v.useCount,
                    'viewCount': v.viewCount,
                    'patchCount': v.patchCount,
                    'lastUsedAt': v.lastUsedAt,
                    'lastViewedAt': v.lastViewedAt,
                    'lastPatchedAt': v.lastPatchedAt,
                    'state': v.state,
                    'pinned': v.pinned,
                    'archivedAt': v.archivedAt,
                }
                for k, v in self._usage.items()
            }
            tmp = self._usagePath.with_suffix('.tmp')
            tmp.write_text(json.dumps(raw, indent=2), 'utf-8')
            tmp.replace(self._usagePath)
        except Exception as exc:
            log.warning('curator: could not save usage: %s', exc)

    def bump_use(self, name: str) -> None:
        with self._mutex:
            rec = self._ensure(name)
            rec.useCount += 1
            rec.lastUsedAt = time.time()
            self._save()

    def bump_view(self, name: str) -> None:
        with self._mutex:
            rec = self._ensure(name)
            rec.viewCount += 1
            rec.lastViewedAt = time.time()
            self._save()

    def bump_patch(self, name: str) -> None:
        with self._mutex:
            rec = self._ensure(name)
            rec.patchCount += 1
            rec.lastPatchedAt = time.time()
            self._save()

    def _ensure(self, name: str) -> SkillUsageRecord:
        if name not in self._usage:
            self._usage[name] = SkillUsageRecord(name=name)
        return self._usage[name]

    def get_record(self, name: str) -> Optional[SkillUsageRecord]:
        return self._usage.get(name)

    def list_usage(self) -> list[dict[str, object]]:
        return [
            {
                'name': v.name,
                'useCount': v.useCount,
                'viewCount': v.viewCount,
                'patchCount': v.patchCount,
                'lastUsedAt': v.lastUsedAt,
                'state': v.state,
                'pinned': v.pinned,
                'archivedAt': v.archivedAt,
            }
            for v in sorted(self._usage.values(), key=lambda r: r.lastUsedAt or 0, reverse=True)
        ]

    def pin(self, name: str) -> bool:
        """Pin a skill (exempt from auto-transitions).  Only agent-authored."""
        if not self._is_agent_skill(name):
            return False
        with self._mutex:
            rec = self._ensure(name)
            rec.pinned = True
            self._save()
        return True

    def unpin(self, name: str) -> bool:
        rec = self._usage.get(name)
        if not rec:
            return False
        if not self._is_agent_skill(name):
            # Provenance gate: builtin skills can never be unpinned through
            # the curator (they were never agent-pinned in the first place).
            return False
        with self._mutex:
            rec.pinned = False
            self._save()
        return True

    @staticmethod
    def _is_safe_skill_name(name: str) -> bool:
        """Reject names that could escape the agent skills root (path traversal).

        Frontmatter ``name`` is unvalidated user input; ``archive``/``restore``
        build filesystem paths from it, so ``..``, separators and absolute
        paths must be refused before any move.
        """
        if not isinstance(name, str) or not name.strip():
            return False
        if name != name.strip():
            return False
        if name in ('.', '..'):
            return False
        if name.startswith('.'):
            return False
        if '/' in name or '\\' in name:
            return False
        if os.path.isabs(name) or Path(name).is_absolute():
            return False
        return True

    def archive(self, name: str) -> bool:
        """Move to the archive dir (never deletes).  Only agent-authored."""
        if not self._is_safe_skill_name(name):
            return False
        if not self._is_agent_skill(name):
            return False
        with self._mutex:
            rec = self._ensure(name)
            if rec.pinned:
                return False
            agentSkillsBase = skill_service._agentSkillsDir()
            skillDir = agentSkillsBase / name
            archiveBase = agentSkillsBase / '.archive'
            if skillDir.exists():
                import shutil

                archiveBase.mkdir(parents=True, exist_ok=True)
                target = archiveBase / name
                shutil.move(str(skillDir), str(target))
            rec.state = 'archived'
            rec.archivedAt = time.time()
            self._save()
        try:
            from app.services.memory.curation_ledger import record as _ledger

            _ledger('curator', 'archive_skill', 'skill', name, reason='lifecycle transition')
        except Exception:
            pass
        return True

    def restore(self, name: str) -> bool:
        """Restore an archived skill back to the agent root."""
        if not self._is_safe_skill_name(name):
            return False
        if not self._is_agent_skill(name, archived=True):
            return False
        agentSkillsBase = skill_service._agentSkillsDir()
        archiveDir = agentSkillsBase / '.archive' / name
        if not archiveDir.exists():
            return False
        import shutil

        with self._mutex:
            target = agentSkillsBase / name
            shutil.move(str(archiveDir), str(target))
            rec = self._ensure(name)
            rec.state = 'active'
            rec.archivedAt = None
            self._save()
        return True

    def _is_agent_skill(self, name: str, *, archived: bool = False) -> bool:
        sk = skill_service.get(name)
        if not sk and archived:
            # An archived skill is outside the discoverable roots — read its
            # SKILL.md directly so provenance survives the archive move.
            md = skill_service._agentSkillsDir() / '.archive' / name / 'SKILL.md'
            try:
                sk = skill_service._parseSkill(md)
            except Exception:
                sk = None
        if not sk:
            return False
        return as_str(sk.get('created_by'), '') in _EVOLVINGCreatedTags

    def run_curation(self, dryRun: bool = False) -> dict[str, object]:
        """Iterate all agent-authored skills and transition stale / archiveable ones.

        Returns a report dict::

            {"active": N, "staled": [...], "archived": [...], "errors": [...]}
        """
        now = time.time()
        report: dict[str, object] = {'active': 0, 'staled': [], 'archived': [], 'errors': []}
        with self._mutex:
            for skill in skill_service.list_all():
                if as_str(skill.get('created_by'), '') not in _EVOLVINGCreatedTags:
                    continue
                name = as_str(skill['name'], '')
                rec = self._ensure(name)
                if rec.pinned:
                    report['active'] = as_int(report['active'], 0) + 1
                    continue
                lastActivity = max(rec.lastUsedAt or 0, rec.lastViewedAt or 0, rec.lastPatchedAt or 0)
                if not lastActivity:
                    lastActivity = as_float(skill.get('updatedAt'), float(now))
                daysIdle = (now - lastActivity) / 86400
                if rec.state == 'active' and daysIdle >= _STALEAfterDays:
                    if not dryRun:
                        rec.state = 'stale'
                        self._save()
                    staled = as_list(report['staled'], [])
                    staled.append(name)
                elif rec.state == 'stale' and daysIdle >= _ARCHIVEAfterDays:
                    if not dryRun:
                        self.archive(name)
                    archived = as_list(report['archived'], [])
                    archived.append(name)
                elif rec.state == 'stale' and daysIdle < _STALEAfterDays:
                    # Used again after going stale: revive so the 60-day sweep
                    # doesn't archive a skill that is actively being used.
                    if not dryRun:
                        rec.state = 'active'
                        self._save()
                    report['active'] = as_int(report['active'], 0) + 1
                else:
                    report['active'] = as_int(report['active'], 0) + 1
        return report


_SHARED_INIT_LOCK = threading.Lock()
_shared: Optional['SkillCurator'] = None


def shared_curator() -> 'SkillCurator':
    """Process-wide curator instance for telemetry bumps and lifecycle moves.

    Ad-hoc ``SkillCurator()`` construction re-read ``.usage.json`` on every
    bump, so concurrent tool calls raced on read-modify-write cycles and lost
    increments. Reuse the runtime-services background instance when one
    exists; otherwise create (and memoize) a plain one.
    """
    global _shared
    with _SHARED_INIT_LOCK:
        if _shared is not None:
            return _shared
        try:
            from app.services import runtime_services

            existing = getattr(runtime_services, '_curator', None)
            if isinstance(existing, SkillCurator):
                _shared = existing
                return _shared
        except Exception:
            pass
        _shared = SkillCurator()
        return _shared


def make_background_curator(dataDir: Path | None = None) -> tuple[SkillCurator, asyncio.Task]:
    """Create a curator and start its background curation loop.

    Returns (curator, task) — caller should cancel the task on shutdown.
    The instance is also registered as the process-wide shared curator so
    tool bumps and the curation loop share one telemetry view.
    """
    global _shared
    curator = SkillCurator(dataDir=dataDir)
    with _SHARED_INIT_LOCK:
        _shared = curator

    async def _loop() -> None:
        while True:
            try:
                report = curator.run_curation()
                if report.get('staled') or report.get('archived'):
                    log.info('curator ran: %s', {k: v for k, v in report.items() if v})
            except Exception as exc:
                log.warning('curator: curation run failed: %s', exc)
            await asyncio.sleep(_CURATIONIntervalSeconds)

    task = asyncio.create_task(_loop())
    return (curator, task)
