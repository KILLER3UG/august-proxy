"""Schematic sidecar tests.

The invariant under test: **the netlist is the source of truth.** The
schematic is a layout sidecar — moving a part must never touch a value or
a connection, and deleting the sidecar must leave the circuit simulable.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.services.tools import circuit_tools, schematic

DECK = """* rc divider
V1 in 0 DC 10
R1 in out 1k
R2 out 0 2k
C1 out 0 1u
.end
"""


def _write_deck(tmp_path: Path, text: str = DECK) -> Path:
    p = tmp_path / 'rc.cir'
    p.write_text(text, encoding='utf-8')
    return p


def test_parse_elements_reads_ref_nodes_value():
    els = {e.ref: e for e in schematic.parse_elements(DECK)}
    assert els['R1'].kind == 'resistor'
    assert els['R1'].nodes == ['in', 'out']
    assert els['R1'].value == '1k'
    assert els['V1'].kind == 'voltage'
    assert els['C1'].kind == 'capacitor'


def test_build_graph_wires_shared_nets():
    graph = schematic.build_graph(DECK, {'grid': schematic.GRID, 'components': {}})
    refs = {c.ref for c in graph['components']}
    assert refs == {'V1', 'R1', 'R2', 'C1'}
    # 'in' joins V1+R1, 'out' joins R1+R2+C1, '0' is the ground rail.
    wired = {tuple(w.nodes) for w in graph['wires']}
    assert ('in',) in wired
    assert ('out',) in wired
    assert ('0',) in wired


def test_render_svg_is_standalone_with_symbols():
    graph = schematic.build_graph(DECK, {'grid': schematic.GRID, 'components': {}})
    svg = schematic.render_svg(graph, 'RC divider')
    assert svg.startswith('<svg')
    assert svg.rstrip().endswith('</svg>')
    # Real schematic symbols, not generic boxes: resistor zig-zag, cap plates.
    assert 'polyline' in svg
    assert 'RC divider' in svg


def test_explicit_wire_route_overrides_auto(tmp_path: Path):
    layout = {'grid': schematic.GRID, 'components': {},
              'wireRoutes': {'out': [[0, 0], [100, 0]]}}
    graph = schematic.build_graph(DECK, layout)
    out_wire = next(w for w in graph['wires'] if w.nodes == ['out'])
    assert out_wire.points[0] == (0.0, 0.0)
    assert out_wire.points[-1] == (100.0, 0.0)


def test_layout_roundtrip(tmp_path: Path):
    deck = _write_deck(tmp_path)
    layout = {'grid': schematic.GRID, 'components': {'R1': {'col': 0, 'row': 12, 'rot': 1}}}
    schematic.write_layout(deck, layout)
    loaded = schematic.read_layout(deck)
    assert loaded['components']['R1'] == {'col': 0, 'row': 12, 'rot': 1}
    assert loaded['components']['R1']['rot'] == 1


def test_edit_schematic_moves_parts_without_touching_values(tmp_path: Path):
    deck = _write_deck(tmp_path)
    before = deck.read_text(encoding='utf-8')
    result = circuit_tools.edit_schematic(
        str(deck), moves=[{'ref': 'R1', 'col': 2, 'row': 8}], workspace=str(tmp_path),
    )
    after = deck.read_text(encoding='utf-8')
    assert before == after, 'a layout edit must not rewrite the netlist'
    assert result['components'][1]['col'] == 2
    sidecar = Path(result['savedTo'])
    assert sidecar.name == 'rc.layout.json'
    stored = json.loads(sidecar.read_text(encoding='utf-8'))
    assert stored['components']['R1']['row'] == 8


def test_edit_schematic_rejects_unknown_ref(tmp_path: Path):
    deck = _write_deck(tmp_path)
    try:
        circuit_tools.edit_schematic(
            str(deck), moves=[{'ref': 'R9', 'col': 0}], workspace=str(tmp_path),
        )
    except ValueError as exc:
        assert 'R9' in str(exc)
    else:
        raise AssertionError('expected ValueError for an unknown ref')


def test_edit_schematic_auto_derives_layout(tmp_path: Path):
    deck = _write_deck(tmp_path)
    result = circuit_tools.edit_schematic(str(deck), auto=True, workspace=str(tmp_path))
    assert {c['ref'] for c in result['components']} == {'V1', 'R1', 'R2', 'C1'}


def test_schematic_tools_reject_non_string_deck_without_leaking_python():
    """A model that passes netlist=42 must get a plain message, not an
    AttributeError traceback leaking through the tool boundary."""
    for call in (
        lambda: circuit_tools.read_schematic(42),  # type: ignore[arg-type]
        lambda: circuit_tools.edit_schematic(42),  # type: ignore[arg-type]
        lambda: circuit_tools.render_schematic(42),  # type: ignore[arg-type]
    ):
        with pytest.raises(ValueError) as exc:
            call()
        assert 'must be a string' in str(exc.value)
        assert 'AttributeError' not in str(exc.value)


def test_edit_schematic_rejects_non_object_move(tmp_path: Path):
    deck = _write_deck(tmp_path)
    with pytest.raises(ValueError, match='each move must be an object'):
        circuit_tools.edit_schematic(
            str(deck), moves=['R1'], workspace=str(tmp_path),  # type: ignore[list-item]
        )


def test_read_schematic_reports_layout_state(tmp_path: Path):
    deck = _write_deck(tmp_path)
    first = circuit_tools.read_schematic(str(deck), workspace=str(tmp_path))
    assert first['autoLayout'] is True
    assert first['layoutExists'] is False
    circuit_tools.edit_schematic(str(deck), auto=True, workspace=str(tmp_path))
    second = circuit_tools.read_schematic(str(deck), workspace=str(tmp_path))
    assert second['autoLayout'] is False
    assert second['layoutExists'] is True


def test_render_schematic_writes_svg(tmp_path: Path):
    deck = _write_deck(tmp_path)
    result = circuit_tools.render_schematic(str(deck), name='rc', workspace=str(tmp_path))
    out = Path(result['path'])
    assert out.name == 'rc.svg'
    assert out.read_text(encoding='utf-8').startswith('<svg')
    assert result['components'] == 4


# ── REST surface (the drawer's editor) ─────────────────────────────────────


@pytest.fixture()
def _client(tmp_path):
    from app.main import app
    from app.services.workbench import workbench as wb
    from fastapi.testclient import TestClient

    session = wb.createWorkbenchSession(provider='', guardMode='full')
    session.workspacePath = str(tmp_path)
    with TestClient(app) as c:
        yield c, session.id


def test_schematic_endpoints_roundtrip(_client, tmp_path: Path):
    client, sid = _client
    deck = _write_deck(tmp_path)
    before = deck.read_text(encoding='utf-8')

    r = client.get(f'/api/workbench/sessions/{sid}/circuit/schematic', params={'path': str(deck)})
    assert r.status_code == 200, r.text
    graph = r.json()
    assert {c['ref'] for c in graph['components']} == {'V1', 'R1', 'R2', 'C1'}

    r = client.post(
        f'/api/workbench/sessions/{sid}/circuit/schematic',
        json={'path': str(deck), 'moves': [{'ref': 'R1', 'col': 3, 'row': 7}]},
    )
    assert r.status_code == 200, r.text
    moved = next(c for c in r.json()['components'] if c['ref'] == 'R1')
    assert (moved['col'], moved['row']) == (3, 7)
    # The point of the sidecar: the deck itself is byte-identical.
    assert deck.read_text(encoding='utf-8') == before


def test_schematic_endpoints_reject_bad_input(_client, tmp_path: Path):
    client, sid = _client
    r = client.post(
        f'/api/workbench/sessions/{sid}/circuit/schematic', json={'path': 'x.cir'},
    )
    assert r.status_code == 400
    deck = _write_deck(tmp_path)
    r = client.post(
        f'/api/workbench/sessions/{sid}/circuit/schematic',
        json={'path': str(deck), 'moves': [{'ref': 'NOPE', 'col': 0}]},
    )
    assert r.status_code == 400
    assert 'NOPE' in r.json()['detail']


def test_schematic_endpoints_404_unknown_session(_client, tmp_path: Path):
    client, _sid = _client
    deck = _write_deck(tmp_path)
    r = client.get('/api/workbench/sessions/wb_missing/circuit/schematic', params={'path': str(deck)})
    assert r.status_code == 404


# ── Geometry and edit-path regressions ─────────────────────────────────────
# Each of these was reproduced live in the 2026-09-25 circuit audit and had no
# test: the bugs survived because the fixtures assumed a shape the code never
# produced. They assert the drawn geometry, not the internals.

import re  # noqa: E402


def _part(col: float, row: float, rot: int, kind: str = 'resistor',
          nodes: list[str] | None = None) -> schematic.Component:
    return schematic.Component(
        'R1', kind, nodes or ['in', 'out'], '1k', '', col, row, rot,
    )


def test_rotated_component_pins_stay_apart():
    """rot=1 used to read only the row offsets — all zero — and return the
    centre twice, so every wire on a vertical part attached to its middle."""
    flat = _part(3, 8, 0).pins()
    up = _part(3, 8, 1).pins()
    assert len(set(up)) == 2, f'vertical pins collapsed to {up}'
    assert flat == [(10.0, 80.0), (50.0, 80.0)]
    assert up == [(30.0, 60.0), (30.0, 100.0)]
    # The rotation must be about the layout origin, which is what the wires,
    # the editor's grab box and the label all pivot on.
    for pins in (flat, up):
        centre = (sum(p[0] for p in pins) / 2, sum(p[1] for p in pins) / 2)
        assert centre == (30.0, 80.0)


def test_three_terminal_parts_have_all_three_pins():
    """`Q`/`M` parse THREE nodes (SPICE: NC NB NE / ND NG NS) but the old
    2-entry PIN_OFFSETS made build_graph drop the third node at the
    `i >= len(comp_pins)` break — an emitter or source terminal that no wire
    could ever attach to."""
    q = schematic.Component('Q1', 'transistor', ['c', 'b', 'e'], 'Qmod', '', 3, 8, 0)
    pins = q.pins()
    assert len(pins) == 3
    # The offsets are symmetric about the layout origin, so the pin mean IS
    # the origin — the point drags and labels pivot on.
    cx = sum(p[0] for p in pins) / len(pins)
    cy = sum(p[1] for p in pins) / len(pins)
    assert (cx, cy) == q.px()
    # Rotation moves all three but keeps the mean.
    up = schematic.Component('Q1', 'transistor', ['c', 'b', 'e'], 'Qmod', '', 3, 8, 1).pins()
    assert len(set(up)) == 3
    assert (sum(p[0] for p in up) / 3, sum(p[1] for p in up) / 3) == q.px()


def test_bjt_emitter_net_gets_a_wire():
    """The observable the dropped pin hid: with `Q1 c b e`, net `e` joins the
    transistor's emitter to Re — previously only Re's pin existed on that net,
    so no wire was emitted at all and the emitter drew floating."""
    deck = TOPOLOGIES['bjt']
    graph = schematic.build_graph(deck, {'components': {}})
    wire_nets = {w.nodes[0] for w in graph['wires']}
    assert {'c', 'b', 'e'} <= wire_nets, f'missing transistor nets in {wire_nets}'
    q1 = next(c for c in graph['components'] if c.ref == 'Q1')
    assert len(q1.pins()) == 3


def test_transistor_symbol_draws_three_leads_and_polarity_differs():
    """The old symbol drew its third lead as a ZERO-LENGTH line (`y2 == y1`)
    and a MOSFET was indistinguishable from an arrowless BJT."""
    q = schematic.Component('Q1', 'transistor', ['c', 'b', 'e'], 'Qmod', '', 3, 8, 0)
    m = schematic.Component('M1', 'mosfet', ['d', 'g', 's'], 'Mmod', '', 3, 8, 0)
    qsvg = '\n'.join(schematic._symbol_svg(q, '#334155', None, None))
    msvg = '\n'.join(schematic._symbol_svg(m, '#334155', None, None))
    for svg in (qsvg, msvg):
        leads = [ln for ln in svg.splitlines() if '<line' in ln]
        assert len(leads) >= 4, f'expected base lead + bar + 2 channel leads, got {leads}'
    # NPN emitter arrow is a filled triangle; the MOSFET has the insulated
    # gate bar instead and no arrow.
    assert '<path' in qsvg and 'fill="#334155"' in qsvg
    assert '<path' not in msvg
    # The insulated gate is a SECOND full-height bar at its own x. Counting
    # `stroke-width="1.5"` occurrences (what this test used to do) stayed true
    # with the gate bar deleted — a BJT has as many 1.5 strokes as a MOSFET
    # minus one — so the bars are read as geometry now.
    assert _vertical_bars(qsvg) == [26.0], _vertical_bars(qsvg)
    bars = _vertical_bars(msvg)
    assert len(bars) == 2 and bars[1] - bars[0] == 4.0, f'mosfet gate bar missing: {bars}'
    # …and the arrow points at the EMITTER pin (40, 90), below the body
    # centre. A direction-blind `'<path' in qsvg` accepted an arrow flipped
    # onto the collector.
    apex = _arrow_apex(qsvg)
    assert apex is not None and abs(apex[0] - 40.0) < 0.6 and apex[1] > 80.0, apex


def _vertical_bars(svg: str) -> list[float]:
    """x of every full-height channel bar in a FET symbol (drawn bcy-7 →
    bcy+7, so length 14 at a constant x)."""
    found: list[float] = []
    for ln in svg.splitlines():
        m = re.search(
            r'<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"', ln)
        if not m:
            continue
        x1, y1, x2, y2 = (float(m.group(i)) for i in range(1, 5))
        if x1 == x2 and abs(y2 - y1) == 14:
            found.append(x1)
    return sorted(set(found))


def _arrow_apex(svg: str) -> tuple[float, float] | None:
    """The middle vertex of the filled emitter-arrow triangle — the point the
    arrow says current flows towards."""
    for ln in svg.splitlines():
        if 'fill="#334155"' not in ln or '<path' not in ln:
            continue
        pts = re.findall(r'(-?\d+\.?\d*)\s+(-?\d+\.?\d*)', ln.split('d="')[1])
        if len(pts) == 3:
            return (float(pts[1][0]), float(pts[1][1]))
    return None


def test_every_pin_entry_averages_to_the_layout_origin():
    """The table-wide property, asserted on the table: `_symbol_svg` and the
    editor both pivot on the mean of a part's pins, so an entry whose offsets
    do not average to (0,0) skids the body away from the wires routed to it.
    Checking it per-entry is what catches a new row that passes its own part
    test by accident — the MESFET's first version had x-mean -0.5."""
    for kind, offs in schematic.PIN_OFFSETS.items():
        n = len(offs)
        assert (sum(x for x, _ in offs) / n, sum(y for _, y in offs) / n) == (0.0, 0.0), kind
        assert len(set(offs)) == n, f'{kind} has two pins at one point: {offs}'
    # The generator keeps the same promise for counts the table does not name.
    for n in range(3, 9):
        offs = schematic.pin_offsets('no_such_kind', n)
        assert len(offs) == n
        assert (sum(x for x, _ in offs) / n, sum(y for _, y in offs) / n) == (0.0, 0.0), n


