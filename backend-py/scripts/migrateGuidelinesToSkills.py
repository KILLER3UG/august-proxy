"""Migration script: port learned guidelines into agent-authored skills.

Reads guidelines from the ``learned_guidelines`` KV store, creates one skill
per guideline (or merges by category), then clears the KV store.
Run once::

    cd backend-py
    python scripts/migrate_guidelines_to_skills.py

Environment: set AUGUST_DATA_DIR if needed (default: <project>/data).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> None:
    from app.services import skill_service
    from app.services.memory_store import get_memory, save_memory

    GUIDELINES_KEY = 'learned_guidelines'
    guidelines = get_memory(GUIDELINES_KEY) or []
    if not isinstance(guidelines, list):
        guidelines = []
    if not guidelines:
        print('No learned guidelines found. Nothing to migrate.')
        return
    active = [g for g in guidelines if g.get('active', True)]
    print(f'Found {len(active)} active guidelines (of {len(guidelines)} total).')
    created = 0
    errors = []
    for g in active:
        text = (g.get('text') or '').strip()
        if not text:
            continue
        name = _textToName(text)
        description = text[:55].rstrip('.') + '.'
        body = f'## When to Use\n\nUser correction: {text}\n\n## Procedure\n\n1. Apply this lesson.\n'
        category = (g.get('category') or 'learned').strip()
        try:
            if skill_service.get(name):
                existing = skill_service.get(name)
                newBody = existing['instructions'] + f'\n- {text}'
                skill_service.patch_skill(name, body=newBody)
                print(f"  Merged into existing skill '{name}'")
            else:
                skill_service.create_skill(name, description, body, trigger='', category=category)
                print(f"  Created skill '{name}'")
            created += 1
        except Exception as exc:
            msg = f"  Failed to migrate '{text[:50]}': {exc}"
            print(msg)
            errors.append(msg)
    if not errors:
        save_memory(GUIDELINES_KEY, [])
        print(f'Cleared {GUIDELINES_KEY} store. All {created} guidelines migrated.')
    else:
        print(f'Migrated {created} guidelines with {len(errors)} errors. KV store NOT cleared.')


def _textToName(text: str) -> str:
    """Convert a guideline text to a valid skill name."""
    name = text.lower().strip()
    import re

    name = re.sub('[^a-z0-9.\\s-]', '', name)
    parts = [p for p in name.split() if p]
    name = '.'.join(parts[:4]) if len(parts) > 4 else '.'.join(parts)
    if len(name) > 60:
        name = name[:60].rstrip('-.')
    return name or 'guideline'


if __name__ == '__main__':
    main()
