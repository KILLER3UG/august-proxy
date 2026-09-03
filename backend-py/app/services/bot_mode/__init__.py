"""Bot Mode — desktop-roster bots on the agent registry + canonical chats.

Plan: docs/plans/2026-09-01-bot-mode.md. A Bot is an agent-registry record
plus ``uiMeta`` (title/avatar/hidden/groups) on the same KV blob — no new
runtime entity, no migration. Each Bot owns exactly one canonical Bot Chat
(a workbench session titled ``Bot Chat`` stamped
``metadata.canonicalBotChat=<agentId>``) where routines deliver, teammate
DMs land, and ``/new`` reroutes to compaction (the forever-chat never
forks the relationship).
"""

from app.services.bot_mode import roster, routines

__all__ = ['roster', 'routines']
