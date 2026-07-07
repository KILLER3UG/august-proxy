"""
database.py — REMOVED IN PHASE 0.

SQLAlchemy + aiosqlite were dead code: Base.metadata.create_all ran on
every startup but no ORM models existed. All persistence is handled by
memory_store.py (august_brain.sqlite) directly.

See docs/design/cognitive-architecture-v1.md §6 Phase 0.
"""