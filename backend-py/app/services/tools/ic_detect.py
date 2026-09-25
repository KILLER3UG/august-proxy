"""Identify which real part a schematic's topology corresponds to.

Deterministic, offline, explainable — that ordering is the product decision,
not a stopgap:

* **Deterministic**: the same deck always yields the same answer. No provider
  call, no network, no embedding index, no temperature.
* **Offline**: it runs entirely over the parsed netlist graph, so it answers
  with no ngspice, no license and no connection. ``circuit_search_component``
  — the web part search — is the *fallback* when nothing here matches, which is
  the right way round: a hit from the internet ranks below a fact from the
  graph.
* **Explainable**: every match carries the subgraph that produced it (which
  refs, which nets, which pins), human-readable evidence lines, and what the
  graph explicitly *cannot* prove (``limits``). A match without evidence is a
  claim, and claims are what this module exists to stop.

The never-present-a-guess-as-a-fact discipline is copied from
``cost_estimator.price_for_model``: each match carries ``confidence`` plus
``estimated`` and each candidate repeats both, and ``assertive`` is only ever
True at or above :data:`MIN_DEFINITE_CONFIDENCE`.

How matching works
------------------
Matching is a **subgraph monomorphism over net connectivity**. A pattern
declares roles (``series_r``, ``shunt_c`` …) constrained by *element kind* and
by the part's own model/binding field, plus **bonds** — "pin *i* of role A sits
on the same net as pin *j* of role B" (or on ground). Bonds partition the
declared pins into net classes; a match is an assignment of roles to real
components such that

1. every class collapses to exactly one net,
2. different classes are different nets — no degenerate coincidences, so two
   independent pull-down resistors are *not* a voltage divider,
3. classes bonded to ground are net ``0`` and every other class is not,
4. declared net-degree floors hold (a current-sense shunt must sit in a real
   current path, not hang off a lone node).

Node names, refdes numbers and the order two terminals of a symmetric part are
written in are irrelevant by construction — the pattern never looks at a
string from the deck. Case is ignored everywhere.

What the graph can honestly prove (and what it can't)
-----------------------------------------------------
A plain SPICE deck has **no op-amp, LED, crystal or IC element kind**:
:mod:`app.services.tools.schematic` emits ``resistor capacitor inductor diode
voltage isource transistor mosfet subckt switch coupled`` plus a ``part``
fallback. So:

* **Amplifier readings are name-based.** An ``X`` instance is checked against a
  small alias table of real amplifier part numbers and generic ``amp``/``opamp``
  words, and the evidence says the match came from the ``.subckt`` binding name,
  not from topology. When the name *is* a real part number the candidate stops
  being an estimate (the deck literally says so); when it is the word ``amp`` the
  candidates stay ``estimated: True``.
* **An LED is a ``diode`` with an LED model card.** A diode behind a series
  resistor therefore has two readings — lamp (only when the model name looks
  like an LED) and unproven current-limited node — and the weaker one is
  suppressed when the stronger covers the same refs.
* **A crystal is not representable.** The oscillator pattern is a *reactive loop
  through an active device*: obligatory for oscillation, nowhere near
  sufficient, which is why it carries the lowest confidence in the library.
* **MOSFET pin parsing is ambiguous** (``_NODE_COUNT`` gives ``M`` three pins, so
  a 4-terminal BSIM line mis-parses), so MOSFETs appear only where the first
  three pins carry the meaning (drain/gate/source). No MOSFET-only pattern was
  invented to paper over that.

Reading the numbers
-------------------
``confidence`` states how much the **graph** supports the label. These are the
bands the library's values actually occupy, so a caller can say what a number
means instead of guessing:

* **0.85 – 0.95** — the connectivity pins the topology down and the label is the
  ordinary one for that shape: a divider, an RC/LC filter section, a current
  mirror, a deck-named amplifier with a feedback bridge across its pins. A
  reader who accepts the nets accepts the label.
* **0.70 – 0.84** — the shape is matched, the **role** is the judgement: snubber
  vs bootstrap leg, lamp vs clamp, sense shunt vs pull-down, which half of a
  push-pull pair sources. Name the reading and quote the evidence.
* **0.60 – 0.69** — a **stage**, not a function. A long-tailed pair is the input
  of an op-amp and is not an op-amp; a grounded-emitter transistor with a
  collector load is an amplifier or a switch depending on its bias.
* **below 0.60** — a hint to check by simulation, never an identification: the
  reactive feedback loop (0.35), an unnamed diode behind a resistor (0.5), an
  amplifier inferred from the bare word ``amp`` (0.55).

:data:`MIN_DEFINITE_CONFIDENCE` (0.8) is the line between "is" and "looks
like", and ``assertive`` is exactly ``confidence >= that line``.

``source`` is a second axis, not a synonym for low confidence: a
``source: 'name'`` match came from what the deck's author *named* the instance,
and there the number says how strong that naming is (a real part number the
deck states beats a generic word). ``shapeProven`` marks the difference — False
when the graph itself supports no conclusion, which is why such a match must
never be presented as a topology finding.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any

from app.services.tools import schematic
from app.services.tools.circuit_tools import (
    _deck_text,
    _looks_like_deck_path,
    _resolve_deck_path,
    parse_spice_value,
)

# ── Public knobs ───────────────────────────────────────────────────────────

#: At or above this a match may be stated as an identification; below it, it is
#: a hypothesis. The tool description quotes this constant so the two can never
#: drift apart, and :func:`detect_ic_patterns` defaults to keeping everything
#: (``min_confidence=0.0``) so a caller can still see and judge the weak ones.
#: The bands the library's numbers live in are documented in this module's
#: docstring, under "Reading the numbers".
MIN_DEFINITE_CONFIDENCE = 0.8

#: Ground is net ``0`` — the same convention ``schematic.build_graph`` uses
#: (``gnd`` is just another node name here, and pretending otherwise would make
#: two tools disagree about what is grounded).
GROUND = '0'

#: Library stamp, so a result can be re-explained against the table it came from.
LIBRARY_VERSION = 'ic-detect/1'

_MAX_PER_PATTERN = 12       # embeddings reported per pattern
_MAX_SEARCH_STEPS = 40000   # backtracks per pattern before giving up

_GND_SENTINEL = '__ground__'


# ── Pattern vocabulary ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class Part:
    """One role in a topology: a kind constraint plus the part's own fields."""

    role: str
    kinds: tuple[str, ...]
    label: str
    arity: int | None = None          # exact parsed pin count required
    symmetric: bool = False           # terminals interchangeable (R/C/L/S)
    value_max: float | None = None    # parsed SPICE value ceiling
    value_min: float | None = None
    model_any: tuple[str, ...] = ()   # words the part's model/binding field may hold
    model_note: str = ''              # how the model field was read (evidence)


@dataclass(frozen=True)
class Candidate:
    """A real part number offered for a matched topology."""

    part: str
    kind: str          # 'ic' | 'discrete' | 'family'
    note: str
    confidence: float
    estimated: bool


@dataclass(frozen=True)
class Topology:
    """A declarative entry in the known-topology library."""

    id: str
    name: str
    family: str
    purpose: str
    parts: tuple[Part, ...]
    bonds: tuple[tuple[Any, ...], ...]           # (role,pin,role,pin) | (role,pin,'GND')
    confidence: float
    candidates: tuple[Candidate, ...] = ()
    evidence: tuple[str, ...] = ()               # {role} {role.value} {role.p0} {role.binding}
    limits: tuple[str, ...] = ()
    free_pins: tuple[tuple[str, int], ...] = ()  # declared pins carrying no bond
    min_degree: tuple[tuple[str, int, int], ...] = ()
    supersedes: tuple[str, ...] = ()
    ic_implied: bool = True
    #: False when the reading rests on a NAME rather than on the connectivity
    #: (a 2-terminal subckt between two nets is not itself an amplifier).
    shape_proven: bool = True
    name_role: str = ''                          # role whose name may upgrade the match
    source: str = 'topology'                     # 'topology' | 'name' | 'name+topology'
    # Derived at import by ``_prepare``:
    norm_bonds: tuple[tuple[tuple[str, int], tuple[str, int] | str], ...] = ()

    def declared_pins(self) -> set[tuple[str, int]]:
        out: set[tuple[str, int]] = set(self.free_pins)
        for a, b in self.norm_bonds:
            out.add(a)
            if isinstance(b, tuple):
                out.add(b)
        return out


def _b(role: str, pin: int, other: str, other_pin: int = 0) -> tuple[Any, ...]:
    """Bond shorthand: ``(role, pin)`` shares a net with another pin, or ground."""
    if other == 'GND':
        return (role, pin, 'GND')
    return (role, pin, other, other_pin)


def _part(
    role: str, kinds: tuple[str, ...], label: str, *, arity: int | None = None,
    symmetric: bool = False, value_max: float | None = None,
    model_any: tuple[str, ...] = (), model_note: str = '',
) -> Part:
    return Part(
        role=role, kinds=kinds, label=label, arity=arity, symmetric=symmetric,
        value_max=value_max, model_any=model_any, model_note=model_note,
    )


def _c(part: str, kind: str, note: str, confidence: float, estimated: bool) -> Candidate:
    return Candidate(part=part, kind=kind, note=note, confidence=confidence,
                     estimated=estimated)


