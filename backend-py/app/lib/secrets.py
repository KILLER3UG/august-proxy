"""
Mask API keys and other secrets for safe display.

This is DISPLAY, not storage — a masked preview is not a secret store.
Storage lives in ``app/services/secret_store.py``: the encrypted store
(Windows DPAPI, in the user's data directory) that holds the service
connection tokens. ``app/lib/dpapi.py`` is the binding it sits on.
"""


def mask(value: str, visible: int = 4) -> str | None:
    """Show last `visible` chars, mask the rest."""
    if not value:
        return None
    if len(value) <= visible:
        return '••••' + value
    return value[:3] + '••••••••' + value[-visible:]
