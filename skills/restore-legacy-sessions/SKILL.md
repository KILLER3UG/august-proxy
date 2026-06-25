---
name: restore-legacy-sessions
description: "Restore legacy ACP-era sessions from snapshot files into the current session store."
category: meta
trigger: "restoring old sessions from legacy storage"
version: 1.0.0
author: August Proxy
license: MIT
---

# Restore Legacy Sessions

## Overview

Restore old ACP-era session data from legacy snapshot files into the current session store. The process is selection-first: choose an agent, then a workspace, then a conversation — no writes happen until the user confirms.

> **Environment-specific:** This skill is designed for migrating from ACP-era ZCode session storage. The specific scripts and paths referenced may not apply to your environment. Adapt paths and tools as needed.

## Workflow

### Phase 1: Select Source

Let the user choose what to restore:

1. **Choose agent** — List the available source agent snapshots
2. **Choose workspace** — For the selected agent, show their workspaces
3. **Choose conversation** — For the selected workspace, show available conversations with:
   - Title
   - Last updated time
   - Message count
   - Current restore state (already restored, ready to restore, needs preparation)

### Phase 2: Preview

Before any writes:
- Do a dry run to show exactly what will be restored
- Show the conversation summary so the user can confirm it's the right one
- Explain any issues (missing data, format mismatches, etc.)

### Phase 3: Apply

Only after preview confirmation:
- Restore the conversation
- Verify the restored data is complete and accessible
- Update the restore state so the same conversation won't be restored twice

### Mutation Rules

- Always create backups before modifying state
- Keep operations idempotent — running twice produces the same result
- Never overwrite existing user continuation messages
- Mark restored conversations clearly so they can be identified

## States

| State | Meaning |
|-------|---------|
| **Ready** | Can be restored directly |
| **Needs database** | Target session store needs initialization |
| **Needs index** | Task index needs to be updated |
| **Already restored** | Previously restored, skip |