# Pin names per kind — evidence must say "emitter", never "pin 2", and a
# MOSFET's third pin really is the source where a BJT's is the emitter.
_PIN_NAMES: dict[str, tuple[str, ...]] = {
    'resistor': ('a', 'b'),
    'capacitor': ('a', 'b'),
    'inductor': ('a', 'b'),
    'coupled': ('a', 'b'),
    'part': ('a', 'b'),
    'diode': ('anode', 'cathode'),
    'voltage': ('plus', 'minus'),
    'isource': ('plus', 'minus'),
    'switch': ('pole-a', 'pole-b'),
    'transistor': ('collector', 'base', 'emitter'),
    'mosfet': ('drain', 'gate', 'source'),
    'subckt': ('pin1', 'pin2', 'pin3', 'pin4', 'pin5'),
}


def _pin_label(kind: str, pin: int) -> str:
    names = _PIN_NAMES.get(kind) or ()
    if 0 <= pin < len(names):
        return names[pin]
    return f'pin{pin}'


# ── Amplifier alias table (name-based: small and curated on purpose) ───────
#
# A generic word says "an amplifier is instantiated here" (still no part
# number). A real part number says "the deck names this chip" — which is a
# fact about the deck, not an identification of the circuit.

_AMP_WORDS = frozenset({
    'amp', 'opamp', 'amplifier', 'buffer', 'follower', 'diffamp', 'ota',
})

_AMP_ALIASES: dict[str, tuple[str, tuple[str, ...]]] = {
    # binding-name token -> (preferred part number, siblings worth listing)
    'tl071': ('TL071', ('TL072',)),
    'tl072': ('TL072', ('TL071', 'TL082')),
    'tl081': ('TL081', ('TL082',)),
    'tl082': ('TL082', ('TL072',)),
    'tl062': ('TL062', ()),
    'ne5532': ('NE5532', ('NE5534',)),
    'ne5534': ('NE5534', ('NE5532',)),
    'lm358': ('LM358', ('LM324', 'LM2904')),
    'lm324': ('LM324', ('LM358',)),
    'lm741': ('LM741', ('uA741',)),
    'ua741': ('uA741', ('LM741',)),
    'op07': ('OP07', ()),
    'opa2134': ('OPA2134', ()),
    'mcp6002': ('MCP6002', ()),
    'lf356': ('LF356', ('LF353',)),
    'lf353': ('LF353', ('LF356',)),
    'rc4558': ('RC4558', ('RC4560',)),
    'jrc4558d': ('RC4558', ('JRC4558D',)),
    'lm13700': ('LM13700', ('LM3080',)),
    'lm3080': ('LM3080', ('LM13700',)),
}

#: Model-card words that make a diode look like a lamp (SPICE has no LED kind).
_LED_WORDS = ('led', 'rgb', 'opto', 'lamp', 'indicator')

_TOKEN_SPLIT_RE = re.compile(r'[^a-z0-9]+')

_AMP_MODEL_WORDS = tuple(sorted(_AMP_WORDS | set(_AMP_ALIASES)))


def _amp_name_read(binding: str) -> tuple[str | None, tuple[str, ...], bool]:
    """``(preferred_part, siblings, word_only)`` for an ``X`` binding name.

    ``preferred_part`` set → the deck named a real part. ``word_only`` → it used
    a generic amplifier word. Both false → not an amplifier name at all.
    """
    tokens = [t for t in _TOKEN_SPLIT_RE.split((binding or '').lower()) if t]
    for tok in tokens:
        hit = _AMP_ALIASES.get(tok)
        if hit:
            return (hit[0], hit[1], False)
    if any(t in _AMP_WORDS for t in tokens):
        return (None, (), True)
    return (None, (), False)


# ── The library ────────────────────────────────────────────────────────────
#
# Passive networks are offered as passives. Naming an IC for a resistor and a
# capacitor would be the exact overreach this module exists to prevent, so an
# IC appears only where a real chip genuinely implements the function, and it
# arrives marked ``estimated``.

