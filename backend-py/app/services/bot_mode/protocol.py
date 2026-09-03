"""Part 19 Phase C — the Bot-to-Bot messaging protocol text + roster lines.

Pure text/formatting helpers (no DB, no turns) so the prompt-injection gate,
the ``message_agent`` tool description, and the ``POST /dm`` endpoint all
render the SAME doctrine from one place. The containment rules are copied
from the reference design (compose-your-own, never-forward, one-teammate,
no-ping-pong, silence-is-fine) because they are what keep private 1:1 context
from leaking across Bots and what stop two Bots acking each other forever.
"""

from __future__ import annotations

from app.json_narrowing import as_dict, as_str

# Hard cap on a DM body (the reference ships 16 000 chars; a longer message
# is a sign the agent is forwarding a transcript, which the doctrine forbids).
MAX_DM_BODY = 16_000

# The protocol section appended to a canonical Bot Chat's system context —
# ONLY where ``message_agent`` is actually offered (see dm.filter_dm_tools).
MESSAGING_PROTOCOL = (
    '<agent_messaging>\n'
    'You can message other Bots with the message_agent tool. The @ sign in a '
    'user message is ADDRESSING SUGAR, never a delivery mechanism — it only '
    'tells you who the user means. There is exactly one send path: your '
    'message_agent tool.\n'
    'Rules:\n'
    '- Compose your OWN message. Never forward the user\'s words verbatim to '
    'another Bot — paraphrase the intent. This is also what keeps private 1:1 '
    'context from leaking across Bots.\n'
    '- Message ONE relevant teammate per need. Do not broadcast.\n'
    '- No ping-pong acks: do not message a Bot just to say you received its '
    'message. Silence is fine.\n'
    '- Never reveal another Bot\'s private DM content to the user or to a '
    'third Bot.\n'
    '- A DM runs one headless turn in the recipient\'s chat; its reply wakes '
    'you on completion and you relay it to the user, attributed to the '
    'replying Bot.\n'
    '</agent_messaging>'
)

# The composer-middleware identification note (annotation only — it never
# delivers). The frontend appends this server-rendered text; the current
# agent decides whether to act on it.
MENTION_NOTE_TEMPLATE = (
    '[@mentions resolved from the Bot Mode roster — the user is referring to: '
    '{resolved}. If they want one of these agents contacted, compose your own '
    'message and send it with the message_agent tool; never forward the '
    'user\'s text verbatim. If this session has no message_agent tool, agent '
    'messaging is unavailable here — say so.]'
)


def roster_lines() -> list[str]:
    """Live roster as ``- @handle — title — description`` lines.

    Reads the registry (single SoT). Empty description is dropped so lines
    stay tight. Cached upstream by capability epoch (the caller keeps prompt
    bytes stable within a session); this function is the pure render.
    """
    from app.services.bot_mode import roster

    lines: list[str] = []
    for bot in roster.list_bots():
        handle = as_str(bot.get('name'))
        if not handle:
            continue
        ui = as_dict(bot.get('uiMeta'), {})
        title = as_str(ui.get('title')) or handle
        desc = as_str(bot.get('description')).strip()
        if desc:
            lines.append(f'- @{handle} — {title} — {desc}')
        else:
            lines.append(f'- @{handle} — {title}')
    return lines


def roster_block() -> str:
    """The roster rendered for the system prompt (empty string if no peers)."""
    lines = roster_lines()
    if not lines:
        return ''
    return '<bot_roster>\n' + '\n'.join(lines) + '\n</bot_roster>'


def mention_note(resolved: list[tuple[str, str, str]]) -> str:
    """Build the identification note for resolved ``@handle`` mentions.

    ``resolved`` is a list of ``(handle, name, title)`` triples. Returns ''
    when nothing resolved (unknown handles pass through untouched — the user
    text is never rewritten).
    """
    if not resolved:
        return ''
    parts = [
        f'@{handle} = agent profile "{name}" ("{title}")'
        for handle, name, title in resolved
    ]
    return MENTION_NOTE_TEMPLATE.format(resolved='; '.join(parts))
