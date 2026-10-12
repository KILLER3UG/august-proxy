"""Netlist text helpers shared by the tools that READ a deck.

Kept out of `circuit_tools` because `schematic` must not import a 4,000-line
module to get one function (and `circuit_tools` does not import `schematic`, so
a home there would invert the dependency). One rule, one place — the same
reasoning that put `listable_root` in `sandbox.paths`.
"""

from __future__ import annotations

_CONTROL_CARDS = ('.control', '.c')


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


def card_value(parts: list[str], need: int) -> str:
    """The value/model token of a device card, or '' when the card carries none.

    `parts` is the whole card and `need` the node count its class declares, so
    the tokens after the nodes are what is left. Taking the FIRST of them (what
    the component listing did) reads the keyword as the value: `V1 in 0 DC 9` is
    a 9 V source and the listing said `DC`. Taking the LAST token of the card
    (what the linter did first) reads a model parameter as the value:
    `R1 out n2 1k tc=0,0.002` is 1 kΩ and the linter told the user their
    resistor "does not parse as a SPICE number" — a false error on a deck that
    simulates, on the one surface whose job is to catch real ones.

    The last token that is not `k=v` is right for both, and for the classes whose
    tail is a MODEL rather than a number (`M1 d g s b mm`, `X1 a b BLOCK`) it
    returns that model, which is what the listing has always shown there.

    A whitespace-split card cannot name a waveform argument (`SIN(0 1 1k)` is
    three tokens); no positional rule can fix that, and neither reader claims to.
    """
    positional = [t for t in parts[1 + need:] if '=' not in t]
    return positional[-1] if positional else ''


def device_cards(deck_text: str, *, skip_title: bool = True) -> list[str]:
    """The lines of a deck that are DEVICE CARDS — one rule, every reader.

    Four functions each decided independently which lines to look at, and every
    one got a different answer: `.subckt` private parts were counted as
    top-level components (`R2` inside a filter block appeared in the component
    list next to the real parts), `.control` commands were read as devices
    (`print v(out)` became a P-device with no nodes), the SPICE title line — which
    ngspice never parses as an element — became an `M` MOSFET when a deck began
    `My demo circuit`, and a `;` comment was a card. Each of those invents a part
    that is in no circuit, in a view the user reads as the circuit.

    Continuations are joined first (see `logical_lines`), so a card wrapped over
    two physical lines arrives here as the one card ngspice runs.
    """
    out: list[str] = []
    in_control = False
    in_subckt = False
    for i, s in enumerate(logical_lines(deck_text)):
        if not s:
            continue
        low = s.lower()
        first = low.split(maxsplit=1)[0] if low else ''
        if in_control:
            if first in ('.endc', 'endc'):
                in_control = False
            continue
        if in_subckt:
            if first == '.ends':
                in_subckt = False
            continue
        if first == '.subckt':
            in_subckt = True
            continue
        if first in _CONTROL_CARDS:
            in_control = True
            continue
        if s.startswith(('*', ';', '.')):
            continue
        if s.startswith('+'):
            # An orphaned continuation: `logical_lines` keeps a `+` line on its own
            # when nothing owns it (after a comment, after a blank, or as the first
            # content in the file). It is not a card — it is a fragment of one. The
            # first cut of this function let it through, and `read_netlist`, which
            # takes the first whitespace token as a refdes like the rest of SPICE
            # does, reported a part called `+` with node `R1`: the real R1 vanished
            # and an invented component appeared in the user's component list.
            continue
        if skip_title and i == 0:
            # The title card. `logical_lines` keeps it at index 0 exactly so this
            # test is the same one `_find_element_span` already makes.
            continue
        out.append(s)
    return out