_LIB: tuple[Topology, ...] = (
    # ── First-order RC ────────────────────────────────────────────────────
    Topology(
        id='rc_low_pass', name='1st-order RC low-pass', family='filter',
        purpose='Series R into a shunt C at the output node: passes DC and rolls '
                'off above f = 1/(2*pi*R*C).',
        parts=(_part('series_r', ('resistor',), 'series resistor', symmetric=True),
               _part('shunt_c', ('capacitor',), 'shunt capacitor', symmetric=True)),
        bonds=(_b('series_r', 1, 'shunt_c', 0), _b('shunt_c', 1, 'GND')),
        free_pins=(('series_r', 0),),
        confidence=0.9, ic_implied=False,
        candidates=(
            _c('discrete R + C', 'discrete', 'the deck itself: one series resistor and '
               'one capacitor to ground. No IC needed and none implied', 0.95, False),
            _c('MAX291', 'ic', 'only if a single-chip filter is wanted: an 8th-order '
               'switched-capacitor low-pass, i.e. a sampled filter rather than this '
               'analog one', 0.35, True),
        ),
        evidence=('{series_r} ({series_r.value}) feeds {shunt_c} ({shunt_c.value}) at '
                  'net {shunt_c.p0}, and {shunt_c} is the only path from that net to '
                  'ground',),
        limits=('whatever drives the far end of {series_r} is outside this subgraph, so '
                'the corner frequency is a value question, not a shape question',),
    ),
    Topology(
        id='rc_high_pass', name='1st-order RC high-pass', family='filter',
        purpose='Series C into a shunt R to ground: blocks DC and passes above '
                'f = 1/(2*pi*R*C).',
        parts=(_part('series_c', ('capacitor',), 'series capacitor', symmetric=True),
               _part('shunt_r', ('resistor',), 'shunt resistor', symmetric=True)),
        bonds=(_b('series_c', 1, 'shunt_r', 0), _b('shunt_r', 1, 'GND')),
        free_pins=(('series_c', 0),),
        confidence=0.9, ic_implied=False,
        candidates=(_c('discrete C + R', 'discrete', 'one series capacitor and one '
                       'resistor to ground; a 1st-order high-pass has no single-chip '
                       'equivalent hiding in this deck', 0.95, False),),
        evidence=('{series_c} ({series_c.value}) couples net {series_c.p0} into '
                  '{shunt_r} ({shunt_r.value}), which returns to ground',),
        limits=('AC coupling and the capacitive-dropper leg are the same graph: see '
                'capacitive_dropper for the reading that also needs an AC source',),
    ),
    Topology(
        id='rc_snubber', name='RC snubber (series R-C branch)', family='protection',
        purpose='A resistor and capacitor in series forming a branch between two nets, '
                'neither of them ground — the classic energy-absorb leg across a '
                'switching node.',
        parts=(_part('snub_r', ('resistor',), 'snubber resistor', symmetric=True),
               _part('snub_c', ('capacitor',), 'snubber capacitor', symmetric=True)),
        bonds=(_b('snub_r', 1, 'snub_c', 0),),
        free_pins=(('snub_r', 0), ('snub_c', 1)),
        confidence=0.72, ic_implied=False,
        candidates=(_c('discrete R + C', 'discrete', 'a snubber is a two-part discrete '
                       'network (commonly 10-100 ohm with 1-100 nF); no IC implements '
                       'it', 0.9, False),),
        evidence=('{snub_r} ({snub_r.value}) and {snub_c} ({snub_c.value}) form one '
                  'series branch between nets {snub_r.p0} and {snub_c.p1}; both ends '
                  'are off ground, so this is a snubber leg and not a filter',),
        limits=('what the branch hangs across (a relay coil, a MOSFET, a contact) is '
                'outside the subgraph, and the graph cannot rank snubber against '
                'bootstrap or coupling intent',),
    ),
    Topology(
        id='capacitive_dropper', name='Capacitive dropper supply leg', family='power',
        purpose='A series capacitor fed from an AC source, dropped onto a shunt '
                'resistor to ground — the mains "capacitor power supply" leg.',
        parts=(_part('ac_v', ('voltage',), 'AC source', model_any=('sin', 'ac'),
                     model_note='the source card itself (SIN/AC), not the shape'),
               _part('line_c', ('capacitor',), 'dropper capacitor', symmetric=True),
               _part('drop_r', ('resistor',), 'burden resistor', symmetric=True)),
        bonds=(_b('ac_v', 0, 'line_c', 0), _b('line_c', 1, 'drop_r', 0),
               _b('drop_r', 1, 'GND'), _b('ac_v', 1, 'GND')),
        confidence=0.68, ic_implied=False,
        candidates=(_c('discrete class-X capacitor + resistor', 'discrete', 'mains '
                       'droppers are discrete and safety-rated (an X2 film capacitor '
                       'plus a bleed/burden resistor). No IC may be substituted for '
                       'the isolation question this topology raises', 0.85, False),),
        evidence=('{ac_v} carries an AC/SIN card, {line_c} ({line_c.value}) drops it '
                  'onto net {line_c.p1}, and {drop_r} ({drop_r.value}) returns that net '
                  'to ground',),
        limits=('one source card plus the shape: the rectifier, zener and reservoir a '
                'dropper normally feeds are NOT proven here (they would be separate '
                'matches, or they are absent)',),
    ),
    # ── Bias / sense ──────────────────────────────────────────────────────
    Topology(
        id='voltage_divider', name='Resistive voltage divider', family='bias',
        purpose='Two resistors in series to ground; the joint is the tapped ratio '
                'Vout = Vin * Rbottom/(Rtop+Rbottom).',
        parts=(_part('top_r', ('resistor',), 'upper resistor', symmetric=True),
               _part('bottom_r', ('resistor',), 'lower resistor', symmetric=True)),
        bonds=(_b('top_r', 1, 'bottom_r', 0), _b('bottom_r', 1, 'GND')),
        free_pins=(('top_r', 0),),
        confidence=0.9, ic_implied=False,
        candidates=(
            _c('discrete R + R', 'discrete', 'two resistors; the ratio is set by their '
               'values, which this tool does not judge', 0.95, False),
            _c('4606X-101', 'family', 'a thick-film resistor ARRAY if the divider must '
               'track with temperature — a design upgrade, not an identification',
               0.3, True),
        ),
        evidence=('{top_r} ({top_r.value}) runs from net {top_r.p0} to the tap and '
                  '{bottom_r} ({bottom_r.value}) from the tap to ground',),
        limits=('a tap with matched resistors divides; whether it is a reference, a '
                'sensor read or a level shift is not knowable from connectivity',),
    ),
    Topology(
        id='current_sense_shunt', name='Low-side current-sense shunt',
        family='measurement',
        purpose='A sub-ohm resistor carrying a load current to ground with enough '
                'connections on its top node to be in a current path — the low-side '
                'shunt whose I*R drop is the measurement.',
        parts=(_part('shunt_r', ('resistor',), 'shunt resistor', symmetric=True,
                     value_max=1.0),),
        bonds=(_b('shunt_r', 1, 'GND'),),
        free_pins=(('shunt_r', 0),),
        min_degree=(('shunt_r', 0, 3),),
        confidence=0.7, ic_implied=False,
        candidates=(
            _c('discrete mΩ/Ω shunt', 'discrete', 'a sub-ohm resistor is the sense '
               'element; tolerance and TCR, not the value, decide its quality',
               0.85, False),
            _c('INA180', 'ic', 'a current-sense amplifier could replace the discrete '
               'tap network — a design option, not something this deck proves',
               0.3, True),
        ),
        evidence=('{shunt_r} is {shunt_r.value} from net {shunt_r.p0} to ground, i.e. '
                  'at or below 1 ohm, and that node carries three or more pins, so '
                  'current arrives from somewhere and leaves somewhere else',),
        limits=('the 1-ohm test is what separates a shunt from a pull-down, so the '
                'reading is only as good as the value written in the deck; high-side '
                'sensing has a different shape and is not claimed here',),
    ),
    # ── Indicators ────────────────────────────────────────────────────────
    Topology(
        id='led_indicator', name='Indicator lamp with series resistor',
        family='indicator', source='name+topology',
        purpose='A current-limiting resistor feeding a diode whose model card reads '
                'like a lamp, cathode to ground.',
        parts=(_part('limit_r', ('resistor',), 'current-limit resistor', symmetric=True),
               _part('lamp_d', ('diode',), 'diode with an LED-like model',
                     model_any=_LED_WORDS,
                     model_note='the diode model card — SPICE has no LED element kind')),
        bonds=(_b('limit_r', 1, 'lamp_d', 0), _b('lamp_d', 1, 'GND')),
        free_pins=(('limit_r', 0),),
        confidence=0.78, supersedes=('diode_series_limiter',),
        candidates=(
            _c('discrete LED + resistor', 'discrete', 'the honest answer: a lamp and a '
               'ballast resistor, no IC', 0.8, False),
            _c('1N4148', 'discrete', 'listed because the bundled offline library '
               'carries its card — and it is a SIGNAL diode, i.e. the part this shape '
               'would be if it were not a lamp', 0.25, True),
        ),
        evidence=('{limit_r} ({limit_r.value}) limits into the anode of {lamp_d}, whose '
                  'model field reads {lamp_d.binding} (lamp-like), and its cathode is '
                  'the only ground path from net {lamp_d.p0}',),
        limits=('the lamp reading comes from the MODEL NAME, not from the graph. A '
                'segment LCD or bar-graph display cannot be identified at all here — '
                'no element kind exists for it, so "LCD indicator" is out of reach '
                'by design.',),
    ),
    Topology(
        id='diode_series_limiter', name='Current-limited diode node', family='indicator',
        purpose='A resistor feeding a diode to ground — the same shape as a lamp with '
                'the identity of the diode unknown.',
        parts=(_part('limit_r', ('resistor',), 'series resistor', symmetric=True),
               _part('line_d', ('diode',), 'diode')),
        bonds=(_b('limit_r', 1, 'line_d', 0), _b('line_d', 1, 'GND')),
        free_pins=(('limit_r', 0),),
        confidence=0.5, ic_implied=False,
        candidates=(_c('discrete diode + resistor', 'discrete', 'a clamp, a reverse-'
                       'protection diode or a lamp — connectivity cannot tell them '
                       'apart', 0.5, False),),
        evidence=('{limit_r} ({limit_r.value}) into the anode of {line_d} at net '
                  '{line_d.p0}, cathode to ground',),
        limits=('the graph proves direction (anode fed, cathode grounded) and nothing '
                'about what the diode IS, which is why this reading sits at 0.5 while '
                'the LED reading needs a lamp-shaped model name',),
    ),
    # ── BJT stages ────────────────────────────────────────────────────────
    Topology(
        id='common_emitter', name='Common-emitter BJT stage', family='amplifier',
        purpose='Emitter to ground, a resistor on the collector, base as the other '
                'terminal — the inverting gain stage.',
        parts=(_part('q', ('transistor',), 'transistor', arity=3),
               _part('rc', ('resistor',), 'collector resistor', symmetric=True)),
        bonds=(_b('q', 2, 'GND'), _b('rc', 0, 'q', 0)),
        free_pins=(('q', 1), ('rc', 1)),
        min_degree=(('q', 0, 2),),
        confidence=0.62,
        candidates=(
            _c('2N3904', 'discrete', 'the general-purpose NPN this shape is drawn with; '
               'read the model field of {q} for what the deck actually says', 0.5, True),
            _c('BC547', 'discrete', 'the same stage in the European part family',
               0.4, True),
        ),
        evidence=('{q} has its emitter on ground, {rc} ({rc.value}) pulls its collector '
                  'to net {rc.p1}, and the base at {q.p1} is the input — the gain is '
                  'inverting',),
        limits=('a grounded-emitter stage with a collector load is a switch or an '
                'amplifier depending on bias, which connectivity cannot decide. The '
                'transistor model card (NPN vs PNP) is not consulted, so the device '
                'type is assumed from the grounded emitter, not read.',),
    ),
    Topology(
        id='common_collector', name='Emitter follower (common-collector)',
        family='amplifier',
        purpose='Collector on a rail, emitter resistor to ground, output taken at the '
                'emitter — unity voltage gain, current gain, no inversion.',
        parts=(_part('q', ('transistor',), 'transistor', arity=3),
               _part('re', ('resistor',), 'emitter resistor', symmetric=True)),
        bonds=(_b('q', 2, 're', 0), _b('re', 1, 'GND')),
        free_pins=(('q', 0), ('q', 1)),
        min_degree=(('q', 0, 2),),
        confidence=0.62,
        candidates=(_c('2N3904', 'discrete', 'a follower is a discrete stage; the part '
                       'number guesses which transistor, not the topology', 0.5, True),),
        evidence=('{q}\'s emitter shares net {q.p2} with {re} ({re.value}) to ground, '
                  'while its collector sits on {q.p0} with at least one other '
                  'connection (a rail), so the output is the emitter',),
        limits=('the collector net must carry something else for this to be a follower '
                'rather than a floating collector — that is checked — but what it '
                'carries stays outside the subgraph',),
    ),
    Topology(
        id='differential_pair', name='Differential pair (long-tailed)',
        family='amplifier',
        purpose='Two emitters joined into a tail that returns through a resistor — the '
                'input stage of essentially every linear IC.',
        parts=(_part('q1', ('transistor',), 'left transistor', arity=3),
               _part('q2', ('transistor',), 'right transistor', arity=3),
               _part('tail_r', ('resistor',), 'tail resistor', symmetric=True)),
        bonds=(_b('q1', 2, 'q2', 2), _b('q1', 2, 'tail_r', 0), _b('tail_r', 1, 'GND')),
        free_pins=(('q1', 0), ('q1', 1), ('q2', 0), ('q2', 1)),
        confidence=0.6,
        candidates=(
            _c('LM394', 'ic', 'monolithic matched NPN pair — the part chosen when this '
               'stage has to track', 0.45, True),
            _c('MAT02', 'ic', 'matched low-noise pair', 0.4, True),
            _c('2N3904 x2', 'discrete', 'the discrete version; a matched pair is the '
               'upgrade, not an identification', 0.4, True),
        ),
        evidence=('{q1} and {q2} share one emitter net which returns through {tail_r} '
                  '({tail_r.value}) to ground, and the two collectors ({q1.p0}, '
                  '{q2.p0}) and two bases ({q1.p1}, {q2.p1}) are four separate nets',),
        limits=('this is a STAGE, not an amplifier: one long-tailed pair is the input '
                'of TL072/LM358/NE5532-class parts but says nothing about the rest of '
                'such a chip, so no op-amp number is offered as fact. A tail CURRENT '
                'SOURCE instead of the resistor is a different graph and does not '
                'match.',),
    ),
    Topology(
        id='current_mirror', name='BJT current mirror', family='current-source',
        purpose='Two transistors sharing a base net with one of them diode-connected '
                'and both emitters grounded — the copied-current pair.',
        parts=(_part('diode_q', ('transistor',), 'reference transistor', arity=3),
               _part('out_q', ('transistor',), 'output transistor', arity=3)),
        bonds=(_b('diode_q', 0, 'diode_q', 1), _b('diode_q', 1, 'out_q', 1),
               _b('diode_q', 2, 'GND'), _b('out_q', 2, 'GND')),
        free_pins=(('diode_q', 0), ('out_q', 0)),
        confidence=0.85,
        candidates=(
            _c('LM394', 'ic', 'a matched pair in one package is how this is built when '
               'the ratio has to hold', 0.5, True),
            _c('2N3904 x2', 'discrete', 'the discrete mirror', 0.45, True),
        ),
        evidence=('{diode_q} is diode-connected (its collector is bonded to its own '
                  'base on net {diode_q.p0}), that base net also drives {out_q}, both '
                  'emitters are on ground, and the two collectors ({diode_q.p0}, '
                  '{out_q.p0}) stay separate',),
        limits=('the mirror ratio comes from emitter area and matching, which a '
                'netlist does not carry — two identical model cards do not guarantee '
                '1:1',),
    ),
    Topology(
        id='totem_pole_pair', name='Half-bridge / totem-pole output pair',
        family='output',
        purpose='Two transistors with a common drive net and a shared output between '
                'one emitter and the other collector, the lower device on ground.',
        parts=(_part('hi_q', ('transistor',), 'pull-up transistor', arity=3),
               _part('lo_q', ('transistor',), 'pull-down transistor', arity=3)),
        bonds=(_b('hi_q', 2, 'lo_q', 0), _b('hi_q', 1, 'lo_q', 1), _b('lo_q', 2, 'GND')),
        free_pins=(('hi_q', 0),),
        confidence=0.7,
        candidates=(
            _c('2N3904 + 2N3906', 'discrete', 'the discrete totem pole', 0.45, True),
            _c('SN74HC14', 'ic', 'a logic inverter ships a push-pull output of this '
               'shape internally — relevant only if the drive net is logic', 0.3, True),
            _c('LM393', 'ic', 'listed as the near-neighbour people reach for by '
               'mistake: a comparator output is open-collector, which is NOT this '
               'shape', 0.2, True),
        ),
        evidence=('{hi_q}\'s emitter meets {lo_q}\'s collector on the output net '
                  '{hi_q.p2}, both bases sit on {hi_q.p1}, {lo_q}\'s emitter is ground '
                  'and {hi_q}\'s collector is the rail at {hi_q.p0}',),
        limits=('which device sources and which sinks is a model-type question (NPN vs '
                'PNP lives in the params field, which this reading does not consult), '
                'so "push-pull" is proven structurally, not electrically',),
    ),
    Topology(
        id='complementary_follower_pair', name='Complementary push-pull follower pair',
        family='output',
        purpose='Class-B pair: the two devices cross to one output net and one supply '
                'net with bases tied together, and nothing in the pair is grounded.',
        parts=(_part('hi_q', ('transistor',), 'sourcing transistor', arity=3),
               _part('lo_q', ('transistor',), 'sinking transistor', arity=3)),
        bonds=(_b('hi_q', 0, 'lo_q', 2), _b('hi_q', 2, 'lo_q', 0),
               _b('hi_q', 1, 'lo_q', 1)),
        confidence=0.7,
        candidates=(
            _c('2N3904 + 2N3906', 'discrete', 'the classic complementary follower pair',
               0.5, True),
            _c('LM394', 'ic', 'matched pair version', 0.35, True),
        ),
        evidence=('{hi_q} and {lo_q} cross to one supply net ({hi_q.p0}), one output net '
                  '({hi_q.p2}) and one shared base net ({hi_q.p1}), and no pin of either '
                  'device is on ground',),
        limits=('both devices sit above ground in this reading, so the supply and load '
                'that make it a stage are expected but not part of the match',),
    ),
    # ── LC / resonant ─────────────────────────────────────────────────────
    Topology(
        id='lc_pi_filter', name='LC pi (CLC) filter', family='filter',
        purpose='Shunt C, series L, shunt C — the pi-section filter.',
        parts=(_part('in_c', ('capacitor',), 'input shunt capacitor', symmetric=True),
               _part('ser_l', ('inductor',), 'series inductor', symmetric=True),
               _part('out_c', ('capacitor',), 'output shunt capacitor', symmetric=True)),
        bonds=(_b('in_c', 1, 'GND'), _b('out_c', 1, 'GND'),
               _b('in_c', 0, 'ser_l', 0), _b('ser_l', 1, 'out_c', 0)),
        confidence=0.85, ic_implied=False,
        candidates=(_c('discrete L + 2 C', 'discrete', 'a pi section is three passives; '
                       'the second-order shape is what the graph proves', 0.9, False),),
        evidence=('{ser_l} ({ser_l.value}) runs between the two shunt capacitors '
                  '{in_c} and {out_c}, each of which returns to ground',),
        limits=('which end is the input is not a connectivity fact — the two shunt '
                'caps are interchangeable in the graph',),
    ),
    Topology(
        id='lc_t_filter', name='LC T filter', family='filter',
        purpose='Series L, shunt C, series L — the T-section counterpart of the pi.',
        parts=(_part('ser_l1', ('inductor',), 'first series inductor', symmetric=True),
               _part('shunt_c', ('capacitor',), 'shunt capacitor', symmetric=True),
               _part('ser_l2', ('inductor',), 'second series inductor', symmetric=True)),
        bonds=(_b('ser_l1', 1, 'shunt_c', 0), _b('shunt_c', 1, 'GND'),
               _b('ser_l1', 1, 'ser_l2', 0)),
        free_pins=(('ser_l1', 0), ('ser_l2', 1)),
        confidence=0.85, ic_implied=False,
        candidates=(_c('discrete 2 L + C', 'discrete', 'T-section passive filter',
                       0.9, False),),
        evidence=('{shunt_c} ({shunt_c.value}) drops to ground from the node between '
                  '{ser_l1} and {ser_l2} ({ser_l1.value}, {ser_l2.value})',),
        limits=('as with the pi: the graph does not name the input end',),
    ),
    Topology(
        id='lc_parallel_tank', name='LC parallel tank', family='filter',
        purpose='An inductor in parallel with a capacitor across exactly two nets — a '
                'resonant tank at f = 1/(2*pi*sqrt(LC)).',
        parts=(_part('tank_l', ('inductor',), 'tank inductor', symmetric=True),
               _part('tank_c', ('capacitor',), 'tank capacitor', symmetric=True)),
        bonds=(_b('tank_l', 0, 'tank_c', 0), _b('tank_l', 1, 'tank_c', 1)),
        confidence=0.8, ic_implied=False,
        candidates=(_c('discrete L + C', 'discrete', 'the tank itself; a tuned primary '
                       'looks the same until the coupling card is read', 0.85, False),),
        evidence=('{tank_l} ({tank_l.value}) and {tank_c} ({tank_c.value}) share BOTH '
                  'nets, so they are in parallel, and the two nets are distinct (not a '
                  'shorted loop)',),
        limits=('two parts across two nets is all this proves; whether something also '
                'taps the tank is outside the subgraph',),
    ),
    # ── Oscillator-ish / input conditioning ───────────────────────────────
    Topology(
        id='rc_feedback_loop', name='Reactive feedback loop around an active device',
        family='oscillator',
        purpose='A resistor from the output terminal back to the control terminal and a '
                'capacitor from the control terminal to the third terminal: a closed '
                'reactive loop, the shape every relaxation or phase-shift oscillator '
                'needs.',
        parts=(_part('dev', ('transistor', 'mosfet'), 'active device', arity=3),
               _part('fb_r', ('resistor',), 'feedback resistor', symmetric=True),
               _part('fb_c', ('capacitor',), 'timing capacitor', symmetric=True)),
        bonds=(_b('dev', 2, 'GND'), _b('dev', 0, 'fb_r', 0), _b('fb_r', 1, 'dev', 1),
               _b('dev', 1, 'fb_c', 0), _b('fb_c', 1, 'dev', 2)),
        confidence=0.35,
        candidates=(
            _c('2N3904 + R + C', 'discrete', 'the shape is right for a one-transistor '
               'relaxation oscillator; the values and the loop gain decide whether it '
               'actually oscillates', 0.3, True),
            _c('NE555', 'ic', 'a timer IC does this job with a completely different '
               'graph — offered as the fallback question, not as a match', 0.2, True),
        ),
        evidence=('{fb_r} ({fb_r.value}) closes from {dev.out} to the control terminal '
                  'at {dev.p1}, {fb_c} ({fb_c.value}) continues to {dev.p2}, and the '
                  'device itself closes the remaining third of the loop: a cycle '
                  'through an amplifier plus one reactive element is OBLIGATORY for '
                  'oscillation and NOT sufficient for it',),
        limits=('loop gain and phase are simulation questions (run .tran / .ac), not '
                'graph questions. A CRYSTAL cannot be matched at all: a plain SPICE '
                'deck has no crystal element kind, so only a motional R-L-C branch or '
                'a named X-subckt could represent one, and neither is claimed here.',),
    ),
    Topology(
        id='debounce_rc', name='Switch debounce RC', family='input-conditioning',
        purpose='A series R into a shunt C with a contact landing on the same node — '
                'the button filter that buys milliseconds of settle time.',
        parts=(_part('ser_r', ('resistor',), 'series resistor', symmetric=True),
               _part('shunt_c', ('capacitor',), 'hold capacitor', symmetric=True),
               _part('btn', ('switch',), 'contact', symmetric=True)),
        bonds=(_b('ser_r', 1, 'shunt_c', 0), _b('shunt_c', 1, 'GND'),
               _b('btn', 0, 'shunt_c', 0)),
        free_pins=(('ser_r', 0),),
        confidence=0.75, ic_implied=False,
        candidates=(
            _c('discrete R + C + contact', 'discrete', 'the hardware debouncer',
               0.9, False),
            _c('MAX6816', 'ic', 'a real contact-debounce IC, if a chip is wanted '
               'instead of the RC', 0.3, True),
        ),
        evidence=('{btn} lands on the same net as {shunt_c} ({shunt_c.value}) and '
                  '{ser_r} ({ser_r.value}) — that is the RC which has to charge and '
                  'discharge every time the contact moves',),
        limits=('the time constant is R*C and only meaningful against the threshold of '
                'whatever else sits on that node, which is outside the subgraph',),
    ),
    Topology(
        id='switch_pull_up', name='Pull-up resistor with a switch to ground',
        family='input-conditioning',
        purpose='The idle state is the rail and the contact pulls the net to ground.',
        parts=(_part('pu_r', ('resistor',), 'pull-up resistor', symmetric=True),
               _part('sw', ('switch',), 'contact', symmetric=True)),
        bonds=(_b('pu_r', 0, 'sw', 0), _b('sw', 1, 'GND')),
        free_pins=(('pu_r', 1),),
        confidence=0.8, ic_implied=False,
        candidates=(_c('discrete R + contact', 'discrete', 'the canonical input bias '
                       'network', 0.9, False),),
        evidence=('{pu_r} ({pu_r.value}) holds the contact node at a non-ground net '
                  '({pu_r.p1}) while {sw} is the only declared path from it to ground',),
        limits=('an internal pull-up enabled in firmware is invisible in a netlist '
                'unless the deck models it, so "external" here means "drawn"',),
    ),
    Topology(
        id='switch_pull_down', name='Pull-down resistor with a switch to the rail',
        family='input-conditioning',
        purpose='The idle state is ground and the contact raises the net.',
        parts=(_part('pd_r', ('resistor',), 'pull-down resistor', symmetric=True),
               _part('sw', ('switch',), 'contact', symmetric=True)),
        bonds=(_b('pd_r', 1, 'GND'), _b('pd_r', 0, 'sw', 0)),
        free_pins=(('sw', 1),),
        confidence=0.8, ic_implied=False,
        candidates=(_c('discrete R + contact', 'discrete', 'the canonical active-high '
                       'input network', 0.9, False),),
        evidence=('{pd_r} ({pd_r.value}) holds the contact node to ground while {sw} '
                  'carries it toward {sw.p1} when it closes',),
        limits=('which of switch_pull_up / switch_pull_down fires is decided purely by '
                'which side of the resistor is grounded — that IS visible in the '
                'graph, so the only open question left is the contact type',),
    ),
    # ── Name-based amplifier readings (SPICE has no op-amp element kind) ──
    Topology(
        id='amplifier_subckt', name='Amplifier instance (by subckt binding name)',
        family='amplifier', source='name',
        purpose='An X instance (or an unrecognised IC line) whose binding name is a '
                'real amplifier part number or a generic amp word.',
        parts=(_part('amp', ('subckt', 'part'), 'amplifier instance',
                     model_any=_AMP_MODEL_WORDS,
                     model_note='the .subckt binding name — NOT the topology'),),
        bonds=(),
        free_pins=(('amp', 0), ('amp', 1)),
        confidence=0.55, name_role='amp', shape_proven=False,
        candidates=(
            _c('TL072', 'ic', 'a dual JFET op-amp — named because the alias table '
               'points at amplifiers of this class, not because the graph saw one',
               0.35, True),
            _c('NE5532', 'ic', 'same class, low-noise audio', 0.3, True),
            _c('LM358', 'ic', 'same class, single-supply', 0.3, True),
        ),
        evidence=('{amp} is bound to {amp.binding}, a name in the amplifier alias '
                  'table; the two pins the parser sees sit on nets {amp.p0} and '
                  '{amp.p1}',),
        limits=('PURELY NAME-BASED. A plain SPICE deck has no op-amp element kind, so '
                'this reads the author\'s naming: a mislabelled subckt would fool it, '
                'and a generic word like "amp" proves nothing about a part number. It '
                'fires on X instances and on any IC line the parser falls back to '
                '"part" for (a U/J prefix), which is the same evidence either way.',),
    ),
    Topology(
        id='amplifier_feedback_stage', name='Amplifier with a feedback element',
        family='amplifier', source='name',
        purpose='An amplifier instance with one element bridging its two visible pins — '
                'the feedback leg of an amplifier stage (a resistor gives a gain stage, '
                'a capacitor an integrator).',
        parts=(_part('amp', ('subckt', 'part'), 'amplifier instance',
                     model_any=_AMP_MODEL_WORDS,
                     model_note='the .subckt binding name — NOT the topology'),
               _part('fb', ('resistor', 'capacitor'), 'feedback element', symmetric=True)),
        bonds=(_b('fb', 0, 'amp', 0), _b('fb', 1, 'amp', 1)),
        confidence=0.7, name_role='amp', supersedes=('amplifier_subckt',),
        candidates=(
            _c('TL072', 'ic', 'dual JFET op-amp — the class the alias table points at',
               0.4, True),
            _c('NE5532', 'ic', 'low-noise audio dual', 0.35, True),
            _c('LM358', 'ic', 'single-supply dual', 0.35, True),
        ),
        evidence=('{fb} ({fb.value}) bridges the two visible pins of {amp} '
                  '({amp.p0}, {amp.p1}), which is a feedback path, and the instance is '
                  'bound to {amp.binding}',),
        limits=('name-based for the amplifier, graph-based for the feedback leg. Only '
                'two pins of an X line are parsed, so which is inverting and which is '
                'the output is assumed, not seen — and the closed-loop gain needs the '
                'input resistor, which this subgraph deliberately does not guess at.',),
    ),
)


