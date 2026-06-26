"""
Rough token estimation by character count (chars / 4).
"""


def estimate(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // 4)


def estimate_messages(messages: list[dict]) -> int:
    total = 0
    for msg in messages:
        total += estimate(msg.get("content", "") or "")
    return total
