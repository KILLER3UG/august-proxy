-- 044: facts.description — the ZCode-parity recall hook (2026-09-12).
-- One-line "where this memory applies" summary, used for the boot-index
-- hook line and BM25 relevance text, mirroring the project-file
-- frontmatter description. memory_schema.ensure_column carries the same
-- ALTER on the fast path, so this fails (recorded, swallowed) on DBs that
-- already have it — same belt-and-suspenders pattern as 032_facts_scope.
ALTER TABLE facts ADD COLUMN description TEXT DEFAULT '';