def test_fet_pin_order_is_asserted_as_coordinates():
    """Three pins whose mean is the origin is not enough to prove the pins are
    RIGHT: permuting PIN_OFFSETS to ((-2,0),(1,-1),(1,1)) keeps the count,
    keeps the mean, and rewires base and collector. So each node's pin is
    asserted as a coordinate — for Q, for M, and for the graph the wires use.

    Offsets (1,-1), (-2,0), (1,1) at col 3 / row 8 (origin 30, 80) →
    drain/collector upper-right, gate/base left, source/emitter lower-right.
    """
    for kind, nodes in (('transistor', ['c', 'b', 'e']), ('mosfet', ['d', 'g', 's']),
                        ('jfet', ['d', 'g', 's'])):
        comp = schematic.Component('X', kind, nodes, 'mod', '', 3, 8, 0)
        assert comp.pins() == [(40.0, 70.0), (10.0, 80.0), (40.0, 90.0)], kind
        origin = comp.px()
        out_, ctrl_, src_ = comp.nodes
        by_node = dict(zip(comp.nodes, comp.pins()))
        assert by_node[ctrl_][0] < origin[0], 'control terminal must be on the gate side'
        assert by_node[out_][1] < origin[1] and by_node[out_][0] > origin[0]
        assert by_node[src_][1] > origin[1] and by_node[src_][0] > origin[0]