# ── Library preparation and self-check ─────────────────────────────────────

def _as_tuple(value: Any) -> tuple[Any, ...]:
    """A one-element ``evidence=('text')`` is a string, not a tuple.

    Python foot-gun, and this table is written by hand: normalize single
    strings so an entry cannot silently render one character per line.
    """
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    return tuple(value)


def _prepare(top: Topology) -> Topology:
    roles = {p.role for p in top.parts}
    norm: list[tuple[tuple[str, int], tuple[str, int] | str]] = []
    for bond in _as_tuple(top.bonds):
        if len(bond) == 3:
            role, pin, marker = bond
            if marker != 'GND':
                raise ValueError(f'{top.id}: bond target {marker!r} is neither GND nor a role')
            other: tuple[str, int] | str = _GND_SENTINEL
        else:
            role, pin, other_role, other_pin = bond
            if other_role not in roles:
                raise ValueError(f'{top.id}: bond references unknown role {other_role!r}')
            other = (str(other_role), int(other_pin))
        if role not in roles:
            raise ValueError(f'{top.id}: bond role {role!r} is not declared')
        norm.append(((str(role), int(pin)), other))
    return replace(
        top,
        norm_bonds=tuple(norm),
        evidence=_as_tuple(top.evidence),
        limits=_as_tuple(top.limits),
        candidates=_as_tuple(top.candidates),
        parts=_as_tuple(top.parts),
        free_pins=_as_tuple(top.free_pins),
        min_degree=_as_tuple(top.min_degree),
        supersedes=_as_tuple(top.supersedes),
    )


