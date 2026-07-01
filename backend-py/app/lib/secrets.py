"""
Mask API keys and other secrets for safe display.
"""

def mask(value: str, visible: int=4) -> str | None:
    """Show last `visible` chars, mask the rest."""
    if not value:
        return None
    if len(value) <= visible:
        return '••••' + value
    return value[:3] + '••••••••' + value[-visible:]