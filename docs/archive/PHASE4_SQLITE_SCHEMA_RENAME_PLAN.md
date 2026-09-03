# Phase 4 — SQLite schema rename plan

> **Status:** **CLOSED** (2026-07-14) — pass 1 merge + pass 2 camel drop verified
> on live `data/august_brain.sqlite`.
>
> **Hybrid contract:** SQLite tables/columns are **snake_case**; HTTP/JSON wire
> stays **camelCase** via `memory_store._row_as_wire` (`snakeToCamel`). Not dual
> columns; not dual live schemas after pass 2.
>
> **Shipped via:** `schema_rename_migration.py` (migrate + dual merge +
> `drop_legacy_camel_tables`) · snake DDL in `memory_schema.py` · wire conversion
> on read paths.

## Verification (pass 2)

| Check | Result |
|---|---|
| Drop camel tables | 10 dropped; `camel tables left: NONE` |
| `needs_migration` | `False` after drop |
| Spot-check | camel list empty; columns all snake |
| Full pytest (autouse isolation) | 680 passed |
| Snake-side fingerprint | **identical** before/after drop (tables + FTS + `memory_store` blobs) |
| FTS sync | PASS |

Backup before drop: `data/august_brain.sqlite.pre-drop-*`

## Permanent tooling

See `docs/ARCHITECTURE.md` § Brain DB verification tooling.

---

Historical design inventory (tables/columns) remains below for archaeology only.

## 1. Why this was high risk

A full SQLite identifier rename is high-blast-radius work. Touch points included
WIRE TypedDicts, raw SQL strings, FTS/triggers, indexes, startup migrations,
existing user DBs, and tests. Implementation used expand/merge then drop after
explicit verification, not a blind rename.

## 2. Inventory (implemented)

See `schema_rename_migration.TABLE_MAP` / `COLUMN_MAP` and
`memory_schema.create_core_schema` for the live snake_case DDL.