def _validate(top: Topology) -> list[str]:
    errs: list[str] = []
    roles = {p.role for p in top.parts}
    if len(roles) != len(top.parts):
        errs.append(f'{top.id}: duplicate role names')
    for pin_ref in list(top.free_pins) + [a for a, _bond in top.norm_bonds]:
        if pin_ref[0] not in roles:
            errs.append(f'{top.id}: references undeclared role {pin_ref[0]!r}')
    for deg in top.min_degree:
        if deg[0] not in roles:
            errs.append(f'{top.id}: min_degree references undeclared role {deg[0]!r}')
    # A multi-part topology must be connected through its bonds, otherwise two
    # unrelated parts would match (two independent pull-downs are not a divider).
    if len(top.parts) > 1:
        adj: dict[str, set[str]] = {p.role: set() for p in top.parts}
        for (ra, _pa), b in top.norm_bonds:
            if isinstance(b, tuple):
                adj.setdefault(ra, set()).add(b[0])
                adj.setdefault(b[0], set()).add(ra)
        start = top.parts[0].role
        reach = {start}
        stack = [start]
        while stack:
            for nxt in adj.get(stack.pop(), ()):
                if nxt not in reach:
                    reach.add(nxt)
                    stack.append(nxt)
        if reach != set(adj):
            errs.append(f'{top.id}: bond graph is not connected '
                        f'({sorted(set(adj) - reach)} float free)')
    if not top.candidates:
        errs.append(f'{top.id}: offers no candidates')
    if not top.evidence:
        errs.append(f'{top.id}: has no evidence template')
    referenced = [top.name_role] + [p.role for p in top.parts if p.model_any]
    for role in [r for r in referenced if r]:
        if role not in roles:
            errs.append(f'{top.id}: {role!r} referenced but not declared')
    for weaker in top.supersedes:
        if weaker not in {t.id for t in _LIB}:
            errs.append(f'{top.id}: supersedes unknown pattern {weaker!r}')
    return errs