def test_jfet_and_mesfet_nodes_all_get_a_wire():
    """The failure the Q/M fix closed, still alive for the other multi-terminal
    classes: `J1 d g s Jmod` parsed 3 nodes (schematic documents that in
    _NODE_COUNT) but had no kind and so no third pin — the source net joined
    nothing and drew floating. `B` is the SPICE MESFET at 4 nodes."""
    deck = (
        '*jfet + mesfet\n'
        'V1 d 0 9\n'
        'Rg g 0 100k\n'
        'J1 d g s Jmod\n'
        'Rs s 0 470\n'
        'V2 bd 0 3\n'
        'Rbg bg 0 100k\n'
        'B1 bd bg bs bb Bmod\n'
        'Rbs bs 0 100\n'
        'V3 bb 0 0\n'
        '.model Jmod JFET\n.end\n'
    )
    graph = schematic.build_graph(deck, {'components': {}})
    by_ref = {c.ref: c for c in graph['components']}
    assert [by_ref['J1'].kind, by_ref['B1'].kind] == ['jfet', 'mesfet']
    assert len(by_ref['J1'].pins()) == 3
    assert len(by_ref['B1'].pins()) == 4
    # Every node of both parts shares a net with another pin, so each must
    # appear in the emitted wires — that is the observable the break hid.
    wire_nets = {w.nodes[0] for w in graph['wires']}
    for node in ('d', 'g', 's', 'bd', 'bg', 'bs', 'bb'):
        assert node in wire_nets, f'net {node} has no wire'
    # MESFET bulk is the 4th pin and the pin mean is still the layout origin.
    pins = by_ref['B1'].pins()
    assert (sum(x for x, _ in pins) / 4, sum(y for _, y in pins) / 4) == by_ref['B1'].px()
    assert len(set(pins)) == 4
    # SPICE node order ND NG NS NB, so pin 3 is the bulk and it sits on the
    # gate side — the terminal the old code never had.
    b1 = schematic.Component('B1', 'mesfet', ['bd', 'bg', 'bs', 'bb'], 'Bmod', '', 3, 8, 0)
    assert b1.pins() == [(50.0, 70.0), (10.0, 75.0), (50.0, 90.0), (10.0, 85.0)]
    # …and the symbol draws a lead for it, instead of routing a wire to a pin
    # that hangs in empty air beside a two-terminal-looking part.
    bsvg = '\n'.join(schematic._symbol_svg(b1, '#334155', None, None))
    assert 'x1="10" y1="85"' in bsvg, bsvg


