"""Netlist text helpers shared by the tools that READ a deck.

Kept out of `circuit_tools` because `schematic` must not import a 4,000-line
module to get one function (and `circuit_tools` does not import `schematic`, so
a home there would invert the dependency). One rule, one place — the same
reasoning that put `listable_root` in `sandbox.paths`.
"""

from __future__ import annotations

_CONTROL_CARDS = ('.control', '.c')
_ENDC_CARDS = ('.endc', '.endc control', 'endc')


def logical_lines(deck_text: str) -> list[str]:
    """Physical lines with every ``+`` continuation folded into the line it
    extends, and nothing else changed.

    A SPICE continuation is not a statement: a line beginning with ``+`` appends
    its tokens to the PREVIOUS card. The deck text still reaches ngspice whole,
    so the simulator sees the full card while every derived view that skipped
    ``+`` lines saw a truncated one — and on a device card the tokens at the end
    are exactly the ones that matter: the model name, and in the 4-terminal forms
    a real net. The symptom is a wire the schematic never drew and a value the
    linter never checked, on a circuit that still simulated correctly, so the two
    readings cannot be told apart from the deck alone.

    Inside a ``.control`` block the lines are simulator commands, not cards, and
    a ``+`` there is left on its own line — merging it would corrupt a command
    that ngspice runs as written.

    Blank lines are preserved (callers count them as block boundaries) and own
    nothing, so a continuation after a blank line stays visible instead of
    silently extending the card before the gap. The first line is the title card,
    which ngspice never parses as an element; it comes back at index 0 as given.
    """
    out: list[str] = []
    owner: int | None = None
    in_control = False
    for raw in deck_text.splitlines():
        s = raw.strip()
        low = s.lower()
        first = low.split(maxsplit=1)[0] if low else ''

        if in_control:
            out.append(s)
            owner = None
            if first in ('.endc', 'endc'):
                in_control = False
            continue

        if s.startswith('+') and owner is not None:
            out[owner] = f'{out[owner]} {s[1:].strip()}'.strip()
            continue

        out.append(s)
        current = len(out) - 1
        if first in _CONTROL_CARDS:
            in_control = True
            owner = None
        elif not s or s.startswith(('*', ';')):
            # A blank line closes the previous card; a comment owns nothing.
            owner = None
        else:
            owner = current
    return out