_LIB_ERRORS: list[str] = []
_PATTERNS: list[Topology] = []
for _top in _LIB:
    try:
        _prepared = _prepare(_top)
        _LIB_ERRORS.extend(_validate(_prepared))
        _PATTERNS.append(_prepared)
    except Exception as _exc:  # a broken table must be reported, never silent
        _LIB_ERRORS.append(f'{_top.id}: {type(_exc).__name__}: {_exc}')

_BY_ID: dict[str, Topology] = {t.id: t for t in _PATTERNS}


def pattern_ids() -> tuple[str, ...]:
    """Every topology id in the library (stable order)."""
    return tuple(t.id for t in _PATTERNS)


def validate_library() -> list[str]:
    """Structure errors in the pattern table — empty means the library is sound."""
    return list(_LIB_ERRORS)


def describe_library() -> list[dict[str, Any]]:
    """Human/model-readable index of what the matcher can recognise."""
    return [
        {
            'id': t.id,
            'name': t.name,
            'family': t.family,
            'source': t.source,
            'shapeProven': t.shape_proven,
            'confidence': t.confidence,
            'purpose': t.purpose,
            'parts': [{'role': p.role, 'label': p.label, 'kinds': list(p.kinds)}
                      for p in t.parts],
            'candidates': [c.part for c in t.candidates],
            'limits': list(t.limits),
        }
        for t in _PATTERNS
    ]


# ── Deck → attributed components ───────────────────────────────────────────

_SUBCKT_DECL_RE = re.compile(r'^\s*\.subckt\s+([A-Za-z_][\w.\-]*)', re.I | re.M)


@dataclass
class _Comp:
    """A parsed element plus the attributes the graph alone does not carry."""

    ref: str
    kind: str
    nodes: list[str]          # as written (for reporting)
    lnodes: tuple[str, ...]   # lowered (for matching)
    value: str
    tail: str                 # text after the node fields (model card, params)
    binding: str              # model/subckt binding name ('' when unknown)

    def pin(self, idx: int, perm: tuple[int, ...]) -> str | None:
        real = perm[idx] if idx < len(perm) else idx
        if 0 <= real < len(self.lnodes):
            return self.lnodes[real]
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            'ref': self.ref, 'kind': self.kind, 'nodes': list(self.nodes),
            'value': self.value, 'model': self.binding or self.tail,
        }


def _is_gnd(node: str) -> bool:
    return node == GROUND


def _deck_lines(deck_text: str) -> dict[str, list[str]]:
    """``REF -> tokens of its element line``.

    Comments, dot-cards, ``.control`` and ``.subckt`` bodies are skipped for the
    same reason ``parse_elements`` skips them: they are not top-level parts.
    """
    out: dict[str, list[str]] = {}
    in_control = False
    in_subckt = False
    for raw in deck_text.splitlines():
        s = raw.strip()
        low = s.lower()
        if low.startswith('.control'):
            in_control = True
            continue
        if low.startswith('.endc'):
            in_control = False
            continue
        if low.startswith('.subckt'):
            in_subckt = True
            continue
        if low.startswith('.ends'):
            in_subckt = False
            continue
        if in_control or in_subckt or not s or s.startswith(('*', '+', '.', ';')):
            continue
        toks = s.split('$')[0].split()
        if len(toks) < 2 or not re.match(r'^[A-Za-z]\w*$', toks[0]):
            continue
        out.setdefault(toks[0].upper(), toks)
    return out


def _binding_name(kind: str, tail: str, declared: set[str]) -> str:
    """The model/subckt a part is bound to, read off its own line tail.

    ``parse_elements`` only fills ``value`` when a token starts with a digit, so
    a model card like ``2N3904`` or a subckt name is invisible there. The
    declared ``.subckt`` name wins; otherwise the last tail token that is not a
    parameter (``foo=1``) or a braced expression is taken. Only ``X`` instances
    and the generic ``part`` fallback (a ``U``/``J``/``B`` prefix, i.e. "some
    IC") get a binding — for a primitive device the trailing token may be a
    model from a library this module cannot see, and inventing one is not
    honest.
    """
    toks = [t for t in tail.split() if t]
    if not toks:
        return ''
    for t in toks:
        if t.lower() in declared:
            return t
    if kind not in ('subckt', 'part'):
        return ''
    for t in reversed(toks):
        if '=' in t or t.startswith('{'):
            continue
        return t
    return ''


def _components(deck_text: str) -> list[_Comp]:
    elements = schematic.parse_elements(deck_text)
    lines = _deck_lines(deck_text)
    declared = {m.lower() for m in _SUBCKT_DECL_RE.findall(deck_text)}
    comps: list[_Comp] = []
    for el in elements:
        toks = lines.get(el.ref.upper(), [])
        tail = ' '.join(toks[1 + len(el.nodes):]) if toks else (el.params or '')
        comps.append(_Comp(
            ref=el.ref, kind=el.kind, nodes=list(el.nodes),
            lnodes=tuple((n or '').strip().lower() for n in el.nodes),
            value=el.value, tail=tail,
            binding=_binding_name(el.kind, tail, declared),
        ))
    return comps


def _haystack(comp: _Comp) -> str:
    return ' '.join((comp.binding, comp.tail, comp.value, comp.ref)).lower()


def _word_in(words: tuple[str, ...], comp: _Comp) -> bool:
    hay = _haystack(comp)
    tokens = set(_TOKEN_SPLIT_RE.split(hay))
    return any(w in tokens or re.search(rf'\b{re.escape(w)}\b', hay) for w in words)


def _numeric_value(comp: _Comp) -> float | None:
    """The part's own first parseable numeric token (value, then tail)."""
    for token in [comp.value, *comp.tail.split()]:
        if not token or not (token[0].isdigit() or token[0] in '.+-'):
            continue
        try:
            val = parse_spice_value(token)
        except Exception:  # a wild card must not break matching
            continue
        if val is not None:
            return val
    return None


# ── The matcher ────────────────────────────────────────────────────────────

@dataclass
class _Assign:
    comp: _Comp
    perm: tuple[int, ...]

    def node(self, pin: int) -> str | None:
        return self.comp.pin(pin, self.perm)


@dataclass
class _Match:
    top: Topology
    assign: dict[str, _Assign]
    resolved: list[tuple[list[tuple[str, int]], str, bool]]  # (class pins, net, grounded)


def _domain(part: Part, comps: list[_Comp]) -> list[_Assign]:
    out: list[_Assign] = []
    for comp in comps:
        if comp.kind not in part.kinds:
            continue
        if part.arity is not None and len(comp.lnodes) != part.arity:
            continue
        if part.model_any and not _word_in(part.model_any, comp):
            continue
        if part.value_max is not None or part.value_min is not None:
            val = _numeric_value(comp)
            if val is None:
                continue
            if part.value_max is not None and val > part.value_max:
                continue
            if part.value_min is not None and val < part.value_min:
                continue
        # A symmetric 2-terminal part may be written either way round: both
        # orientations are candidates and the dedupe collapses the duplicates.
        perms: list[tuple[int, ...]] = [(0, 1), (1, 0)] if (
            part.symmetric and len(comp.lnodes) == 2) else [(0, 1)]
        for perm in perms:
            out.append(_Assign(comp=comp, perm=perm))
    return out


def _role_order(top: Topology, domains: dict[str, list[_Assign]]) -> list[str]:
    """Bond-following order, so each assignment prunes its own subtree."""
    adj: dict[str, set[str]] = {p.role: set() for p in top.parts}
    for (ra, _pa), b in top.norm_bonds:
        if isinstance(b, tuple):
            adj[ra].add(b[0])
            adj[b[0]].add(ra)
    size = lambda r: (len(domains.get(r, [])), r)  # noqa: E731
    start = min(adj, key=size)
    order = [start]
    frontier = [start]
    while frontier:
        cur = frontier.pop(0)
        for nxt in sorted(adj[cur], key=size):
            if nxt not in order:
                order.append(nxt)
                frontier.append(nxt)
    for p in top.parts:  # disconnected leftovers (validated away, kept safe)
        if p.role not in order:
            order.append(p.role)
    return order


def _bond_ok(top: Topology, assign: dict[str, _Assign]) -> bool:
    for (ra, pa), b in top.norm_bonds:
        ca = assign.get(ra)
        if ca is None:
            continue
        na = ca.node(pa)
        if isinstance(b, str):  # ground bond
            if na is not None and not _is_gnd(na):
                return False
            continue
        cb = assign.get(b[0])
        if cb is None:
            continue
        nb = cb.node(b[1])
        if na is None or nb is None or na != nb:
            return False
    return True