def test_more_nodes_than_the_table_generates_pins_instead_of_dropping_them():
    """The `pin_offsets` guarantee, asserted on a kind whose table entry has
    two offsets: an unrecognised device letter with five nodes. No node may
    lose its pin, and the generated set must keep the editor's invariant — a
    pin mean exactly on the layout origin, with distinct positions."""
    comp = schematic.Component('Z1', 'part', ['a', 'b', 'c', 'd', 'e'], '', '', 3, 8, 0)
    pins = comp.pins()
    assert len(pins) == 5
    assert len(set(pins)) == 5, pins
    assert (sum(x for x, _ in pins) / 5, sum(y for _, y in pins) / 5) == comp.px()
    # A 2-node unknown part keeps the horizontal pair, not the generator.
    assert schematic.Component('Z2', 'part', ['a', 'b'], '', '', 3, 8, 0).pins() == [
        (10.0, 80.0), (50.0, 80.0)]


def test_every_generated_pin_also_gets_a_drawn_lead():
    """Pins alone are not enough: the generic symbol is drawn between pins 0 and
    1, so a 3-pin `X` instance or a 5-node unknown part left pin 2 (and beyond)
    with a wire landing on nothing. `_symbol_svg` used to stub only `ps[3:]`,
    which assumed the three-terminal FET body. Reproduced on a 3-pin subckt."""
    three = schematic.Component('X1', 'subckt', ['a', 'b', 'c'], 'BLK', '', 3, 8, 0)
    svg = '\n'.join(schematic._symbol_svg(three, '#334155', None, None))
    for (px_, py_) in three.pins()[2:]:
        assert f'x1="{px_:.0f}" y1="{py_:.0f}"' in svg, f'pin {(px_, py_)} has no lead: {svg}'
    five = schematic.Component('Z1', 'part', ['a', 'b', 'c', 'd', 'e'], '', '', 3, 8, 0)
    svg5 = '\n'.join(schematic._symbol_svg(five, '#334155', None, None))
    for (px_, py_) in five.pins()[2:]:
        assert f'x1="{px_:.0f}" y1="{py_:.0f}"' in svg5, f'pin {(px_, py_)} has no lead'
    # A 2-terminal part draws no stubs at all — the body IS its two pins.
    two = schematic.Component('R1', 'resistor', ['a', 'b'], '1k', '', 3, 8, 0)
    assert '\n'.join(schematic._symbol_svg(two, '#334155', None, None)).count('stroke-width="1.5"') == 0


def test_subckt_instance_uses_its_declared_pin_count():
    """An `X` line's node count is whatever the `.subckt` it names declares. It
    was sliced to 2, so a 4-pin block kept nets 3 and 4 off the graph (no pin,
    no wire) and the sidecar drew the block as two-terminal."""
    deck = (
        '*amp\n'
        'V1 vin 0 1\n'
        'X1 vin n2 a out AMP\n'
        'Rl a 0 1k\n'
        'Rs n2 0 1k\n'
        'Rf out vin 10k\n'
        '.subckt AMP p1 p2 p3 p4\n'
        'R1 p1 p2 1k\n'
        '.ends\n.end\n'
    )
    els = schematic.parse_elements(deck)
    x1 = next(e for e in els if e.ref == 'X1')
    assert x1.nodes == ['vin', 'n2', 'a', 'out'], x1
    graph = schematic.build_graph(deck, {'components': {}})
    comp = next(c for c in graph['components'] if c.ref == 'X1')
    assert len(comp.pins()) == 4
    wire_nets = {w.nodes[0] for w in graph['wires']}
    for node in ('vin', 'n2', 'a', 'out'):
        assert node in wire_nets, f'net {node} has no wire'
    # A block defined elsewhere (.lib) has no pin count in this deck: the
    # 2-node default must stay rather than guessing from the token count.
    loose = schematic.parse_elements('* no def\nX1 a b MISSING\n.end\n')
    assert [e.nodes for e in loose if e.ref == 'X1'] == [['a', 'b']]


def test_vertical_symbol_renders_on_its_own_pins():
    """The rotated group must land where pins() says, or the artifact and the
    editor draw two different circuits."""
    comp = _part(3, 8, 1)
    svg = '\n'.join(schematic._symbol_svg(comp, '#334155', None, None))
    match = re.search(r'transform="translate\(([-\d.]+) ([-\d.]+)\) rotate\(90\)"', svg)
    assert match, f'no rotate-90 group in {svg[:200]}'
    drawn = (float(match.group(1)), float(match.group(2)))
    assert drawn == comp.px()

    # …and it must be inside the picture: the viewBox is built from pins and
    # wire points, so a displaced body fell off the canvas entirely.
    graph = schematic.build_graph(
        '* t\nR1 a b 1k\n.end\n', {'components': {'R1': {'col': 3, 'row': 8, 'rot': 1}}},
    )
    box = [float(v) for v in re.search(
        r'viewBox="([-\d. ]+)"', schematic.render_svg(graph)
    ).group(1).split()]
    assert box[0] <= drawn[0] <= box[0] + box[2]
    assert box[1] <= drawn[1] <= box[1] + box[3]


def _diagonals(points: list[tuple[float, float]]):
    return [(a, b) for a, b in zip(points, points[1:])
            if a[0] != b[0] and a[1] != b[1]]


def test_auto_routed_wires_are_orthogonal():
    """build_graph promises "orthogonal (Manhattan) polylines". Stepping from
    the bus straight to the next pin broke that whenever x AND y both changed —
    which was true even in a pristine auto layout."""
    layouts = [
        {'components': {}},
        {'components': {'R1': {'col': 3, 'row': 8, 'rot': 0}}},
        {'components': {'R2': {'col': -2, 'row': 1, 'rot': 1}}},
    ]
    for layout in layouts:
        graph = schematic.build_graph(DECK, layout)
        for wire in graph['wires']:
            assert not _diagonals(wire.points), (
                f'{layout} net {wire.nodes} routed diagonally: {wire.points}'
            )


