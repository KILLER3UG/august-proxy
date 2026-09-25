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