def _pin_classes(top: Topology) -> list[list[tuple[str, int]]]:
    """Union-find over the declared pins — the net classes the pattern expects.

    Every ground-bonded pin joins ONE class: they are the same net by
    definition, so reporting "net 0" twice for a mirrored pair is noise.
    """
    pins = sorted(top.declared_pins())
    parent: dict[tuple[str, int], tuple[str, int]] = {p: p for p in pins}
    ground_bonded = [(r, p) for (r, p), b in top.norm_bonds if isinstance(b, str)]

    def find(x: tuple[str, int]) -> tuple[str, int]:
        while parent[x] != x:
            x = parent[x]
        return x

    for (ra, pa), b in top.norm_bonds:
        if isinstance(b, tuple) and b in parent:
            root_a, root_b = find((ra, pa)), find(b)
            if root_a != root_b:
                parent[root_b] = root_a
    # Fold every grounded pin into the first ground-bonded class.
    for other in ground_bonded[1:]:
        root_a, root_b = find(ground_bonded[0]), find(other)
        if root_a != root_b:
            parent[root_b] = root_a
    groups: dict[tuple[str, int], list[tuple[str, int]]] = {}
    for p in pins:
        groups.setdefault(find(p), []).append(p)
    return [sorted(v) for v in groups.values()]


_CLASS_CACHE: dict[str, list[list[tuple[str, int]]]] = {}
_GROUND_CACHE: dict[str, set[tuple[str, int]]] = {}


def _classes_of(top: Topology) -> list[list[tuple[str, int]]]:
    hit = _CLASS_CACHE.get(top.id)
    if hit is None:
        hit = _pin_classes(top)
        _CLASS_CACHE[top.id] = hit
    return hit


def _grounded_pins(top: Topology) -> set[tuple[str, int]]:
    hit = _GROUND_CACHE.get(top.id)
    if hit is None:
        hit = {(r, p) for (r, p), b in top.norm_bonds if isinstance(b, str)}
        _GROUND_CACHE[top.id] = hit
    return hit


def _finish(top: Topology, assign: dict[str, _Assign],
            node_pins: dict[str, set[tuple[int, int]]]) -> _Match | None:
    grounded = _grounded_pins(top)
    resolved: list[tuple[list[tuple[str, int]], str, bool]] = []
    seen_nodes: set[str] = set()
    for group in _classes_of(top):
        nodes: set[str] = set()
        for role, pin in group:
            a = assign.get(role)
            node = a.node(pin) if a is not None else None
            if node is None:
                return None
            nodes.add(node)
        if len(nodes) != 1:
            return None
        node = next(iter(nodes))
        is_gnd = any(g in grounded for g in group)
        if is_gnd:
            if not _is_gnd(node):
                return None
        else:
            # A class the pattern does not bond to ground must not BE ground, and
            # no two such classes may share a net: that is the "no degenerate
            # coincidence" rule that keeps two unrelated pull-downs from reading
            # as a divider.
            if _is_gnd(node) or node in seen_nodes:
                return None
            seen_nodes.add(node)
        resolved.append((group, node, is_gnd))
    for role, pin, low in top.min_degree:
        a = assign.get(role)
        node = a.node(pin) if a is not None else None
        if node is None or len(node_pins.get(node, set())) < low:
            return None
    return _Match(top=top, assign=dict(assign), resolved=resolved)


def _search(top: Topology, comps: list[_Comp],
            node_pins: dict[str, set[tuple[int, int]]]) -> tuple[list[_Match], bool]:
    parts = {p.role: p for p in top.parts}
    domains = {role: _domain(part, comps) for role, part in parts.items()}
    if any(not d for d in domains.values()):
        return [], False
    order = _role_order(top, domains)
    found: list[_Match] = []
    steps = [0]
    exhausted = [False]

    def rec(idx: int, assign: dict[str, _Assign]) -> None:
        if len(found) >= _MAX_PER_PATTERN:
            exhausted[0] = True
            return
        if idx >= len(order):
            m = _finish(top, assign, node_pins)
            if m is not None:
                found.append(m)
            return
        role = order[idx]
        for cand in domains[role]:
            steps[0] += 1
            if steps[0] > _MAX_SEARCH_STEPS:
                exhausted[0] = True
                return
            if any(a.comp is cand.comp for a in assign.values()):
                continue
            assign[role] = cand
            if _bond_ok(top, assign):
                rec(idx + 1, assign)
            del assign[role]

    rec(0, {})
    deduped: list[_Match] = []
    seen: set[tuple[tuple[str, str], ...]] = set()
    for m in found:
        # Keyed on the components and the nets they occupy, NOT on which role
        # each one took: a symmetric pair (hi/lo in either order) or a part
        # written the other way round is the same reading, and printing it
        # twice invites the model to claim two matches where there is one.
        key = tuple(sorted({(m.assign[role].comp.ref, node)
                            for group, node, _gnd in m.resolved
                            for role, _pin in group}))
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(m)
    return deduped, exhausted[0]


# ── Evidence rendering ─────────────────────────────────────────────────────

_TEMPLATE_RE = re.compile(r'\{(\w+)(?:\.(\w+))?\}')


def _role_label(top: Topology, role: str) -> str:
    for p in top.parts:
        if p.role == role:
            return p.label
    return role


def _substitute(template: str, top: Topology, assign: dict[str, _Assign]) -> str:
    def rep(match: re.Match[str]) -> str:
        role, attr = match.group(1), match.group(2)
        a = assign.get(role)
        if a is None:
            return match.group(0)
        comp = a.comp
        if attr is None:
            return comp.ref
        if attr == 'value':
            return comp.value or '?'
        if attr == 'binding':
            return comp.binding or comp.tail or '(unnamed)'
        if attr == 'kind':
            return comp.kind
        if attr == 'label':
            return _role_label(top, role)
        pin_match = re.fullmatch(r'p(\d+)', attr)
        if pin_match:
            return a.node(int(pin_match.group(1))) or '?'
        if attr == 'out':
            return _out_terminal(comp)
        return attr

    return _TEMPLATE_RE.sub(rep, template)


def _out_terminal(comp: _Comp) -> str:
    if comp.kind == 'mosfet':
        return 'drain'
    if comp.kind == 'transistor':
        return 'collector'
    return _pin_label(comp.kind, 0)


def _net_lines(m: _Match) -> list[str]:
    """The matched subgraph, stated plainly: which net carries which pins."""
    lines: list[str] = []
    for group, node, is_gnd in m.resolved:
        members = ' + '.join(
            f'{m.assign[role].comp.ref}.{_pin_label(m.assign[role].comp.kind, pin)}'
            for role, pin in group
        )
        lines.append(f'net {node if not is_gnd else GROUND}: {members}')
    return lines


def _cand_dict(c: Candidate, known: frozenset[str]) -> dict[str, Any]:
    return {
        'part': c.part,
        'kind': c.kind,
        'note': c.note,
        'confidence': round(c.confidence, 3),
        'estimated': c.estimated,
        # A part number the bundled offline library also carries is a stronger
        # statement than one this module invented — say which it is.
        'inBundledLibrary': c.part.lower() in known,
    }


def _name_upgrade(top: Topology, assign: _Assign | None) -> tuple[Candidate | None, float, bool]:
    """When an instance's own name IS a part number, the guess becomes a fact."""
    if assign is None:
        return None, top.confidence, True
    preferred, siblings, word_only = _amp_name_read(assign.comp.binding)
    if preferred:
        return (
            Candidate(
                part=preferred, kind='ic',
                note=(f'the deck binds {assign.comp.ref} to {assign.comp.binding!r}, a '
                      f'real part number in the amplifier alias table'
                      + (f'; siblings in the family: {", ".join(siblings)}' if siblings else '')),
                confidence=0.9, estimated=False,
            ),
            max(top.confidence, 0.88), False,
        )
    if word_only:
        # A generic word ("amp") is weaker than the table's own number: keep it
        # under the definite bar no matter what the pattern is worth.
        return None, min(top.confidence, 0.55), True
    return None, top.confidence, True


def _match_payload(m: _Match, known: frozenset[str]) -> dict[str, Any]:
    top = m.top
    assign = m.assign
    preferred: Candidate | None = None
    confidence = top.confidence
    if top.name_role:
        preferred, confidence, _deck_stated = _name_upgrade(top, assign.get(top.name_role))
    candidates: list[dict[str, Any]] = []
    if preferred is not None:
        candidates.append(_cand_dict(preferred, known))
    for c in top.candidates:
        if preferred is not None and c.part == preferred.part:
            continue
        # A note may point at a role ("read the model field of {q}") — render it
        # exactly like evidence, or it reaches the user as a template.
        candidates.append(_cand_dict(replace(c, note=_substitute(c.note, top, assign)), known))
    # Mirror ``price_for_model``: the answer is an estimate unless something in
    # the candidate list was stated by the deck itself (a named part, or the
    # "this is a discrete network" reading that needs no inference at all).
    estimated = all(c['estimated'] for c in candidates) if candidates else True
    evidence = [_substitute(t, top, assign) for t in top.evidence]
    evidence += _net_lines(m)
    for part in top.parts:
        # Anything selected on a NAME is called out per part, so a reader can see
        # exactly which half of the match came from the graph and which did not.
        if part.model_any and part.role in assign:
            comp = assign[part.role].comp
            evidence.append(
                f'{comp.ref} was selected on its own field ({comp.binding or comp.tail or "?"}), '
                f'not on connectivity — {part.model_note or "read it as a name, not a fact"}'
            )
    if top.name_role:
        evidence.append(
            'how this was read: '
            + ('the deck names the instance itself, so the part number is a fact about '
               'the netlist' if not estimated
               else 'the amplifier alias table inferred it from a name — the graph did '
                    'not show an amplifier')
        )
    refs = sorted({a.comp.ref for a in assign.values()})
    return {
        'patternId': top.id,
        'name': top.name,
        'family': top.family,
        'purpose': top.purpose,
        'source': top.source,
        'shapeProven': top.shape_proven,
        'confidence': round(confidence, 3),
        'assertive': confidence >= MIN_DEFINITE_CONFIDENCE,
        'estimated': estimated,
        'icImplied': top.ic_implied,
        'candidates': candidates,
        'evidence': evidence,
        'limits': [_substitute(t, top, assign) for t in top.limits],
        'roles': {r: assign[r].comp.ref for r in sorted(assign)},
        'components': [assign[r].comp.to_dict() for r in sorted(assign)],
        'matchedSubgraph': {
            'refs': refs,
            'nets': sorted({node for _g, node, _x in m.resolved}),
            'signalNets': sorted({node for _g, node, x in m.resolved if not x}),
            'grounded': any(x for _g, _n, x in m.resolved),
            'netsDetail': _net_lines(m),
        },
    }