def _ground_bars(comp: schematic.Component) -> list[float]:
    """x-centres of the ground bars drawn for a source (bars are stroke-width 1.5)."""
    svg = '\n'.join(schematic._symbol_svg(comp, '#334155', None, None))
    return [
        (float(m.group(1)) + float(m.group(2))) / 2
        for m in re.finditer(
            r'<line x1="([-\d.]+)" y1="[-\d.]+" x2="([-\d.]+)" y2="[-\d.]+"[^>]*stroke-width="1\.5"',
            svg,
        )
    ]


def test_ground_sits_on_the_pin_that_is_actually_zero():
    left = schematic.Component('V1', 'voltage', ['0', 'out'], '5', '', 3, 8, 0)
    right = schematic.Component('V1', 'voltage', ['in', '0'], '5', '', 3, 8, 0)
    floating = schematic.Component('V1', 'voltage', ['a', 'b'], '5', '', 3, 8, 0)

    assert _ground_bars(left) and _ground_bars(left)[0] == left.pins()[0][0]
    # `V1 in 0 5` is the common spelling, and the editor used to bar the LEFT
    # pin for it — the opposite pin to the artifact.
    assert _ground_bars(right) and _ground_bars(right)[0] == right.pins()[1][0]
    assert _ground_bars(floating) == [], 'a source with no ground got a ground symbol'


def test_subckt_body_is_not_drawn_at_top_level():
    deck = """* lp
Vin in 0 5
X1 in out LPF
Rload out 0 10k
.subckt LPF i o
Rc i n1 1k
Cc n1 o 1u
.ends
.end
"""
    refs = {e.ref for e in schematic.parse_elements(deck)}
    assert refs == {'Vin', 'X1', 'Rload'}
    # The private nodes stay private, so the box is not joined by free parts.
    assert not ({'i', 'n1'} & set(schematic.deck_nodes(schematic.parse_elements(deck))))


def test_read_schematic_writes_nothing(tmp_path: Path):
    """`circuit_read_schematic` is filed under read-only ("writes nothing") and
    is allowed in plan mode; inline text used to materialise a scratch deck."""
    result = circuit_tools.read_schematic(DECK, workspace=str(tmp_path))
    assert len(result['components']) == 4
    # Assert the invariant, not an empty tree — the harness keeps app data here.
    stray = [p.name for p in tmp_path.iterdir() if p.suffix in {'.cir', '.json'}
             and (p.name.startswith('_schematic') or p.name.endswith('.layout.json'))]
    assert stray == [], f'a read wrote into the workspace: {stray}'


def test_single_line_inline_deck_is_text_not_a_path(tmp_path: Path):
    """"V1 in 0 5" is a deck. It used to raise `File not found: V1 in 0 5`
    because the inline/path decision keyed on the absence of a newline."""
    result = circuit_tools.read_schematic('V1 in 0 5', workspace=str(tmp_path))
    assert [c['ref'] for c in result['components']] == ['V1']


def test_a_rejected_wire_route_leaves_the_sidecar_untouched(tmp_path: Path):
    """write_layout ran before build_graph validated the coordinates, so one
    non-numeric point persisted a corrupt sidecar and every later read and
    edit of that deck failed until an auto=True reset."""
    deck = _write_deck(tmp_path)
    with pytest.raises(ValueError, match='numeric'):
        circuit_tools.edit_schematic(
            str(deck), wire_routes={'out': [['a', 'b'], ['c', 'd']]}, workspace=str(tmp_path),
        )
    assert not schematic.layout_path_for(deck).exists(), 'failed edit wrote a sidecar'
    assert len(circuit_tools.read_schematic(str(deck), workspace=str(tmp_path))['components']) == 4


def test_inline_decks_do_not_share_one_scratch_layout(tmp_path: Path):
    """The scratch deck had a fixed name, so a second inline deck inherited the
    first one's positions through its sidecar."""
    circuit_tools.edit_schematic(
        DECK, moves=[{'ref': 'R1', 'col': 7, 'row': 3}], workspace=str(tmp_path),
    )
    other = '* other\nIa x 0 2m\nLb x y 10m\n.end\n'
    graph = circuit_tools.edit_schematic(other, workspace=str(tmp_path))
    by_ref = {c['ref']: (c['col'], c['row']) for c in graph['components']}
    assert by_ref['Lb'] != (7.0, 3.0), 'second deck inherited the first deck layout'


def test_ngspice_builtin_constants_are_not_measures():
    """Server mode's `print all` answers with pi, boltz, yes and true. For a
    deck with no analysis card those were the ONLY matches, so an .op run
    reported exitCode 0 and physics constants as node voltages."""
    assert circuit_tools._is_ngspice_constant('pi', DECK) is True
    assert circuit_tools._is_ngspice_constant('f3db', DECK) is False
    assert circuit_tools._is_ngspice_constant('boltz', DECK) is True
    # `c` and `e` are ordinary net names — a deck that nets one keeps its value.
    node_c = '* c\nV1 a c 5\nR1 c 0 1k\n.end\n'
    assert circuit_tools._is_ngspice_constant('c', node_c) is False, 'node "c" discarded'
    assert circuit_tools._is_ngspice_constant('c', DECK) is True
    assert circuit_tools._is_ngspice_constant('out', DECK) is False


# ── The drawing must be legible, not merely well-formed ────────────────────
# Orthogonal wires and separated pins can all pass while the picture is still
# unreadable: the auto-layout used to drop every part in column 0 so each net
# became a long rail, labels printed on top of the symbol bodies, and the panel
# title overprinted the first part. These measure the boxes the renderer emits.

_ROUND_BODY = {'voltage': 11, 'isource': 11, 'transistor': 14, 'mosfet': 14}

