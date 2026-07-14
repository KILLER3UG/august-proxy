"""Skill curator — lifecycle management for agent-authored skills.

Modeled on Hermes ``agent/curator.py`` (skill maintenance) + ``tools/skill_usage.py``
(usage telemetry).  Only touches skills with ``created_by: "agent"`` provenance;
never deletes (archives only); pinned skills are exempt from every auto-transition.
"""

from __future__ import annotations
import asyncio
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from app.services import skill_service
from app.json_narrowing import as_str, as_list, as_int, as_float

log = logging.getLogger(__name__)
_STALEAfterDays = 14
_ARCHIVEAfterDays = 60
_CURATIONIntervalSeconds = 3600
_USAGEFilename = '.usage.json'
_AGENTCreatedTag = 'agent'


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
        rec = self._ensure(name)
        rec.useCount += 1
        rec.lastUsedAt = time.time()
        self._save()

    def bump_view(self, name: str) -> None:
        rec = self._ensure(name)
        rec.viewCount += 1
        rec.lastViewedAt = time.time()
        self._save()

    def bump_patch(self, name: str) -> None:
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
        rec = self._ensure(name)
        rec.pinned = True
        self._save()
        return True

    def unpin(self, name: str) -> bool:
        rec = self._usage.get(name)
        if not rec:
            return False
        rec.pinned = False
        self._save()
        return True

    def archive(self, name: str) -> bool:
        """Move to the archive dir (never deletes).  Only agent-authored."""
        if not self._is_agent_skill(name):
            return False
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
        return True

    def restore(self, name: str) -> bool:
        """Restore an archived skill back to the agent root."""
        agentSkillsBase = skill_service._agentSkillsDir()
        archiveDir = agentSkillsBase / '.archive' / name
        if not archiveDir.exists():
            return False
        import shutil

        target = agentSkillsBase / name
        shutil.move(str(archiveDir), str(target))
        rec = self._ensure(name)
        rec.state = 'active'
        rec.archivedAt = None
        self._save()
        return True

    def _is_agent_skill(self, name: str) -> bool:
        sk = skill_service.get(name)
        if not sk:
            return False
        return sk.get('created_by', '') == _AGENTCreatedTag

    def run_curation(self, dryRun: bool = False) -> dict[str, object]:
        """Iterate all agent-authored skills and transition stale / archiveable ones.

        Returns a report dict::

            {"active": N, "staled": [...], "archived": [...], "errors": [...]}
        """
        now = time.time()
        report: dict[str, object] = {'active': 0, 'staled': [], 'archived': [], 'errors': []}
        for skill in skill_service.list_all():
            if as_str(skill.get('created_by'), '') != _AGENTCreatedTag:
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
            else:
                report['active'] = as_int(report['active'], 0) + 1
        return report


def make_background_curator(dataDir: Path | None = None) -> tuple[SkillCurator, asyncio.Task]:
    """Create a curator and start its background curation loop.

    Returns (curator, task) — caller should cancel the task on shutdown.
    """
    curator = SkillCurator(dataDir=dataDir)

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