# ── Public entry points ────────────────────────────────────────────────────

def _known_parts() -> frozenset[str]:
    """Part numbers the bundled offline library also carries (membership only)."""
    try:
        from app.services.tools.circuit_tools import _COMPONENT_LIBRARY
        return frozenset(str(k).lower() for k in _COMPONENT_LIBRARY)
    except Exception:
        return frozenset()


def detect_ic_patterns(deck_text: str, top_k: object = None, *,
                       min_confidence: float = 0.0) -> dict[str, Any]:
    """Match a SPICE deck against the known-topology library.

    Returns ``{'patterns': [...], 'unexplained': [refs...]}`` plus the framing a
    caller needs to answer honestly (library stamp, counts, notes).
    ``unexplained`` names the components that took part in NO match, so "I found
    a divider" can never silently become "I understood this board".

    ``min_confidence`` is a floor, applied **inside** the matcher and before
    ``topK``. It defaults to ``0.0`` — keep the whole honest result, weak
    readings included, and let the caller see and judge them rather than being
    handed a filtered answer that looks like everything that was found. The
    count dropped is reported as ``filtered``; ``unexplained`` is computed from
    what survived, so a dropped reading can neither hide a component in plain
    sight nor make a matched one look unrecognised.

    Raises ``ValueError`` — never an ``AttributeError`` — for non-string input.
    """
    if not isinstance(deck_text, str):
        raise ValueError('deck_text must be a string of SPICE netlist text')
    floor = _coerce_confidence(min_confidence)
    comps = _components(deck_text)
    node_pins: dict[str, set[tuple[int, int]]] = {}
    for i, comp in enumerate(comps):
        for p, node in enumerate(comp.lnodes):
            node_pins.setdefault(node, set()).add((i, p))

    known = _known_parts()
    matches: list[_Match] = []
    truncated = False
    for top in _PATTERNS:
        found, spent = _search(top, comps, node_pins)
        truncated = truncated or spent
        matches.extend(found)

    payloads = _suppress_weaker([_match_payload(m, known) for m in matches])
    payloads.sort(key=lambda p: (-float(p['confidence']), p['patternId'],
                                 p['matchedSubgraph']['refs']))
    above, filtered = _apply_floor(payloads, floor)
    kept, limited = _apply_top_k(above, top_k)
    explained = {r for p in kept for r in p['matchedSubgraph']['refs']}

    result: dict[str, Any] = {
        'patterns': kept,
        'unexplained': [c.ref for c in comps if c.ref not in explained],
        'matched': bool(kept),
        'componentCount': len(comps),
        'netCount': len(node_pins),
        'minConfidence': floor,
        'filtered': filtered,
        'grounded': any(_is_gnd(n) for c in comps for n in c.lnodes),
        'library': {
            'version': LIBRARY_VERSION,
            'patternCount': len(_PATTERNS),
            'errors': list(_LIB_ERRORS),
        },
        'notes': _notes(payloads, comps, kept, floor),
    }
    if truncated or limited:
        result['truncated'] = True
    if not kept and filtered:
        # Nothing survived the caller's own floor — that is not "unrecognised",
        # and saying so would send the caller to the web for what the library
        # already found.
        result['fallback'] = (
            f'{filtered} reading(s) were found but every one of them sat below '
            f'min_confidence={floor}. They are weak, not absent: re-read with a '
            'lower floor and present them as candidates, with their evidence.'
        )
    elif not kept:
        result['fallback'] = (
            'No topology in the offline library matched. Fall back to '
            'circuit_search_component / circuit_integrate_component on the part '
            'numbers already in the deck, or ask about the block — an empty '
            'result here is an honest "not recognised", never a "no circuit".'
        )
    return result


def _coerce_confidence(value: object) -> float:
    """A floor the caller can hand as text, junk or nothing at all.

    Junk means "no floor": a malformed threshold must not be the reason a
    caller silently gets zero matches back.
    """
    if value is None or isinstance(value, bool):
        return 0.0
    try:
        num = float(str(value).strip())  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if num != num:  # NaN
        return 0.0
    return min(max(num, 0.0), 1.0)


def _apply_floor(payloads: list[dict[str, Any]],
                 floor: float) -> tuple[list[dict[str, Any]], int]:
    """Drop sub-threshold readings, counting them rather than hiding them."""
    if floor <= 0.0:
        return payloads, 0
    kept = [p for p in payloads if float(p['confidence']) >= floor]
    return kept, len(payloads) - len(kept)


def _suppress_weaker(payloads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop a weaker reading when a stronger one covers the same refs."""
    stronger: dict[str, list[set[str]]] = {}
    for p in payloads:
        top = _BY_ID.get(p['patternId'])
        if top is None:
            continue
        for weaker in top.supersedes:
            stronger.setdefault(weaker, []).append(set(p['matchedSubgraph']['refs']))
    if not stronger:
        return payloads
    out: list[dict[str, Any]] = []
    for p in payloads:
        refs = set(p['matchedSubgraph']['refs'])
        if any(refs <= wider for wider in stronger.get(p['patternId'], [])):
            continue
        out.append(p)
    return out


def _apply_top_k(payloads: list[dict[str, Any]], top_k: object) -> tuple[list[dict[str, Any]], bool]:
    if top_k is None or isinstance(top_k, bool):
        return payloads, False
    try:
        want = int(float(str(top_k)))
    except (TypeError, ValueError):
        return payloads, False
    if want <= 0:
        return [], True
    want = min(want, 200)
    return payloads[:want], len(payloads) > want


def _notes(payloads: list[dict[str, Any]], comps: list[_Comp],
           kept: list[dict[str, Any]], floor: float = 0.0) -> list[str]:
    notes = [
        f'{len(comps)} element(s) parsed; {len(payloads)} topology match(es) '
        f'before any topK cut.',
        'Confidence states what the GRAPH proves, not how likely a part is: only '
        f'matches at or above {MIN_DEFINITE_CONFIDENCE} are assertive, and every '
        'estimated candidate says so.',
        'Bands: >=0.85 the shape pins the label; 0.70-0.84 the shape is matched '
        'and the role is the judgement; 0.60-0.69 a stage, not a function; '
        'below 0.60 a hint to check by simulation.',
    ]
    if floor > 0.0:
        notes.append(
            f'min_confidence={floor} was applied: {len(payloads) - len(kept)} '
            'reading(s) were dropped, so this list is NOT everything the deck '
            'matched.'
        )
    if any(p['source'] != 'topology' for p in kept):
        notes.append(
            'At least one reading is NAME-based (a plain SPICE deck has no '
            'op-amp/LED/crystal element kind): it reports what the author called '
            'the instance, not what the connectivity shows.'
        )
    if not kept:
        notes.append('Nothing matched — see "fallback".')
    return notes


def load_deck_text(netlist: str, workspace: str = '') -> tuple[str, str]:
    """``(deck_text, path)`` for inline SPICE text OR a workspace deck path.

    Reuses ``circuit_tools``' deck helpers rather than re-implementing file
    reading. Inline text is normalised in memory — no scratch file, because a
    read-only analysis tool that materialised files would contradict the
    read-only classification it is filed under (the reasoning
    ``circuit_tools.read_schematic`` records).
    """
    if not isinstance(netlist, str):
        raise ValueError('netlist must be a string (inline SPICE text or a deck path)')
    stripped = netlist.strip()
    if _looks_like_deck_path(stripped):
        deck_path = _resolve_deck_path(netlist, workspace, for_write=False)
        return deck_path.read_text(encoding='utf-8', errors='replace'), str(deck_path)
    if not stripped:
        raise ValueError('netlist is empty — pass inline SPICE text or a deck path.')
    return _deck_text(stripped), ''


def detect_ic_for_deck(netlist: str, workspace: str = '', top_k: object = None, *,
                       min_confidence: float = 0.0) -> dict[str, Any]:
    """The tool-facing entry point: resolve a deck (path or inline text), match it.

    Non-string input raises ``ValueError`` at this boundary, so the tool result
    is a plain message and never a leaked ``AttributeError``.
    """
    deck_text, path = load_deck_text(netlist, workspace)
    result = detect_ic_patterns(deck_text, top_k=top_k, min_confidence=min_confidence)
    if path:
        result['deckPath'] = path
    return result