TOPOLOGIES = {
    'rc-lowpass': '* RC\nVin in 0 5\nR1 in out 1k\nC1 out 0 1u\n.end\n',
    'divider': '* div\nV1 top 0 10\nR1 top mid 1k\nR2 mid 0 2k\n.end\n',
    'rlc': '* rlc\nV1 n1 0 5\nR1 n1 n2 10\nL1 n2 n3 1m\nC1 n3 0 100n\n.end\n',
    'led': '* led\nV1 an 0 5\nR1 an k 330\nD1 k 0 LED\n.model LED D\n.end\n',
    'bjt': '* bjt\nV1 c 0 9\nRb b 0 100k\nQ1 c b e Qmod\nRe e 0 470\n.model Qmod NPN\n.end\n',
    'isource': '* i\nI1 n 0 2m\nR1 n 0 1k\n.end\n',
    'branching': '* fan\nV1 a 0 12\nR1 a b 1k\nR2 b c 2k\nR3 c 0 3k\nC1 b d 1u\nD1 d 0 LED\n.end\n',
    'subckt': '* sub\nVin in 0 5\nX1 in out LPF\nRload out 0 10k\n'
              '.subckt LPF i o\nRc i n1 1k\nCc n1 o 1u\n.ends\n.end\n',
}


def _body_box(comp: schematic.Component) -> tuple[float, float, float, float]:
    xs = [p[0] for p in comp.pins()]
    ys = [p[1] for p in comp.pins()]
    half = _ROUND_BODY.get(comp.kind, 8)
    if comp.rot % 2:
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        return (cx - half, cy - (max(xs) - min(xs)) / 2, cx + half, cy + (max(xs) - min(xs)) / 2)
    return (min(xs), min(ys) - half, max(xs), max(ys) + half)


def _label_box(comp: schematic.Component) -> tuple[float, float, float, float]:
    # Mean of ALL pins — the label anchors on the body centre, which for a
    # 3-terminal part is not the pins[0]/pins[1] midpoint (that pair is
    # collector/base and sits half a cell off the origin).
    pins = comp.pins()
    cx = sum(p[0] for p in pins) / len(pins)
    cy = sum(p[1] for p in pins) / len(pins)
    gap = 26 if comp.kind in _ROUND_BODY else 20
    half_w = 6.2 * len(f'{comp.ref} {comp.value}'.strip()) / 2
    return (cx - half_w, cy - gap - 10, cx + half_w, cy - gap + 2)


def _clash(a, b) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


@pytest.mark.parametrize('name,deck', sorted(TOPOLOGIES.items()))
def test_rendered_topology_has_no_collisions(name: str, deck: str):
    graph = schematic.build_graph(deck, {'grid': schematic.GRID, 'components': {}})
    parts = graph['components']
    assert len(parts) >= 2, f'{name} degenerated to {len(parts)} parts'

    bodies = {c.ref: _body_box(c) for c in parts}
    labels = {c.ref: _label_box(c) for c in parts}
    refs = sorted(bodies)

    for i, a in enumerate(refs):
        for b in refs[i + 1:]:
            assert not _clash(bodies[a], bodies[b]), f'{name}: bodies {a}/{b} overlap'
            assert not _clash(labels[a], labels[b]), f'{name}: labels {a}/{b} overlap'
    for a in refs:
        for b in refs:
            assert not _clash(labels[a], bodies[b]), f'{name}: label {a} sits on body {b}'

    # The title is painted at (minx+8, miny+20) over a viewBox built from pins.
    xs = [p[0] for c in parts for p in c.pins()]
    ys = [p[1] for c in parts for p in c.pins()]
    minx, miny = min(xs) - 40, min(ys) - 40 - 26
    title = (minx + 8, miny + 8, minx + 8 + 7.5 * len(name), miny + 22)
    for ref in refs:
        assert not _clash(title, bodies[ref]), f'{name}: title overlaps body {ref}'
        assert not _clash(title, labels[ref]), f'{name}: title overlaps label {ref}'


def test_an_instance_node_named_like_another_subckt_does_not_truncate_the_call():
    """`X1 ain aout VREF ADC` declares a 3-pin ADC whose third node happens to
    be named like the `VREF` block defined in the same deck. Locating the called
    name by scanning LEFT-to-RIGHT stopped at that node, sliced the instance to
    two nets and dropped the VREF pin — the same silence the pin work exists to
    remove, reintroduced by the locator itself. Scan from the right, skip `k=v`
    params, and clamp the slice to the declared pin count."""
    deck = (
        '* colliding names\n'
        '.subckt VREF p n\n'
        'Rv p n 1k\n'
        '.ends\n'
        '.subckt ADC ain aout vref\n'
        'Ca ain aout 1u\n'
        '.ends\n'
        'X1 ain aout VREF ADC\n'
        'R1 VREF 0 10k\n'
        'V1 ain 0 1\n'
        '.end\n'
    )
    x1 = next(e for e in schematic.parse_elements(deck) if e.ref == 'X1')
    assert x1.nodes == ['ain', 'aout', 'VREF'], x1
    graph = schematic.build_graph(deck, {'components': {}})
    assert 'VREF' in {w.nodes[0] for w in graph['wires']}, 'the ADC lost its reference pin'
    comp = next(c for c in graph['components'] if c.ref == 'X1')
    assert len(comp.pins()) == 3


def test_a_short_call_on_a_wider_block_invents_no_net_from_the_name():
    """The clamp matters: 2 supplied nodes for a 3-pin block must not pull the
    block's own name into the node list to make the count."""
    deck = '* short\n.subckt FOO a b c\n.ends\nX1 a b FOO gain=10\nR2 b 0 1\n.end\n'
    x1 = next(e for e in schematic.parse_elements(deck) if e.ref == 'X1')
    assert x1.nodes == ['a', 'b'], x1
    assert 'gain=10' not in x1.nodes


def test_the_called_block_is_the_last_param_free_token_not_a_known_name():
    """Locating `X`'s block by asking "is this token a subckt defined here" is
    the wrong predicate: with `ADC` defined outside the deck (a `.lib`) and a
    NODE named `VREF` that matches a block that IS defined here, the search
    stopped at the node and truncated the call again. SPICE puts the name after
    the nodes, so the name is simply the last token that is not a `k=v` param."""
    deck = """* lib-called
.subckt VREF p n
Rv p n 1k
.ends
X1 ain aout vref ADC
R1 vref 0 10k
V1 ain 0 1
.end
"""
    x1 = next(e for e in schematic.parse_elements(deck) if e.ref == 'X1')
    assert x1.nodes == ['ain', 'aout', 'vref'], x1
    graph = schematic.build_graph(deck, {'components': {}})
    wired = {w.nodes[0] for w in graph['wires']}
    assert 'vref' in wired, f'the node that matches a block name lost its wire: {sorted(wired)}'


