"""Netlist text helpers shared by the tools that READ a deck.

Kept out of `circuit_tools` because `schematic` must not import a 4,000-line
module to get one function (and `circuit_tools` does not import `schematic`, so
a home there would invert the dependency). One rule, one place — the same
reasoning that put `listable_root` in `sandbox.paths`.
"""

from __future__ import annotations

_CONTROL_CARDS = ('.control', '.c')

# Tokens that INTRODUCE a source's value rather than being it. `V1 in 0 DC 9` is a
# 9 V source; the SPICE keyword in front of the number is part of the card's
# grammar, not its value. `AC` and `TRAN`/`TR` can follow, so the scan skips the
# leading ones and stops at the first thing that is a value.
_SOURCE_KEYWORDS = frozenset({'DC', 'AC', 'TR', 'TRAN', 'PWL', 'PULSE', 'SIN', 'EXP', 'SFFM', 'AMOD'})


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

    `parts` is the whole card and `need` the node count its class declares, so the
    tokens after the nodes are what is left. Two guesses lived here in sequence and
    each was wrong about the shape the other got right: the FIRST token after the
    nodes made `V1 in 0 DC 9` a source whose value was the word `DC`, and the LAST
    token of the card made `R1 out n2 1k tc=0,0.002` a resistor whose value was a
    temperature coefficient — the linter then told the user their 1 kΩ resistor
    "does not parse as a SPICE number", a false error on a deck that simulates, on
    the one surface whose job is to catch real ones.

    SPICE is positional: a class's value or model is the FIRST token after the
    nodes and everything right of it is parameters. Two forms need more than that:

      * a source may introduce its value with a keyword — `V1 in 0 DC 9 AC 1 0` is
        a 9 V source whose AC magnitude is not its value, so for V and I the
        leading `_SOURCE_KEYWORDS` are skipped;
      * a waveform argument is whitespace-split across its arguments (`SIN(0 1 1k`
        `,` `1k)`), so an unbalanced `(` gathers tokens until it closes.

    Measured against ngspice 45.2 (the deck, then the run): `R1 in out 1k tc=0
    0.002` runs as 1 kΩ, `.param x=1k` + `R1 in out {x}` runs, and `DC 9 AC 1 0`
    gives v = 9. A MODEL is what the semi-conductor classes end in (`M1 d g s b mm`,
    `X1 a b BLOCK`) and this returns it, which is what the listing has always shown.
    """
    if len(parts) <= 1 + need:
        return ''
    tail = parts[1 + need:]
    positional = [i for i, t in enumerate(tail) if '=' not in t]
    if not positional:
        return ''
    if parts[0][:1].upper() not in ('V', 'I'):
        return tail[positional[0]]
    for i in positional:
        token = tail[i]
        if token.upper() in _SOURCE_KEYWORDS:
            continue
        if '(' in token and not token.endswith(')'):
            group = [token]
            balanced = token.count('(') == token.count(')')
            for nxt in tail[i + 1:]:
                if balanced:
                    break
                group.append(nxt)
                joined = ' '.join(group)
                balanced = joined.count('(') == joined.count(')') and joined.endswith(')')
            return ' '.join(group)
        return token
    return tail[positional[-1]]


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
