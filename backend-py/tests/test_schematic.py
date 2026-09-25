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
    pins = comp.pins()
    cx = (pins[0][0] + pins[1][0]) / 2
    cy = (pins[0][1] + pins[1][1]) / 2
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
    xs = [v for c in parts for v in (c.pins()[0][0], c.pins()[1][0])]
    ys = [v for c in parts for v in (c.pins()[0][1], c.pins()[1][1])]
    minx, miny = min(xs) - 40, min(ys) - 40 - 26
    title = (minx + 8, miny + 8, minx + 8 + 7.5 * len(name), miny + 22)
    for ref in refs:
        assert not _clash(title, bodies[ref]), f'{name}: title overlaps body {ref}'
        assert not _clash(title, labels[ref]), f'{name}: title overlaps label {ref}'