def test_the_switch_class_carries_its_control_nets_and_coupling_draws_no_part():
    """Two named classes the pin work still got wrong. `Sxxx N+ N- NC+ NC- MODEL`
    is a FOUR-net device — sliced to two, the control pair joined nothing, and
    `Kxxx L1 L2 0.9` is mutual coupling whose tokens are REFDES: treating it as an
    element invented two nets called L1/L2, drew a two-terminal part between them
    and joined them with a wire that exists in no circuit. The deck line is what
    the simulator reads, so dropping it from the drawing loses nothing."""
    deck = (
        '* switch + coupling\n'
        'S1 a b c d SWMOD\n'
        'R1 a b 1k\n'
        'R2 c d 1k\n'
        'K1 L1 L2 0.9\n'
        'L1 in mid 1u\n'
        'L2 mid out 1u\n'
        'V1 in 0 5\n'
        '.end\n'
    )
    els = schematic.parse_elements(deck)
    s1 = next(e for e in els if e.ref == 'S1')
    assert s1.nodes == ['a', 'b', 'c', 'd'], s1
    assert not any(e.ref == 'K1' for e in els), 'a coupling line must not be an element'
    graph = schematic.build_graph(deck, {'components': {}})
    assert not any(c.ref == 'K1' for c in graph['components'])
    assert 'L1' not in graph['nodes'] and 'L2' not in graph['nodes'], graph['nodes']
    wired = {w.nodes[0] for w in graph['wires']}
    assert {'a', 'b', 'c', 'd'} <= wired, f'control nets unwired: {sorted({"a","b","c","d"} - wired)}'
    # `W` is current-controlled: its third token names a voltmeter, not a net.
    w_line = next(e for e in schematic.parse_elements('* w\nW1 x y Vswitch WMOD\nR3 x y 1\n.end\n'))
    assert w_line.nodes == ['x', 'y'], w_line


def test_the_fet_family_gets_the_tall_row_spacing():
    """Auto-layout reserves extra room for three-terminal silicon so the current
    annotation does not print over the next part. The list was a literal pair of
    kind names, so the two FETs added by this batch (`jfet`, `mesfet`) were
    treated as 2-terminal and their labels collided — the same class of miss as
    the drawing branch, in the layout instead."""
    def spread(kind: str, nodes: list[str]) -> float:
        els = [
            schematic.Element(ref=f'{kind[0].upper()}{i}', kind=kind, nodes=nodes, value='M')
            for i in (1, 2, 3)
        ]
        rows = [p['row'] for p in schematic.auto_layout(els).values()]
        return max(rows) - min(rows)

    narrow = spread('resistor', ['a', 'b'])
    for kind, nodes in (
        ('transistor', ['c', 'b', 'e']),
        ('mosfet', ['d', 'g', 's']),
        ('jfet', ['d', 'g', 's']),
        ('mesfet', ['d', 'g', 's', 'b']),
    ):
        wide = spread(kind, nodes)
        assert wide > narrow, f'{kind} spaced like a 2-terminal part: {wide} vs {narrow}'


# ── Card arity, measured against the ngspice the app ships ───────────────
# Each rule below was checked by running the bundled `ngspice_con.exe` on the
# card form and reading its verdict, so the table records what the simulator
# accepts rather than what a reference elsewhere says. `ACCEPTED` / `ERROR:`
# in the comments are those results.


def test_mosfet_bulk_node_is_not_dropped():
    """`M1 d g s b mm` — ngspice: 4 nodes REQUIRED (`M1 d g s mm` is rejected
    with "could not find a valid modelname", because it reads `mm` as the bulk
    and then looks for a model).

    The table sliced MOSFET to 3, so the bulk net became the tail and the
    schematic drew a 3-terminal part with no wire to the bulk — on a deck that
    simulated fine. The app's own part help says
    `M1 drain gate source source <part> (bulk tied to source)`, which is four
    nets, so the parser disagreed with the tool's own documentation.
    """
    els = {e.ref: e for e in schematic.parse_elements(
        '* m\n.model mm nmos level=1\nV1 d 0 5\nM1 d g s b mm\n.end\n'
    )}
    assert els['M1'].nodes == ['d', 'g', 's', 'b'], els['M1'].nodes
    assert els['M1'].params.startswith('mm') or els['M1'].value == 'mm' or 'mm' in els['M1'].params


def test_mesfet_model_name_is_not_a_net():
    """`B1 d g s bm` is the 3-node MESFET (ngspice: ACCEPTED). The table said 4,
    so the model name was sliced in as the fourth node — a net called `bm` that
    no wire connects to, which is the false-open-circuit this file exists to
    remove, invented rather than dropped."""
    els = {e.ref: e for e in schematic.parse_elements(
        '* b\n.model bm nfet\nV1 d 0 5\nB1 d g s bm\n.end\n'
    )}
    assert els['B1'].nodes == ['d', 'g', 's'], els['B1'].nodes


def test_mesfet_four_terminal_card_keeps_all_four():
    """The 4-terminal MESFET form is also accepted by ngspice, so the count has
    to come from the card, not from the letter."""
    els = {e.ref: e for e in schematic.parse_elements(
        '* b4\n.model bm nfet\nV1 d 0 5\nB1 d g s x bm\n.end\n'
    )}
    assert els['B1'].nodes == ['d', 'g', 's', 'x'], els['B1'].nodes


def test_behavioural_b_source_is_two_nodes_not_a_mesfet():
    """`Bxxx` names two devices. A card carrying `V=`/`I=` is XSPICE's
    behavioural source (`B1 out 0 V=(in*2)`), whose expression is not a net; a
    bare trailing token is the MESFET model name. Telling them apart by that
    parameter is what keeps `V=(in*2)` from being drawn as a third terminal."""
    els = {e.ref: e for e in schematic.parse_elements(
        '* bsrc\nV1 in 0 5\nB1 out 0 V=(in*2)\n.end\n'
    )}
    assert els['B1'].nodes == ['out', '0'], els['B1'].nodes


