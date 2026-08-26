"""Circuit workbench tests — mode gate, netlist CRUD, 3D board render.

``simulate_circuit``'s no-ngspice guidance path lives in
test_artifact_tools.py (shared module); here we lock the /circuit gating
behavior that keeps the tools invisible outside circuit mode.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.services.tool_registrations.circuit_tools import (
    filter_circuit_tools,
    maybe_intercept_circuit,
)
from app.services.tools import circuit_tools  # noqa: I001 — app imports last


def _session() -> SimpleNamespace:
    return SimpleNamespace(metadata={}, workspacePath='')


def test_circuit_command_toggles_mode():
    s = _session()
    payload = maybe_intercept_circuit(s, '/circuit')
    assert payload is not None and payload['circuitMode'] is True
    assert circuit_tools.is_circuit_mode(s) is True

    off = maybe_intercept_circuit(s, '/circuit off')
    assert off is not None and off['circuitMode'] is False
    assert circuit_tools.is_circuit_mode(s) is False


def test_non_command_messages_pass_through():
    s = _session()
    assert maybe_intercept_circuit(s, 'design a PSU') is None
    assert maybe_intercept_circuit(s, '') is None


def test_tool_filter_hides_and_exposes():
    s = _session()
    tools = [{'name': 'run_command'}, {'name': 'circuit_simulate'}, {'name': 'write_file'}]
    hidden = filter_circuit_tools(tools, s)
    assert [t['name'] for t in hidden] == ['run_command', 'write_file']
    circuit_tools.set_circuit_mode(s, True)
    shown = filter_circuit_tools(tools, s)
    assert len(shown) == 3
    # Session without the flag at all (fresh sessions) stays hidden.
    bare = filter_circuit_tools(tools, SimpleNamespace(metadata={}))
    assert len(bare) == 2


def test_netlist_crud_roundtrip(tmp_path):
    ws = str(tmp_path)
    created = circuit_tools.create_netlist(
        'divider.cir',
        'V1 in 0 DC 10\nR1 in out 1k\nR2 out 0 1k',
        workspace=ws,
    )
    assert created['path'].endswith('divider.cir')

    read = circuit_tools.read_netlist('divider.cir', workspace=ws)
    kinds = [c['type'] for c in read['components']]
    assert kinds == ['V', 'R', 'R']
    assert read['content'].rstrip().endswith('.end')

    circuit_tools.update_netlist('divider.cir', 'DC 10', 'DC 12', workspace=ws)
    after = circuit_tools.read_netlist('divider.cir', workspace=ws)
    assert 'DC 12' in after['content']

    deleted = circuit_tools.delete_netlist('divider.cir', workspace=ws)
    assert deleted['deleted'].endswith('divider.cir')
    with pytest.raises(ValueError):
        circuit_tools.read_netlist('divider.cir', workspace=ws)


def test_render_board_3d_writes_png(tmp_path):
    ws = str(tmp_path)
    result = circuit_tools.render_board_3d(
        'board3d.png',
        'V1 in 0 DC 9\nR1 in out 470\nD1 out 0 1N4148\nC1 in 0 100u',
        width=40,
        height=30,
        workspace=ws,
    )
    assert result['componentCount'] == 4
    out = tmp_path / 'board3d.png'
    assert out.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n'


def test_simulate_reports_missing_ngspice(monkeypatch, tmp_path):
    monkeypatch.setattr(circuit_tools, 'resolve_ngspice', lambda: None)
    import asyncio

    result = asyncio.run(
        circuit_tools.simulate_circuit('V1 0 0 0\n.end', workspace=str(tmp_path))
    )
    assert result['installed'] is False
    assert 'ngspice' in result['error']


# ── Sim-vs-bench fidelity rules (distilled from KiCad/ngspice manuals) ────


def test_spice_scale_factors_milli_vs_mega():
    # ngspice Table 2.1: M = milli, Meg = mega — the classic bench bug.
    import math

    def close(a: float, b: float) -> bool:
        return math.isclose(a, b, rel_tol=1e-9)

    assert close(circuit_tools.parse_spice_value('1M'), 1e-3)
    assert close(circuit_tools.parse_spice_value('1Meg'), 1e6)
    assert close(circuit_tools.parse_spice_value('4.7k'), 4700)
    assert close(circuit_tools.parse_spice_value('100u'), 1e-4)
    assert close(circuit_tools.parse_spice_value('22n'), 22e-9)
    assert circuit_tools.parse_spice_value('2.2') == 2.2
    assert circuit_tools.parse_spice_value('junk') is None


def test_lint_catches_unit_and_ground_traps():
    # R value written as "1M" parses to a milliohm — must be flagged.
    warnings = circuit_tools.lint_netlist(
        '* t\nV1 in 0 DC 9\nR1 in out 1M\nC1 out 0 100\n'
    )
    joined = ' | '.join(warnings)
    assert 'Meg' in joined          # milli/mega confusion surfaced
    assert 'missing' in joined      # 100 F capacitor flagged
    # Missing ground must be flagged.
    warnings2 = circuit_tools.lint_netlist('* t\nV1 a b DC 5\nR1 a b 1k\n')
    assert any('ground' in w.lower() for w in warnings2)
    # Clean divider passes silent.
    clean = circuit_tools.lint_netlist(
        '* divider\nV1 in 0 DC 10\nR1 in out 1k\nR2 out 0 1k\n.end\n'
    )
    assert clean == []


def test_convergence_ladder_options_injection():
    deck = '* t\nV1 1 0 DC 5\nR1 1 2 1k\nR2 2 0 1k\n.end'
    out = circuit_tools._apply_options(deck, {'gmin': '1e-10'})
    assert '.options gmin=1e-10' in out
    assert out.strip().endswith('.end')
    # Existing .options line gets replaced, not duplicated.
    twice = circuit_tools._apply_options(out, {'gmin': '1e-9', 'abstol': '1e-9'})
    assert twice.count('.options') == 1
    # Empty options returns the deck untouched.
    assert circuit_tools._apply_options(deck, {}) is deck


# ── Board brain + search→integrate ────────────────────────────────────────


def test_list_boards_families():
    import asyncio

    all_boards = asyncio.run(circuit_tools.list_boards())
    assert all_boards['count'] >= 25
    esp = asyncio.run(circuit_tools.list_boards('esp32'))
    assert esp['count'] >= 5
    assert all('esp32' in name for name in esp['boards'])
    uno = asyncio.run(circuit_tools.list_boards('arduino'))
    assert any('uno' in n for n in uno['boards'])
    pico = asyncio.run(circuit_tools.list_boards('pico'))
    assert any('raspberry' in n for n in pico['boards'])


def test_integrate_component_actionable():
    import asyncio

    # Board query returns datasheet specs.
    r1 = asyncio.run(circuit_tools.integrate_component('ESP32-S3'))
    board = r1['integrated'].get('board')
    assert board and 'Xtensa LX7' in board.get('mcu', '')
    assert '3.3V' in str(board.get('logic', ''))

    # Part query returns a ready-to-paste SPICE model card.
    r2 = asyncio.run(circuit_tools.integrate_component('1n4148 diode'))
    assert '.model 1N4148 D(' in r2['integrated'].get('spiceModel', '')

    # BJT usage hint steers refdes/pin order.
    r3 = asyncio.run(circuit_tools.integrate_component('2N3904'))
    assert 'Q1 c b e' in r3['integrated'].get('usage', '')

    # Empty query errors cleanly.
    r4 = asyncio.run(circuit_tools.integrate_component(''))
    assert 'error' in r4
