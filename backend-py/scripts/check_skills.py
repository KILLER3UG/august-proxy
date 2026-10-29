"""Static gate: every bundled SKILL.md is a skill the loader can discover.

The loader skips a malformed SKILL.md with a logged warning so one bad file
never stops its siblings. That is the right runtime behaviour, but it means a
bundled skill can disappear from the catalogue — and from the model's prompt —
with nothing red. This gate runs the SAME parser over the SAME walker and fails
when a bundled file would be skipped, when its frontmatter name does not match
its directory (``createSkill`` and the usage sidecar both key on that name), or
when two bundled skills share a name (``list_all`` would silently keep the
first). It never calls ``list_all``: that call runs the flat-skill migration,
which rewrites root-level markdown into skill directories — a gate must not
write the tree it is checking.

Usage:
    cd backend-py && python scripts/check_skills.py
    # or from the repo root: npm run check:skills
"""

from __future__ import annotations

import atexit
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'backend-py'))


class _Capture(logging.Handler):
    """Hold the loader's own refusal reason for the file being parsed."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


def main() -> int:
    # Never read or write the user's real data directory. The gate only needs
    # the bundled root, but importing the service reads the configured data dir
    # for the agent root, so point it at a throwaway directory first.
    data_dir = Path(tempfile.mkdtemp(prefix='august-check-skills-'))
    os.environ['AUGUST_DATA_DIR'] = str(data_dir)
    atexit.register(lambda: shutil.rmtree(data_dir, ignore_errors=True))

    from app.services import skill_service

    root = skill_service.SKILLS_DIR
    if not root.is_dir():
        print(f'error: bundled skills root does not exist: {root}')
        return 2

    files = sorted(skill_service._iterSkillMd(root))
    if not files:
        print(f'error: the skill walker found no SKILL.md under {root}')
        return 1
    walkCap = int(getattr(skill_service, '_SKILL_WALK_MAX_FILES', 0) or 0)
    if walkCap and len(files) >= walkCap:
        # The walker truncates at this cap and logs a warning. A gate that
        # silently certifies a subset is worse than one that says it cannot see
        # the whole tree.
        print(
            f'error: the skill walker hit its {walkCap}-file cap; '
            'the gate cannot certify the whole bundled tree.'
        )
        return 1

    capture = _Capture()
    logger = skill_service.logger
    previous_level = logger.level
    logger.addHandler(capture)
    logger.setLevel(logging.WARNING)

    errors: list[str] = []
    names: dict[str, str] = {}
    try:
        for path in files:
            rel = path.relative_to(root).as_posix()
            capture.messages.clear()
            parsed = skill_service._parseSkill(path)
            if parsed is None:
                reason = capture.messages[-1] if capture.messages else 'loader returned None'
                errors.append(f'{rel}: loader rejected it ({reason})')
                continue
            name = str(parsed.get('name') or '')
            directory = path.parent.name
            if name != directory:
                errors.append(
                    f'{rel}: frontmatter name {name!r} does not match directory {directory!r}'
                )
            if name in names:
                errors.append(f'{rel}: duplicate skill name {name!r} (also in {names[name]})')
            else:
                names[name] = rel
    finally:
        logger.removeHandler(capture)
        logger.setLevel(previous_level)

    # Cross-check what the loader would DISCOVER, not just what it parses. Do
    # not call `skill_service.list_all` here: its first call runs
    # `migrate_flat_skills`, which REWRITES root-level `*.md` files into skill
    # directories. A static gate must not mutate the tree. The two skip rules
    # that matter are already enforced above: the parser rejects an invalid
    # name, and the duplicate check catches the other reason `list_all` drops
    # an entry.
    if errors:
        for error in errors:
            print(f'error: {error}')
        print(f'\ncheck:skills: {len(errors)} problem(s) across {len(files)} SKILL.md file(s).')
        return 1

    print(
        f'check:skills: {len(files)} SKILL.md file(s), '
        f'{len(names)} bundled skill(s): {", ".join(sorted(names))}'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
