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
from typing import Any, Optional

from app.services import skill_service

log = logging.getLogger(__name__)

# ── Lifecycle thresholds ──────────────────────────────────────────────

_STALE_AFTER_DAYS = 14       # no activity → stale
_ARCHIVE_AFTER_DAYS = 60     # stale + no activity → archiveable
_CURATION_INTERVAL_SECONDS = 3600  # how often to auto-curate

# Sidecar filename inside the data / skills dir.
_USAGE_FILENAME = ".usage.json"

# Provenance tag used by the authoring surface (C1).
_AGENT_CREATED_TAG = "agent"


# ── Usage record ──────────────────────────────────────────────────────


@dataclass
class UsageRecord:
    name: str
    use_count: int = 0
    view_count: int = 0
    patch_count: int = 0
    last_used_at: Optional[float] = None
    last_viewed_at: Optional[float] = None
    last_patched_at: Optional[float] = None
    state: str = "active"  # active | stale | archived
    pinned: bool = False
    archived_at: Optional[float] = None


class SkillCurator:
    """Manages the sidecar usage file and lifecycle transitions."""

    def __init__(self, data_dir: Path | str | None = None) -> None:
        if data_dir is None:
            try:
                from app.config import settings

                data_dir = Path(settings.data_dir)
            except Exception:
                data_dir = Path.cwd()
        self._usage_path = Path(data_dir) / "skills" / _USAGE_FILENAME
        self._usage: dict[str, UsageRecord] = {}
        self._load()

    # ── I/O ───────────────────────────────────────────────────────────

    def _load(self) -> None:
        try:
            if self._usage_path.exists():
                raw = json.loads(self._usage_path.read_text("utf-8"))
                if isinstance(raw, dict):
                    self._usage = {
                        k: UsageRecord(**v) for k, v in raw.items()
                    }
        except Exception as exc:
            log.warning("curator: could not load usage: %s", exc)

    def _save(self) -> None:
        try:
            self._usage_path.parent.mkdir(parents=True, exist_ok=True)
            raw = {
                k: {
                    "name": v.name,
                    "use_count": v.use_count,
                    "view_count": v.view_count,
                    "patch_count": v.patch_count,
                    "last_used_at": v.last_used_at,
                    "last_viewed_at": v.last_viewed_at,
                    "last_patched_at": v.last_patched_at,
                    "state": v.state,
                    "pinned": v.pinned,
                    "archived_at": v.archived_at,
                }
                for k, v in self._usage.items()
            }
            tmp = self._usage_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(raw, indent=2), "utf-8")
            tmp.replace(self._usage_path)
        except Exception as exc:
            log.warning("curator: could not save usage: %s", exc)

    # ── Telemetry bumps ──────────────────────────────────────────────

    def bump_use(self, name: str) -> None:
        rec = self._ensure(name)
        rec.use_count += 1
        rec.last_used_at = time.time()
        self._save()

    def bump_view(self, name: str) -> None:
        rec = self._ensure(name)
        rec.view_count += 1
        rec.last_viewed_at = time.time()
        self._save()

    def bump_patch(self, name: str) -> None:
        rec = self._ensure(name)
        rec.patch_count += 1
        rec.last_patched_at = time.time()
        self._save()

    def _ensure(self, name: str) -> UsageRecord:
        if name not in self._usage:
            self._usage[name] = UsageRecord(name=name)
        return self._usage[name]

    # ── Queries ──────────────────────────────────────────────────────

    def get_record(self, name: str) -> Optional[UsageRecord]:
        return self._usage.get(name)

    def list_usage(self) -> list[dict[str, Any]]:
        return [
            {
                "name": v.name,
                "use_count": v.use_count,
                "view_count": v.view_count,
                "patch_count": v.patch_count,
                "last_used_at": v.last_used_at,
                "state": v.state,
                "pinned": v.pinned,
                "archived_at": v.archived_at,
            }
            for v in sorted(self._usage.values(), key=lambda r: r.last_used_at or 0, reverse=True)
        ]

    # ── Lifecycle operations ─────────────────────────────────────────

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
        # Physically move the skill dir to an .archive subdir.
        agent_skills_base = skill_service._agent_skills_dir()
        skill_dir = agent_skills_base / name
        archive_base = agent_skills_base / ".archive"
        if skill_dir.exists():
            import shutil

            archive_base.mkdir(parents=True, exist_ok=True)
            target = archive_base / name
            shutil.move(str(skill_dir), str(target))
        rec.state = "archived"
        rec.archived_at = time.time()
        self._save()
        return True

    def restore(self, name: str) -> bool:
        """Restore an archived skill back to the agent root."""
        agent_skills_base = skill_service._agent_skills_dir()
        archive_dir = agent_skills_base / ".archive" / name
        if not archive_dir.exists():
            return False
        import shutil

        target = agent_skills_base / name
        shutil.move(str(archive_dir), str(target))
        rec = self._ensure(name)
        rec.state = "active"
        rec.archived_at = None
        self._save()
        return True

    def _is_agent_skill(self, name: str) -> bool:
        sk = skill_service.get(name)
        if not sk:
            return False
        return sk.get("created_by", "") == _AGENT_CREATED_TAG

    # ── Curation run ─────────────────────────────────────────────────

    def run_curation(self, dry_run: bool = False) -> dict[str, Any]:
        """Iterate all agent-authored skills and transition stale / archiveable ones.

        Returns a report dict::

            {"active": N, "staled": [...], "archived": [...], "errors": [...]}
        """
        now = time.time()
        report: dict[str, Any] = {"active": 0, "staled": [], "archived": [], "errors": []}

        for skill in skill_service.list_all():
            if skill.get("created_by", "") != _AGENT_CREATED_TAG:
                continue
            name = skill["name"]
            rec = self._ensure(name)
            if rec.pinned:
                report["active"] += 1
                continue

            last_activity = max(
                rec.last_used_at or 0,
                rec.last_viewed_at or 0,
                rec.last_patched_at or 0,
            )
            if not last_activity:
                # No activity recorded; use skill file mtime.
                last_activity = skill.get("updatedAt", now)

            days_idle = (now - last_activity) / 86400

            if rec.state == "active" and days_idle >= _STALE_AFTER_DAYS:
                if not dry_run:
                    rec.state = "stale"
                    self._save()
                report["staled"].append(name)
            elif rec.state == "stale" and days_idle >= _ARCHIVE_AFTER_DAYS:
                if not dry_run:
                    self.archive(name)
                report["archived"].append(name)
            else:
                report["active"] += 1

        return report


def make_background_curator(data_dir: Path | None = None) -> tuple[SkillCurator, asyncio.Task]:
    """Create a curator and start its background curation loop.

    Returns (curator, task) — caller should cancel the task on shutdown.
    """
    curator = SkillCurator(data_dir=data_dir)

    async def _loop() -> None:
        while True:
            try:
                report = curator.run_curation()
                if report.get("staled") or report.get("archived"):
                    log.info("curator ran: %s", {k: v for k, v in report.items() if v})
            except Exception as exc:
                log.warning("curator: curation run failed: %s", exc)
            await asyncio.sleep(_CURATION_INTERVAL_SECONDS)

    task = asyncio.create_task(_loop())
    return curator, task
