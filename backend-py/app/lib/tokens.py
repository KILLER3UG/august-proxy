"""
Rough token estimation by character count (chars / 4).
"""


def estimate(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // 4)


def estimateMessages(messages: list[dict[str, object]]) -> int:
    total = 0
    for msg in messages:
        total += estimate(str(msg.get('content', '') or ''))
    return total
