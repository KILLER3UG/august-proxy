#!/usr/bin/env python3
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

# Ensure the backend-py package is importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> None:
    from app.services.memory_store import get_memory, save_memory
    from app.services import skill_service

    GUIDELINES_KEY = "learned_guidelines"
    guidelines = get_memory(GUIDELINES_KEY) or []
    if not isinstance(guidelines, list):
        guidelines = []

    if not guidelines:
        print("No learned guidelines found. Nothing to migrate.")
        return

    active = [g for g in guidelines if g.get("active", True)]
    print(f"Found {len(active)} active guidelines (of {len(guidelines)} total).")

    created = 0
    errors = []

    for g in active:
        text = (g.get("text") or "").strip()
        if not text:
            continue

        name = _text_to_name(text)
        description = text[:55].rstrip(".") + "."  # ≤60 chars
        # Build a minimal SKILL.md body
        body = (
            f"## When to Use\n\n"
            f"User correction: {text}\n\n"
            f"## Procedure\n\n"
            f"1. Apply this lesson.\n"
        )
        category = (g.get("category") or "learned").strip()

        try:
            if skill_service.get(name):
                # Merge text into existing skill body.
                existing = skill_service.get(name)
                new_body = existing["instructions"] + f"\n- {text}"
                skill_service.patch_skill(name, body=new_body)
                print(f"  Merged into existing skill '{name}'")
            else:
                skill_service.create_skill(
                    name, description, body,
                    trigger="", category=category,
                )
                print(f"  Created skill '{name}'")
            created += 1
        except Exception as exc:
            msg = f"  Failed to migrate '{text[:50]}': {exc}"
            print(msg)
            errors.append(msg)

    # Clear the old guidelines store (only on success).
    if not errors:
        save_memory(GUIDELINES_KEY, [])
        print(f"Cleared {GUIDELINES_KEY} store. All {created} guidelines migrated.")
    else:
        print(f"Migrated {created} guidelines with {len(errors)} errors. KV store NOT cleared.")


def _text_to_name(text: str) -> str:
    """Convert a guideline text to a valid skill name."""
    # Lowercase, strip to first meaningful words, replace spaces with dots.
    name = text.lower().strip()
    # Remove punctuation except dots/hyphens.
    import re

    name = re.sub(r"[^a-z0-9.\s-]", "", name)
    # Keep first 3-4 meaningful words, limit to 64.
    parts = [p for p in name.split() if p]
    name = ".".join(parts[:4]) if len(parts) > 4 else ".".join(parts)
    if len(name) > 60:
        name = name[:60].rstrip("-.")
    return name or "guideline"


if __name__ == "__main__":
    main()