def test_bjt_substrate_form_and_plain_form_both_count_from_the_card():
    """`Q1 c b e qm` (3) and `Q1 c b e s qm` (4, substrate) are both accepted,
    so a fixed count is wrong for one of them by construction."""
    three = {e.ref: e for e in schematic.parse_elements(
        '* q\n.model qm npn\nV1 c 0 5\nQ1 c b 0 qm\n.end\n'
    )}
    four = {e.ref: e for e in schematic.parse_elements(
        '* q4\n.model qm npn\nV1 c 0 5\nQ1 c b e s qm\n.end\n'
    )}
    assert three['Q1'].nodes == ['c', 'b', '0'], three['Q1'].nodes
    assert four['Q1'].nodes == ['c', 'b', 'e', 's'], four['Q1'].nodes


def test_short_switch_card_does_not_swallow_its_model():
    """`Sxxx NC+ NC- N+ N- MODEL` is four nets, and the table now says so — but
    only when the card is long enough to have a model left over. Slicing 4 from
    `S1 a 0 sw` would name the model as a net."""
    full = {e.ref: e for e in schematic.parse_elements(
        '* s\nV1 a 0 5\nV2 c 0 5\nS1 a 0 c 0 smod\n.end\n'
    )}
    short = {e.ref: e for e in schematic.parse_elements(
        '* s2\nV1 a 0 5\nS1 a 0 smod\n.end\n'
    )}
    assert full['S1'].nodes == ['a', '0', 'c', '0'], full['S1'].nodes
    assert short['S1'].nodes == ['a', '0'], short['S1'].nodes


def test_jfet_is_three_nodes_and_its_model_stays_out():
    els = {e.ref: e for e in schematic.parse_elements(
        '* j\n.model jm njf\nV1 d 0 5\nJ1 d g s jm\n.end\n'
    )}
    assert els['J1'].nodes == ['d', 'g', 's'], els['J1'].nodes


def test_continuation_line_does_not_lose_the_tail_of_a_card():
    """A `+` line extends the PREVIOUS card; it is not a card of its own. The
    parser skipped it outright, so every token past the break vanished — and for
    a device card the tail is the model name and, in the 4-terminal forms, a real
    net. ngspice ran the deck whole, so the circuit simulated while its drawing
    was missing a wire.

    This deck is the MOSFET with the bulk on the continuation: the bulk net is
    the exact token class the old skip dropped.
    """
    wrapped = schematic.parse_elements(
        '* wrapped card\n'
        '.model mm nmos level=1\n'
        'V1 d 0 5\n'
        'M1 d g s\n'
        '+ b mm\n'
        '.end\n'
    )
    by_ref = {e.ref: e for e in wrapped}
    assert by_ref['M1'].nodes == ['d', 'g', 's', 'b'], by_ref['M1'].nodes
    # A passive split the same way keeps its value.
    value_split = {e.ref: e for e in schematic.parse_elements(
        '* split value\nV1 a 0 5\nR1 a 0\n+ 4.7k\n.end\n'
    )}
    assert value_split['R1'].value.startswith('4.7k'), value_split['R1'].value
    # The card after a blank line must not absorb its continuation.
    after_gap = {e.ref: e for e in schematic.parse_elements(
        '* gap\nV1 a 0 5\nR1 a 0 1k\n\n+ 2k\nC1 b 0 3u\n.end\n'
    )}
    assert after_gap['C1'].nodes == ['b', '0']
    assert '+ 2k' not in after_gap['R1'].value


def test_control_block_lines_are_not_merged_into_each_other():
    """`.control` bodies are simulator commands. Joining their continuations
    into the previous line would corrupt a command ngspice runs as written, so
    the join deliberately stops at the block boundary."""
    deck = (
        '* ctrl\nV1 a 0 5\nR1 a 0 1k\n.control\nop\nprint v(a)\n+\n   more\n.endc\n.end\n'
    )
    lines = schematic.logical_lines(deck)
    assert any(ln.startswith('print v(a)') for ln in lines)
    assert not any('print v(a) more' in ln for ln in lines), lines
    # The deck still parses the two cards it should.
    assert {e.ref for e in schematic.parse_elements(deck)} == {'V1', 'R1'}


def test_the_three_card_readers_agree_on_a_deck():
    """One rule, three call sites that used to have three copies of it.

    `schematic.parse_elements` (the drawing), `circuit_tools._parse_components`
    (the live overview), `circuit_tools.read_netlist` (the component listing) and
    `circuit_tools.lint_netlist` (the pre-simulation warning) each held their own
    node table, and they disagreed on the same text: the overview sliced `Q1 c b e
    Qmod` to four and so invented a net called `Qmod`, the listing and the linter
    accepted a 3-node MOSFET that ngspice rejects, and the drawing dropped the
    bulk. A deck could pass the linter, list one thing in the UI and draw
    another, with no check able to see the gap because each copy was tested
    against itself.
    """
    from app.services.tools import circuit_tools as ct

    deck = (
        '* one of each\n'
        '.model mm nmos level=1\n'
        '.model qm npn\n'
        '.model jm njf\n'
        '.model bm nfet\n'
        'V1 d 0 5\n'
        'M1 d g s b mm\n'
        'Q1 c b 0 qm\n'
        'J1 d g s jm\n'
        'B1 d g s bm\n'
        '.end\n'
    )
    expected = {
        'M1': ['d', 'g', 's', 'b'],
        'Q1': ['c', 'b', '0'],
        'J1': ['d', 'g', 's'],
        'B1': ['d', 'g', 's'],
    }
    drawn = {e.ref: e.nodes for e in schematic.parse_elements(deck)}
    for ref, nodes in expected.items():
        assert drawn[ref] == nodes, f'the drawing sliced {ref} as {drawn[ref]}'

    overview = {c.ref: c.nodes for c in ct._parse_components(deck)}
    for ref in expected:
        assert overview[ref] == drawn[ref], (
            f'{ref}: overview {overview[ref]} vs drawing {drawn[ref]}'
        )

    assert not ct.lint_netlist(deck), 'the linter rejects a deck ngspice accepts'
    short = '* short mosfet\n.model mm nmos level=1\nV1 d 0 5\nM1 d g s mm\n.end\n'
    warns = ct.lint_netlist(short)
    assert any('M1' in w and '4 nodes' in w for w in warns), (
        f'the linter let a 3-node MOSFET through to the simulator: {warns}'
    )
    short_els = {e.ref: e for e in schematic.parse_elements(short)}
    assert short_els['M1'].nodes == ['d', 'g', 's'], (
        f"the drawing invented a net out of the model name: {short_els['M1'].nodes}"
    )
