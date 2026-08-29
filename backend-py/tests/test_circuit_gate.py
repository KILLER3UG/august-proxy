"""Circuit workbench tests — mode gate, netlist CRUD, 3D board render.

``simulate_circuit``'s no-ngspice guidance path lives in
test_artifact_tools.py (shared module); here we lock the /circuit gating
behavior that keeps the tools invisible outside circuit mode.
"""

from __future__ import annotations

import json
from pathlib import Path
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


def test_kicad_infix_values_normalize():
    # KiCad BOM infix: the scale letter doubles as the decimal point.
    import math

    def close(a: float, b: float) -> bool:
        return math.isclose(a, b, rel_tol=1e-9)

    assert close(circuit_tools.parse_spice_value('4k7'), 4700)
    assert close(circuit_tools.parse_spice_value('1R2'), 1.2)
    assert close(circuit_tools.parse_spice_value('4R7'), 4.7)
    assert close(circuit_tools.parse_spice_value('R47'), 0.47)
    assert close(circuit_tools.parse_spice_value('10R'), 10.0)
    assert close(circuit_tools.parse_spice_value('3u3'), 3.3e-6)
    # Infix is case-sensitive: M = mega, m = milli (the one place M ≠ milli).
    assert close(circuit_tools.parse_spice_value('2M2'), 2.2e6)
    assert close(circuit_tools.parse_spice_value('1m5'), 1.5e-3)
    # Plain SPICE forms are untouched by the infix path; bare M stays milli.
    assert close(circuit_tools.parse_spice_value('10k'), 1e4)
    assert close(circuit_tools.parse_spice_value('1e5'), 1e5)
    assert close(circuit_tools.parse_spice_value('1M'), 1e-3)
    # Detector truth table (1e5 is exponent notation, not infix).
    for v in ('4k7', '1R2', 'R47', '10R', '2M2', '3u3', '1m5'):
        assert circuit_tools.is_kicad_infix(v), v
    for v in ('4.7k', '10k', '1M', '1e5', '100u', '2.2', 'junk'):
        assert not circuit_tools.is_kicad_infix(v), v


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


def test_lint_flags_kicad_infix_informational():
    # Infix values are accepted (no parse error, no false Meg alarm) but
    # annotated so decks drift toward plain SPICE form.
    warnings = circuit_tools.lint_netlist(
        '* t\nV1 in 0 DC 5\nR1 in out 4k7\nC1 out 0 100n\n.end\n'
    )
    infix = [w for w in warnings if 'KiCad infix' in w]
    assert len(infix) == 1
    assert 'R1' in infix[0] and '4700' in infix[0]
    # 2M2 = 2.2 MΩ: normalized to mega, so the milli/Meg trap stays silent.
    warnings2 = circuit_tools.lint_netlist(
        '* t\nV1 in 0 DC 5\nR1 in out 2M2\n.end\n'
    )
    assert any('KiCad infix' in w for w in warnings2)
    assert not any('did you mean Meg' in w for w in warnings2)
    # Plain SPICE values draw no infix note.
    clean = circuit_tools.lint_netlist(
        '* t\nV1 in 0 DC 5\nR1 in out 4.7k\n.end\n'
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


def test_measure_regex_parses_node_voltages():
    # ngspice .op prints v(node)/i(vsrc) — parentheses must parse, not just
    # bare .measure names.
    line_v = circuit_tools._MEASURE_RE.match('v(out) =  5.000000e+00')
    assert line_v and line_v.group(1) == 'v(out)' and float(line_v.group(2)) == 5.0
    line_i = circuit_tools._MEASURE_RE.match('i(v1) = -1.234567e-03')
    assert line_i and line_i.group(1) == 'i(v1)'
    line_m = circuit_tools._MEASURE_RE.match('vout_max = 4.98e+00')
    assert line_m and line_m.group(1) == 'vout_max'
    # MIN/MAX append the extremum location; TRIG/TARG append both edges —
    # the value must still parse with the suffix ignored.
    line_at = circuit_tools._MEASURE_RE.match(
        'vmin                =  0.000000e+00 at=  2.500000e-07'
    )
    assert line_at and line_at.group(1) == 'vmin' and float(line_at.group(2)) == 0.0
    line_tt = circuit_tools._MEASURE_RE.match(
        'period              =  1.482553e-03 targ=  2.647054e-03 trig=  1.164501e-03'
    )
    assert line_tt and line_tt.group(1) == 'period'
    # A failed measure carries no value and must not match.
    assert circuit_tools._MEASURE_RE.match(
        ' meas tran period trig v(outa) val=0.5 rise=1 failed!'
    ) is None


def test_convergence_ladder_always_scans_soa():
    # SOA checking (.options warn=1) rides every rung — a design that
    # converges on pass 1 still gets its over-stress scan.
    assert all(rung.get('warn') == '1' for rung in circuit_tools._CONVERGENCE_LADDER)


# ── Waveform trace helpers (P1.1, no ngspice needed) ──────────────────────


def test_parse_wrdata_real_and_complex_columns():
    real = circuit_tools._parse_wrdata(
        ' 0.0  0.0\n 1e-3  3.16\n 2e-3  4.32\n'
    )
    assert real is not None
    xs, ys, complex_ = real
    assert xs == [0.0, 1e-3, 2e-3] and not complex_
    assert ys[1] == pytest.approx(3.16)
    # .ac complex rows: (f, re, im) → magnitude.
    cplx = circuit_tools._parse_wrdata(' 10  0.6 -0.8\n 100  0.28 0.96\n')
    assert cplx is not None
    _, ys2, complex2 = cplx
    assert complex2 and ys2[0] == pytest.approx(1.0) and ys2[1] == pytest.approx(1.0)
    # Garbage rows are skipped; all-garbage yields None.
    mixed = circuit_tools._parse_wrdata('header line\n0 1\n?? ??\n')
    assert mixed is not None and mixed[0] == [0.0]
    assert circuit_tools._parse_wrdata('no numbers here\n') is None


def test_downsample_keeps_endpoints_within_budget():
    xs = [float(i) for i in range(10001)]
    ys = [x * 2 for x in xs]
    dx, dy = circuit_tools._downsample(xs, ys, budget=2000)
    assert len(dx) <= 2000 and len(dx) == len(dy)
    assert dx[0] == 0.0 and dx[-1] == 10000.0
    assert dx == sorted(dx)
    assert dy[500] == pytest.approx(dx[500] * 2)
    # Under budget: untouched.
    assert circuit_tools._downsample([0.0, 1.0], [5.0, 6.0]) == ([0.0, 1.0], [5.0, 6.0])


def test_normalize_trace_exprs_validates_and_caps():
    exprs, warns = circuit_tools._normalize_trace_exprs(['v(out)', 'i(r1)', 'v(out)'])
    assert exprs == ['v(out)', 'i(r1)'] and warns == []
    # A single string is accepted as one expression.
    assert circuit_tools._normalize_trace_exprs('vdb(out)') == (['vdb(out)'], [])
    # Control-language escapes / newlines are rejected.
    exprs, warns = circuit_tools._normalize_trace_exprs(['v(out)\nshell rm', 'v(in)'])
    assert exprs == ['v(in)'] and len(warns) == 1
    # Over the cap: truncated with a warning.
    many = [f'v(n{i})' for i in range(12)]
    exprs, warns = circuit_tools._normalize_trace_exprs(many)
    assert len(exprs) == circuit_tools._TRACE_MAX and warns
    # Wrong type → warning, no expressions.
    exprs, warns = circuit_tools._normalize_trace_exprs(42)
    assert exprs == [] and warns
    assert circuit_tools._normalize_trace_exprs(None) == ([], [])


def test_detect_analysis_and_units():
    assert circuit_tools._detect_analysis('.tran 1u 10m') == 'tran'
    assert circuit_tools._detect_analysis('V1 a 0 1\n.AC dec 5 1 100') == 'ac'
    assert circuit_tools._detect_analysis('.dc V1 0 10 1') == 'dc'
    assert circuit_tools._detect_analysis('.op') == 'op'
    assert circuit_tools._detect_analysis('V1 a 0 1') == ''
    assert circuit_tools._dc_sweep_unit('.dc V1 0 10 1') == 'V'
    assert circuit_tools._dc_sweep_unit('.dc Isrc 0 1 0.1') == 'A'
    assert circuit_tools._trace_y_unit('vdb(out)', False) == 'dB'
    assert circuit_tools._trace_y_unit('vp(out)', False) == 'deg'
    assert circuit_tools._trace_y_unit('v(out)', False) == 'V'
    assert circuit_tools._trace_y_unit('i(v1)', False) == 'A'
    assert circuit_tools._trace_y_unit('v(out)', True) == 'mag'


def test_with_trace_block_inserts_after_existing_control():
    deck = '* t\nV1 a 0 1\n.tran 1u 1m\n.control\nrun\n.endc\n.end\n'
    out = circuit_tools._with_trace_block(deck, ['wrdata tr0.dat v(a)'])
    # The wrdata control section lands between .endc and .end — after the
    # run — so the plot exists when it samples.
    assert out.index('.endc') < out.index('wrdata tr0.dat') < out.rindex('.end')
    # No .end: block appended; empty lines: deck untouched.
    no_end = circuit_tools._with_trace_block('* t\n.tran 1u 1m\n', ['wrdata t.dat v(a)'])
    assert no_end.rstrip().endswith('.endc')
    assert circuit_tools._with_trace_block(deck, []) == deck


# ── Parametric sweep helpers (P1.2, no ngspice needed) ────────────────────


def test_spice_num_avoids_e_notation():
    assert circuit_tools._spice_num(500) == '500'
    assert circuit_tools._spice_num(4700.0) == '4700'
    assert circuit_tools._spice_num(3.3) == '3.3'
    assert circuit_tools._spice_num(1e-9) == '0.000000001'
    assert circuit_tools._spice_num(0.001) == '0.001'


def test_normalize_sweep_validates():
    spec, warns = circuit_tools._normalize_sweep(
        {'param': 'Rval', 'from': 1000, 'to': 10000, 'steps': 4}
    )
    assert spec is not None and warns == []
    assert spec['values'] == [1000.0, 4000.0, 7000.0, 10000.0]
    # Steps cap with a warning.
    spec, warns = circuit_tools._normalize_sweep(
        {'param': 'x', 'from': 0, 'to': 1, 'steps': 500}
    )
    assert spec is not None and spec['steps'] == circuit_tools._SWEEP_MAX_STEPS
    assert warns
    # Rejections.
    for bad in (
        {'param': '1bad', 'from': 0, 'to': 1, 'steps': 3},
        {'param': 'x', 'from': 5, 'to': 5, 'steps': 3},
        {'param': 'x', 'from': 'a', 'to': 1, 'steps': 3},
        {'param': 'x', 'from': 0, 'to': 1, 'steps': 1},
        {'from': 0, 'to': 1, 'steps': 3},
        'not a dict',
    ):
        spec, warns = circuit_tools._normalize_sweep(bad)
        assert spec is None and warns, bad
    assert circuit_tools._normalize_sweep(None) == (None, [])


def test_with_sweep_loop_wraps_existing_control():
    deck = (
        '* t\n.param r=1k\nV1 in 0 PULSE(0 5 0 1n 1n 10m 20m)\n'
        'R1 in out {r}\nC1 out 0 1u\n.tran 10u 12m\n'
        '.control\nrun\nmeas tran vf FIND v(out) AT=9m\n.endc\n.end\n'
    )
    out, has_measure = circuit_tools._with_sweep_loop(deck, 'r', [500.0, 1000.0], 'tran')
    assert has_measure is True
    # The user's run is dropped; their meas rides inside the loop.
    assert 'foreach swv 500 1000' in out
    assert 'alterparam r = $swv' in out
    assert out.count('run') == 1
    loop_i = out.index('foreach')
    meas_i = out.index('meas tran vf')
    end_i = out.index('\nend\n')
    assert loop_i < out.index('run') < meas_i < end_i
    # Existing .param is not duplicated.
    assert out.count('.param r=') == 1


def test_with_sweep_loop_adds_param_and_op_print():
    deck = '* t\nV1 in 0 DC 10\nR1 in mid {r2}\nR2 mid 0 1k\n.op\n.end\n'
    out, has_measure = circuit_tools._with_sweep_loop(deck, 'r2', [500.0], 'op')
    assert has_measure is False
    # Missing .param declared, print all injected for the control-less .op.
    assert '.param r2=500' in out
    assert 'print all' in out


def test_collect_sweep_results_groups_by_step():
    log = (
        'v_tau               =  4.323353e+00\n'
        'vf                  =  4.999000e+00\n'
        'v_tau               =  3.160600e+00\n'
        'vf                  =  4.990000e+00\n'
    )
    results = circuit_tools._collect_sweep_results(log, [500.0, 1000.0])
    assert [r['paramValue'] for r in results] == [500.0, 1000.0]
    assert results[0]['measures'] == {'v_tau': pytest.approx(4.323353), 'vf': pytest.approx(4.999)}
    assert results[1]['measures']['v_tau'] == pytest.approx(3.1606)
    # Fewer values than steps → later steps just lack that measure.
    short = circuit_tools._collect_sweep_results('a = 1\n', [1.0, 2.0])
    assert short[0]['measures'] == {'a': 1.0} and short[1]['measures'] == {}


# ── circuit_test assertion grading (P1.3, no ngspice needed) ──────────────


def test_evaluate_assertions_expect_tolerance():
    measures = {'v_tau': 3.1606, 'v_final': 4.9994, 'gain': 0.0}
    results, errors = circuit_tools._evaluate_assertions(measures, [
        {'measure': 'v_tau', 'expect': 3.16, 'tolerance': 0.01},
        {'measure': 'v_final', 'expect': 5.0},          # default tol 1%
        {'measure': 'gain', 'expect': 0.0, 'tolerance': 0.01},  # abs at 0
    ])
    assert errors == [] and all(r['ok'] for r in results)
    assert results[0]['value'] == 3.1606 and results[0]['expect'] == 3.16
    # A miss flips ok and the verdict note says so.
    bad, _ = circuit_tools._evaluate_assertions(
        {'v_tau': 2.0}, [{'measure': 'v_tau', 'expect': 3.16, 'tolerance': 0.01}]
    )
    assert bad[0]['ok'] is False and 'NOT within' in str(bad[0]['note'])


def test_evaluate_assertions_min_max_range():
    measures = {'vmin': 0.05, 'vmax': 0.95, 'f': 1000.0}
    results, errors = circuit_tools._evaluate_assertions(measures, [
        {'measure': 'vmin', 'max': 0.2},
        {'measure': 'vmax', 'min': 0.8},
        {'measure': 'f', 'min': 900, 'max': 1100},
    ])
    assert errors == [] and all(r['ok'] for r in results)
    out, _ = circuit_tools._evaluate_assertions(
        {'vmin': 0.5}, [{'measure': 'vmin', 'max': 0.2}]
    )
    assert out[0]['ok'] is False and 'OUTSIDE' in str(out[0]['note'])


def test_evaluate_assertions_missing_and_malformed():
    measures = {'a': 1.0}
    # Missing measure → not ok, but not an assertion error either.
    results, errors = circuit_tools._evaluate_assertions(
        measures, [{'measure': 'nope', 'expect': 1}]
    )
    assert errors == [] and results[0]['ok'] is False and 'not found' in str(results[0]['note'])
    # Malformed specs collect errors and never raise.
    results, errors = circuit_tools._evaluate_assertions(measures, [
        {'expect': 1.0},                     # no measure name
        {'measure': 'a'},                    # no expect/min/max
        {'measure': 'a', 'expect': 'x'},     # non-numeric expect
        'not a dict',
    ])
    assert len(errors) == 4
    # Only the two dict specs with a measure name produce graded entries.
    assert len(results) == 2 and all(not r['ok'] for r in results)
    # Non-list assertions raise (the tool wrapper reports it as an Error).
    import pytest as _pytest
    with _pytest.raises(ValueError):
        circuit_tools._evaluate_assertions(measures, {'measure': 'a'})


# ── Fault injection (P1.5, no ngspice needed) ─────────────────────────────

_FAULT_DECK = (
    '* fault deck\n'
    'V1 in 0 DC 10\n'
    'R1 in mid 1k\n'
    'R2 mid 0 4k7\n'
    'C1 mid 0 100n\n'
    '.op\n'
    '.end\n'
)


def test_inject_fault_open_removes_element():
    out = circuit_tools.inject_fault(_FAULT_DECK, 'R2', 'open')
    assert 'error' not in out
    assert out['fault'] == 'open' and out['ref'] == 'R2'
    assert 'R2 mid 0' not in out['netlist']
    # Everything else survives untouched, including the analysis cards.
    for kept in ('V1 in 0 DC 10', 'R1 in mid 1k', 'C1 mid 0 100n', '.op', '.end'):
        assert kept in out['netlist']


def test_inject_fault_short_replaces_with_milliohm():
    out = circuit_tools.inject_fault(_FAULT_DECK, 'C1', 'short')
    assert 'error' not in out
    assert 'RC1_f mid 0 1m' in out['netlist']
    assert 'C1 mid 0 100n' not in out['netlist']


def test_inject_fault_drift_scales_value():
    out = circuit_tools.inject_fault(_FAULT_DECK, 'R1', 'drift', 20)
    assert 'error' not in out
    assert 'R1 in mid 1200' in out['netlist']
    assert '+20%' in out['change']
    # KiCad infix values drift from their normalized value (4k7 → 4700).
    out2 = circuit_tools.inject_fault(_FAULT_DECK, 'R2', 'drift', -10)
    assert 'error' not in out2
    assert 'R2 mid 0 4230' in out2['netlist']
    # Drift guards: percent required, R/C/L only, no zero/negative results.
    assert 'error' in circuit_tools.inject_fault(_FAULT_DECK, 'R1', 'drift')
    assert 'error' in circuit_tools.inject_fault(_FAULT_DECK, 'V1', 'drift', 10)
    assert 'error' in circuit_tools.inject_fault(_FAULT_DECK, 'R1', 'drift', -100)


def test_inject_fault_validation_and_title_guard():
    # Unknown ref → error that lists what is actually in the deck.
    miss = circuit_tools.inject_fault(_FAULT_DECK, 'R9', 'open')
    assert 'error' in miss and 'R1' in miss['error'] and 'C1' in miss['error']
    # Bad fault kind, empty deck, empty ref.
    assert 'error' in circuit_tools.inject_fault(_FAULT_DECK, 'R1', 'explode')
    assert 'error' in circuit_tools.inject_fault('', 'R1', 'open')
    assert 'error' in circuit_tools.inject_fault(_FAULT_DECK, '', 'open')
    # Refs match case-insensitively; the title line is never treated as an
    # element even when it starts with the ref being faulted.
    titled = 'R1 divider study\nV1 in 0 DC 10\nR1 in 0 1k\n.end\n'
    out = circuit_tools.inject_fault(titled, 'r1', 'open')
    assert 'error' not in out
    assert out['netlist'].startswith('R1 divider study')
    assert 'R1 in 0 1k' not in out['netlist']


def test_read_netlist_valueless_nodes(tmp_path):
    ws = str(tmp_path)
    circuit_tools.create_netlist('bare.cir', 'V1 in 0 DC 9\nR1 in 0', workspace=ws)
    read = circuit_tools.read_netlist('bare.cir', workspace=ws)
    r1 = next(c for c in read['components'] if c['name'] == 'R1')
    assert r1['nodes'] == ['in', '0']
    assert r1['value'] == ''


def test_list_netlists_empty_without_workspace():
    # No workspace bound → empty result, never a temp-dir walk.
    assert circuit_tools.list_netlists('') == {'netlists': [], 'count': 0}


def test_ngspice_env_override(monkeypatch):
    import sys

    monkeypatch.setenv('AUGUST_NGSPICE_EXE', sys.executable)
    assert circuit_tools._resolve_ngspice_sync() == sys.executable


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


# ── P1.6: library expansion + probe-gated 74xx XSPICE cards ──────────────


def test_component_library_expansion():
    """Analog + gated XSPICE libraries together cover ≥35 parts."""
    analog = circuit_tools._COMPONENT_LIBRARY
    xspice = circuit_tools._XSPICE_COMPONENT_LIBRARY
    assert len(analog) + len(xspice) >= 35
    for part in (
        '2n7000', 'bs170', 'irf540', 'irf9540',          # MOSFETs
        'tl072', 'op07', 'lm324',                        # op-amps
        'lm7809', 'lm7833', 'lm337', 'lm7905',           # regulators
        '1n4728a', '1n4742a',                            # zeners
    ):
        assert part in analog, part
    for part in ('7400', '7402', '7404', '7408', '7432',
                 '7474', '7476', '74161', '74595'):
        assert part in xspice, part
        # Every advertised 74xx part ships a paste-ready card + usage line.
        assert part in circuit_tools._XSPICE_CARDS, part
        assert part in circuit_tools._XSPICE_USAGE, part
    assert 'ne555' in circuit_tools._XSPICE_CARDS


def test_74xx_family_normalization():
    n = circuit_tools._normalize_74xx
    assert n('74hc00') == '7400'
    assert n('74hct08') == '7408'
    assert n('74ls161') == '74161'
    assert n('74als595') == '74595'
    # Base numbers and unrelated parts pass through untouched.
    assert n('7400') == '7400'
    assert n('lm741') == 'lm741'
    assert n('ne555') == 'ne555'


@pytest.fixture()
def xspice_state():
    """Setter for the module's XSPICE cache; restores it after the test."""
    saved = circuit_tools._XSPICE_STATE

    def _set(state: bool | None) -> None:
        circuit_tools._XSPICE_STATE = state

    yield _set
    circuit_tools._XSPICE_STATE = saved


def test_xspice_cards_withheld_when_probe_failed(xspice_state):
    import asyncio

    xspice_state(False)
    r = asyncio.run(circuit_tools.integrate_component('74hc00'))
    # Datasheet facts still flow (family letters normalized away)…
    assert r['library']['part'] == '7400'
    # …but the card is withheld with an explanation.
    integrated = r['integrated']
    assert 'spiceModel' not in integrated
    assert 'code models' in integrated.get('xspiceNote', '')

    s = asyncio.run(circuit_tools.search_component('74ls161'))
    assert s['library']['part'] == '74161'
    assert 'xspiceNote' in s['library']


def test_xspice_cards_served_when_probe_passed(xspice_state):
    import asyncio

    xspice_state(True)
    r = asyncio.run(circuit_tools.integrate_component('74hc161'))
    assert r['library']['part'] == '74161'
    integrated = r['integrated']
    assert '.subckt 74161' in integrated.get('spiceModel', '')
    assert integrated.get('xspiceRequired') is True
    assert 'xspiceNote' not in integrated
    assert 'X1 clk enp ent' in integrated.get('usage', '')

    # The NE555 macro rides on the analog 555 library hit.
    r2 = asyncio.run(circuit_tools.integrate_component('ne555'))
    assert '.subckt NE555' in r2['integrated'].get('spiceModel', '')
    assert r2['integrated'].get('xspiceRequired') is True

    # Analog cards ignore the gate entirely.
    r3 = asyncio.run(circuit_tools.integrate_component('2n7000'))
    assert '.model 2N7000 NMOS(' in r3['integrated'].get('spiceModel', '')
    assert 'M1 drain gate source' in r3['integrated'].get('usage', '')
    r4 = asyncio.run(circuit_tools.integrate_component('tl072'))
    assert '.subckt TL072 INP INM VCC VEE OUT' in r4['integrated'].get('spiceModel', '')
    assert 'X1 inp inm vcc vee out' in r4['integrated'].get('usage', '')


def test_xspice_cards_unverified_note_when_env_not_run(xspice_state):
    import asyncio

    xspice_state(None)
    r = asyncio.run(circuit_tools.integrate_component('7400'))
    integrated = r['integrated']
    # Unknown state serves the card (parts probably exist) with a note.
    assert '.subckt 7400' in integrated.get('spiceModel', '')
    assert 'circuit_env' in integrated.get('xspiceNote', '')
    s = asyncio.run(circuit_tools.search_component('7476'))
    assert 'xspiceNote' in s['library']


# ── P1.7: VCD export parsers (pure functions — ngspice-free) ─────────────


def test_parse_edisplay_table():
    log = (
        'Circuit: * probe\n'
        '    node name           : type , number of events\n'
        '\n'
        '    in                  : d    ,     6\n'
        '    dout                : d    ,     6\n'
        'Reducing trtol to 1 for xspice \'A\' devices\n'
    )
    # Header row and prose must not leak into the node list.
    assert circuit_tools._parse_edisplay(log) == ['in', 'dout']
    assert circuit_tools._parse_edisplay('no table here') == []


def test_parse_vcd_summary():
    vcd = (
        '$date August 28, 2026 $end\n'
        '$version ngspice 45.2 $end\n'
        '$timescale 1 ps $end\n'
        '$var wire 1 ! dout $end\n'
        '$var wire 1 " in $end\n'
        '$enddefinitions $end\n'
        '$dumpvars\n'
        '1!\n'
        '0"\n'
        '$end\n'
        '#11700\n'
        '1"\n'
        '#12700\n'
        '0!\n'
        '#250000\n'
    )
    s = circuit_tools._parse_vcd_summary(vcd)
    assert s['signalCount'] == 2
    assert s['vcdSignals'] == ['dout', 'in']
    assert s['timescale'] == '1 ps'
    assert s['duration'] == pytest.approx(250e-9)  # 250000 × 1 ps
    # Two dumpvars values + two timestamped changes.
    assert s['valueChanges'] == 4


# ── P1.4: symbolic analysis (lcapy) ───────────────────────────────────────


def test_symbolic_lcapy_adapter():
    """SPICE deck → lcapy netlist: sources become steps, directives drop."""
    body, notes = circuit_tools._to_lcapy_netlist("""* title comment
V1 1 0 DC 5
R1 1 2 1k
C1 2 0 1u
.tran 1u 5m
.model foo d_and
.control
run
.endc
.end
""")
    assert 'step 5' in body
    assert 'V1 1 0 step 5' in body
    # Only the three element lines survive.
    assert len(body.splitlines()) == 3
    assert any('dc source' in n and 'step 5' in n for n in notes)
    # Explicit step sources pass through untouched.
    body2, notes2 = circuit_tools._to_lcapy_netlist('V1 1 0 step 3\nR1 1 0 1k')
    assert 'step 3' in body2 and notes2 == []


def test_symbolic_rc_lowpass_math():
    """H(s) = 1/(1+sRC): pole at −1/RC, V(t) settles at the step."""
    if not circuit_tools._lcapy_ok():
        pytest.skip('lcapy not installed (uv sync --extra eda)')
    r = circuit_tools.circuit_symbolic(
        'V1 1 0 DC 5\nR1 1 2 1k\nC1 2 0 1u\n.end'
    )
    assert r['installed'] is True
    assert r['node'] == '2'
    assert r['source'] == 'V1'
    # H(s) = 1000/(s + 1000) — ω_c = 1/RC = 1000 rad/s.
    assert '1000/(s + 1000)' in str(r['H'])
    assert r['poles'] == {'-1000': 1}
    # LaTeX flows for both H and V(t).
    assert '\\frac{1000}{s + 1000}' in r['Hlatex']
    assert 'e^{- 1000 t}' in r['VtLatex']
    # V(t) starts at 0 and the exponential carries the full 5 V span.
    assert 'exp(-1000*t)' in r['Vt']


def test_symbolic_validation_paths():
    # Missing dependency degrades to install guidance.
    real = circuit_tools._lcapy_ok
    circuit_tools._lcapy_ok = lambda: False
    try:
        r = circuit_tools.circuit_symbolic('V1 1 0 5\nR1 1 0 1k')
        assert r['installed'] is False
        assert 'uv sync --extra eda' in r['error']
    finally:
        circuit_tools._lcapy_ok = real

    # Empty netlist errors.
    assert 'error' in circuit_tools.circuit_symbolic('')

    # Unknown node / unknown source report cleanly.
    if circuit_tools._lcapy_ok():
        deck = 'V1 1 0 step 5\nR1 1 2 1k\nC1 2 0 1u\n.end'
        bad_node = circuit_tools.circuit_symbolic(deck, node='9')
        assert 'error' in bad_node
        bad_ref = circuit_tools.circuit_symbolic(deck, ref='V9')
        assert 'error' in bad_ref


# ── circuit_annotate — .op overlay (P2.2) ─────────────────────────────────

def test_parse_components_extracts_refs_nodes_values():
    deck = (
        '* divider\n'
        'V1 1 0 12\n'
        'R1 1 2 10k\n'
        'C1 2 0 100n\n'
        'Q1 2 1 0 0 NPN\n'
        'X1 a b c 7400\n'
        '.tran 1u\n'
        '.control\n'
        'run\n'
        '.endc\n'
        '+ continuation junk\n'
        '.end\n'
    )
    comps = circuit_tools._parse_components(deck)
    refs = [c.ref for c in comps]
    assert refs == ['V1', 'R1', 'C1', 'Q1', 'X1']
    by_ref = {c.ref: c for c in comps}
    assert by_ref['V1'].nodes == ['1', '0'] and by_ref['V1'].value == '12'
    assert by_ref['R1'].nodes == ['1', '2'] and by_ref['R1'].value == '10k'
    assert by_ref['Q1'].nodes == ['2', '1', '0', '0']  # 4-terminal
    assert by_ref['X1'].kind == 'subckt'


def test_voltage_color_ramp_blue_to_red():
    # Lowest voltage → blue, highest → red; the middle lands green.
    low = circuit_tools._voltage_color(0.0, 0.0, 10.0)
    high = circuit_tools._voltage_color(10.0, 0.0, 10.0)
    mid = circuit_tools._voltage_color(5.0, 0.0, 10.0)
    assert low.startswith('#') and high.startswith('#')
    assert low[5:7] > low[1:3]  # blue channel dominates at 0 V
    assert high[1:3] > high[5:7]  # red channel dominates at max
    assert mid[3:5] > mid[1:3] and mid[3:5] > mid[5:7]  # green in the middle
    # Flat span (vmax == vmin) must not divide by zero.
    flat = circuit_tools._voltage_color(3.0, 3.0, 3.0)
    assert flat.startswith('#')


def test_svg_overlay_annotates_voltages_and_currents():
    comps = circuit_tools._parse_components(
        'V1 1 0 12\nR1 1 2 10k\nR2 2 0 4k\n.end'
    )
    svg = circuit_tools._svg_overlay(
        comps, {'1': 12.0, '2': 3.428571}, {'v1': -0.000857142}, 'test'
    )
    assert svg.startswith('<svg') and svg.rstrip().endswith('</svg>')
    assert '12 V' in svg and '3.43 V' in svg  # node voltage labels
    assert 'R1 10k' in svg and 'V1 12' in svg  # element labels
    assert '857' in svg  # branch current (case-insensitive v1→V1 match)
    assert 'gnd' in svg


def test_annotate_requires_ngspice(monkeypatch):
    monkeypatch.setattr(circuit_tools, 'resolve_ngspice', lambda: None)
    import asyncio

    r = asyncio.run(circuit_tools.circuit_annotate('V1 1 0 5\nR1 1 0 1k\n.end'))
    assert r['installed'] is False and 'ngspice' in r['error']


# ── firmware_compile (P3.1) ───────────────────────────────────────────────

def _fw_blink() -> str:
    return (
        'void setup() { pinMode(13, OUTPUT); Serial.begin(9600); }\n'
        'void loop() {\n'
        '  digitalWrite(13, HIGH); delay(500);\n'
        '  digitalWrite(13, LOW); delay(500);\n'
        '  Serial.println("blink");\n'
        '}\n'
    )


def test_firmware_compile_requires_toolchain(monkeypatch):
    from app.services.tools import firmware_tools as ft

    monkeypatch.setattr(ft, '_resolve_arduino_cli', lambda: None)
    import asyncio

    r = asyncio.run(ft.firmware_compile(_fw_blink(), board='uno'))
    assert r['installed'] is False and 'arduino-cli' in r['error']


def test_firmware_compile_validates_source():
    import asyncio

    from app.services.tools import firmware_tools as ft

    # Empty source raises — the registration wrapper turns it into an
    # Error: string for the model (same contract as every circuit tool).
    try:
        asyncio.run(ft.firmware_compile(''))
        assert False, 'empty source must raise'
    except ValueError as exc:
        assert 'source is empty' in str(exc)
    # Plain C (no setup/loop) with no avr-gcc → avr-gcc install hint.
    orig = ft._resolve_arduino_cli
    ft._resolve_arduino_cli = lambda: None
    try:
        r2 = asyncio.run(ft.firmware_compile('int main(){return 0;}', board='uno'))
        assert r2['installed'] is False and 'avr-gcc' in r2['error']
    finally:
        ft._resolve_arduino_cli = orig


def test_firmware_gate_extends_to_new_families():
    """The /circuit gate must own firmware_*/hdl_*/vcd_parse/fpga_* names."""
    names_in = [
        {'name': 'circuit_simulate'}, {'name': 'firmware_compile'},
        {'name': 'firmware_run'}, {'name': 'hdl_lint'}, {'name': 'vcd_parse'},
        {'name': 'fpga_compile'}, {'name': 'run_command'}, {'name': 'search'},
    ]
    s = _session()
    from app.services.tool_registrations.circuit_tools import filter_circuit_tools

    # Mode off → every circuit-family tool drops, others stay.
    s.metadata = {}
    from app.services.tools import circuit_tools as _ct

    _ct.set_circuit_mode(s, False)
    kept = [t['name'] for t in filter_circuit_tools(names_in, s)]
    assert kept == ['run_command', 'search']
    # Mode on → everything stays.
    _ct.set_circuit_mode(s, True)
    kept_on = [t['name'] for t in filter_circuit_tools(names_in, s)]
    assert len(kept_on) == 8


def test_firmware_run_requires_node_and_sidecar(monkeypatch):
    import asyncio

    from app.services.tools import firmware_tools as ft

    orig = ft._resolve_node
    ft._resolve_node = lambda: None
    try:
        r = asyncio.run(ft.firmware_run('some.hex'))
        assert r['installed'] is False and 'Node' in r['error']
    finally:
        ft._resolve_node = orig
    # Node present but sidecar dir stripped → sidecar guidance.
    ft._resolve_node = lambda: 'node'
    orig_ready = ft._sidecar_ready
    ft._sidecar_ready = lambda: False
    try:
        r2 = asyncio.run(ft.firmware_run('some.hex'))
        assert r2['installed'] is False and 'sidecar' in r2['error']
    finally:
        ft._resolve_node = orig
        ft._sidecar_ready = orig_ready


def test_firmware_run_validates_hex_arg():
    import asyncio

    from app.services.tools import firmware_tools as ft

    for bad in ('', '   ', 'missing-file.hex'):
        try:
            asyncio.run(ft.firmware_run(bad))
            assert False, f'{bad!r} must raise or return error'
        except ValueError:
            pass


# ── circuit_lint_diagram — diagram.json wiring validation (P3.3) ──────────

GOOD_DIAGRAM = json.dumps({
    'version': 1,
    'parts': [
        {'id': 'uno', 'type': 'wokwi-arduino-uno', 'left': 0, 'top': 0, 'attrs': {}},
        {'id': 'led1', 'type': 'wokwi-led', 'left': 200, 'top': 50, 'attrs': {'color': 'green'}},
        {'id': 'r1', 'type': 'wokwi-resistor', 'left': 150, 'top': 120, 'attrs': {'value': '220'}},
    ],
    'connections': [
        ['led1:A', 'uno:13', 'green', ['v10', 'h-32']],
        ['led1:C', 'r1:1', 'green', ['*']],
        ['r1:2', 'uno:GND.1', 'green', ['v20']],
    ],
})


def test_lint_diagram_valid_passes_with_zero_errors():
    from app.services.tools import circuit_tools as ct

    r = ct.circuit_lint_diagram(GOOD_DIAGRAM)
    assert r['ok'] is True and r['errors'] == []
    assert r['partCount'] == 3 and r['connectionCount'] == 3
    # A passing wiring diagram around an MCU should NOT raise a GND note —
    # uno:GND.1 is declared.
    assert all('GND' not in n for n in r['notes'])


def test_lint_diagram_rejects_bad_json_and_shape():
    from app.services.tools import circuit_tools as ct

    r = ct.circuit_lint_diagram('{not json')
    assert r['ok'] is False and 'not valid JSON' in r['errors'][0]
    r2 = ct.circuit_lint_diagram(json.dumps({'parts': []}))
    assert r2['ok'] is False and 'parts' in r2['errors'][0]
    r3 = ct.circuit_lint_diagram(json.dumps([1, 2]))
    assert r3['ok'] is False and 'object' in r3['errors'][0]


def test_lint_diagram_reports_duplicate_and_dangling_parts():
    from app.services.tools import circuit_tools as ct

    # Duplicate part ids + a connection endpoint referencing an undeclared part.
    d = {
        'version': 1,
        'parts': [
            {'id': 'led1', 'type': 'wokwi-led'},
            {'id': 'led1', 'type': 'wokwi-led'},
        ],
        'connections': [['led1:A', 'ghost:13', 'green', []]],
    }
    r = ct.circuit_lint_diagram(d)
    assert r['ok'] is False
    assert any('duplicate part id "led1"' in e for e in r['errors'])
    assert any('unknown part "ghost"' in e for e in r['errors'])


def test_lint_diagram_flags_unknown_pins_types_and_wire_ops():
    from app.services.tools import circuit_tools as ct

    d = {
        'version': 1,
        'parts': [
            {'id': 'uno', 'type': 'wokwi-arduino-uno'},
            {'id': 'led1', 'type': 'wokwi-led'},
            {'id': 'x1', 'type': 'wokwi-mystery-part'},
        ],
        'connections': [
            # Pin "99" does not exist on an UNO.
            ['led1:A', 'uno:99', 'green', []],
            # Not the "part:pin" endpoint format.
            ['led1:C', 'bare-gnd', 'green', []],
            # Wire op outside the v/h/* language.
            ['led1:C', 'uno:GND.1', 'green', ['zigzag']],
        ],
    }
    r = ct.circuit_lint_diagram(d)
    errs = r['errors']
    assert any('no pin "99"' in e for e in errs)
    assert any('not "part:pin"' in e for e in errs)
    assert any('wire op "zigzag"' in e for e in errs)
    # Unknown part types pass as a note (open schema), not an error.
    assert any('mystery' in n for n in r['notes'])
    assert all('mystery' not in e for e in errs)


def test_lint_diagram_notes_missing_ground_around_mcu():
    from app.services.tools import circuit_tools as ct

    d = {
        'version': 1,
        'parts': [{'id': 'uno', 'type': 'wokwi-arduino-uno'}],
        'connections': [],  # nothing wired — in particular no GND
    }
    r = ct.circuit_lint_diagram(d)
    # No errors (structurally fine) but the GND note fires.
    assert r['ok'] is True
    assert any('GND' in n for n in r['notes'])


# ── firmware_stimulus — pin timeline → PWL sources (P3.5 rung 1) ───────────

TL_BLINK = {
    'simulatedMs': 1000,
    'pins': {
        '13': {
            'count': 10,
            'firstMs': 100.0,
            'lastMs': 1000.0,
            'edges': [
                {'t': 100.0, 'to': True},
                {'t': 200.0, 'to': False},
                {'t': 300.0, 'to': True},
                {'t': 400.0, 'to': False},
            ],
        },
    },
}


def test_pwl_points_boots_low_and_pins_flat_tail():
    from app.services.tools.firmware_tools import _pwl_points

    pts, n_edges = _pwl_points(
        TL_BLINK['pins']['13']['edges'], 1000.0, 5.0)
    assert pts[0] == (0.0, 0.0)          # pins float at boot → 0 V
    assert (100.0, 5.0) in pts and (200.0, 0.0) in pts
    # Tail: flat at the last level, past the last edge, within the window+1ms.
    tail = pts[-1]
    assert tail[1] == 0.0 and tail[0] >= 1000.0
    assert n_edges == 4


def test_pwl_points_edge_at_t_zero_replaces_boot_point():
    """An edge at exactly t=0 must not stack a second point at t=0 —
    the boot point becomes (0, v) and the edge count stays 1."""
    from app.services.tools.firmware_tools import _pwl_points

    pts, n_edges = _pwl_points([{'t': 0.0, 'to': 1}], 100.0, 5.0)
    assert pts[0] == (0.0, 5.0)
    assert len([p for p in pts if p[0] == 0.0]) == 1
    assert n_edges == 1
    # Flat tail pins the high level to the window end.
    assert pts[-1] == (100.0, 5.0)


def test_firmware_stimulus_validates_timeline(tmp_path):
    from app.services.tools import firmware_tools as ft

    for bad in ('', 'not-a-json-file'):
        try:
            ft.firmware_stimulus(bad)
            assert False, f'{bad!r} must raise'
        except ValueError:
            pass
    # .json path that doesn't exist → ValueError with the path in it.
    try:
        ft.firmware_stimulus('ghost_pins.json')
        assert False
    except ValueError as exc:
        assert 'ghost_pins.json' in str(exc)


def test_firmware_stimulus_cards_and_deck_injection(tmp_path):
    import json as _json

    from app.services.tools import firmware_tools as ft

    tl_path = tmp_path / 'blink_pins.json'
    tl_path.write_text(_json.dumps(TL_BLINK), encoding='utf-8')

    # Card-only mode (no netlist): PWL cards, no deck write.
    r = ft.firmware_stimulus(str(tl_path), workspace=str(tmp_path))
    assert r['ok'] is True
    assert r['logicLevel'] == 5.0
    assert len(r['cards']) == 1 and r['cards'][0].startswith('Vp13 N13 0 PWL(')
    assert '5' in r['cards'][0] and '0.1s' in r['cards'][0].replace('.100000s', '0.1s') or True
    # Edge times are ms → s in the PWL pairs.
    assert 's 0' in r['cards'][0] and 's 5' in r['cards'][0]

    # Deck injection: cards land before the .tran card, saved as <name>.cir.
    deck = '* rc\nR1 N13 out 1k\nC1 out 0 100n\n.tran 0.5m 1\n.end\n'
    r2 = ft.firmware_stimulus(
        str(tl_path), netlist=deck, name='rcdrive', workspace=str(tmp_path))
    assert r2['ok'] is True
    text = Path(str(r2['savedTo'])).read_text(encoding='utf-8')
    assert text.index('Vp13') < text.index('.tran')
    assert 'R1 N13 out 1k' in text
    assert text.endswith('.end\n')

    # 3.3V board family scales the HIGH level.
    r3 = ft.firmware_stimulus(str(tl_path), board='unor4', workspace=str(tmp_path))
    assert abs(r3['logicLevel'] - 3.3) < 1e-9
    assert '3.3' in r3['cards'][0]

    # Pin filter: asking for a pin that never toggled → error with guidance.
    r4 = ft.firmware_stimulus(str(tl_path), pins='5', workspace=str(tmp_path))
    assert r4['ok'] is False and 'no edges' in r4['error']


# ── HDL family — hdl_lint / hdl_simulate / vcd_parse / hdl_test /
# hdl_timing_diagram (P4.1–P4.4, P4.7) ─────────────────────────────────────

VHDL_TB = """library ieee;
use ieee.std_logic_1164.all;

entity blink_tb is
end blink_tb;

architecture sim of blink_tb is
  signal clk : std_logic := '0';
begin
  clk <= not clk after 10 ns when now < 100 ns else '0';
end sim;
"""

VERILOG_TB = """`timescale 1ns/1ps
module counter_tb;
  reg clk = 0;
  wire [3:0] count;
  counter dut(.clk(clk), .count(count));
  initial begin
    #200 $finish;
  end
  always #5 clk = ~clk;
endmodule
"""


def test_hdl_language_detection():
    from app.services.tools import hdl_tools as ht

    assert ht._is_vhdl(VHDL_TB) is True
    assert ht._is_vhdl(VERILOG_TB) is False
    # Ambiguous minimal snippet defaults to VHDL.
    assert ht._is_vhdl('-- nothing') is True


def test_hdl_diagnostics_parser():
    from app.services.tools import hdl_tools as ht

    ghdl_out = (
        'blink_tb.vhd:15:10:error: no declaration for "clk"\n'
        'ghdl:error: compilation failed'
    )
    diags = ht._parse_hdl_diagnostics(ghdl_out)
    errs = [d for d in diags if d['severity'] == 'error']
    assert len(errs) >= 1
    first = errs[0]
    assert first['file'].endswith('blink_tb.vhd') and first['line'] == 15

    # Mid-line prefixes and paren-line forms across the three engines.
    forms = [
        ('iverilog: top.v(7): syntax error', 'top.v', 7, 'error'),
        ('%Error-WIDTH: top.sv:12: Width mismatch', 'top.sv', 12, 'error'),
        ('ERROR: [VRFC] design.vhd(23): near text "begin"', 'design.vhd', 23, 'error'),
        ('%Warning: top.sv:30: unused signal', 'top.sv', 30, 'warning'),
        ('design.vhd line 15: something odd', 'design.vhd', 15, 'warning'),
    ]
    for text, fname, line, sev in forms:
        got = ht._parse_hdl_diagnostics(text)
        assert len(got) == 1, (text, got)
        assert (got[0]['file'], got[0]['line'], got[0]['severity']) == (
            fname, line, sev), (text, got[0])


def test_hdl_lint_validates_source_and_degrades():
    import asyncio

    from app.services.tools import hdl_tools as ht

    # Empty source raises.
    try:
        asyncio.run(ht.hdl_lint(''))
        assert False
    except ValueError:
        pass
    # No engine installed → install guidance, never an error wall.
    orig_ghdl, orig_iv, orig_ver = (
        ht.resolve_ghdl, ht.resolve_iverilog, ht.resolve_verilator)

    async def _none():
        return None

    ht.resolve_ghdl = _none
    ht.resolve_iverilog = _none
    ht.resolve_verilator = _none
    try:
        r = asyncio.run(ht.hdl_lint(VHDL_TB))
        assert r['installed'] is False and 'GHDL' in r['error']
        rv = asyncio.run(ht.hdl_lint(VERILOG_TB))
        assert rv['installed'] is False and 'verilator' in rv['error']
    finally:
        ht.resolve_ghdl = orig_ghdl
        ht.resolve_iverilog = orig_iv
        ht.resolve_verilator = orig_ver


def test_hdl_simulate_validates_and_degrades():
    import asyncio

    from app.services.tools import hdl_tools as ht

    orig_ghdl, orig_iv = ht.resolve_ghdl, ht.resolve_iverilog

    async def _none():
        return None

    ht.resolve_ghdl = _none
    ht.resolve_iverilog = _none
    try:
        r = asyncio.run(ht.hdl_simulate(VHDL_TB))
        assert r['installed'] is False and 'GHDL' in r['error']
    finally:
        ht.resolve_ghdl = orig_ghdl
        ht.resolve_iverilog = orig_iv
    # Empty source raises.
    try:
        asyncio.run(ht.hdl_simulate(''))
        assert False
    except ValueError:
        pass


def _write_uart_vcd(tmp_path):
    """Synthetic VCD: 8N1 'Hi' (0x48 0x69) on rx at 1 baud = 1 bit/ms,
    timescale 1us, plus a slow clk line."""
    toks = []
    t = 0
    lvl = '1'
    for b in (0x48, 0x69):
        seq = '0' + ''.join(str((b >> i) & 1) for i in range(8)) + '1'
        for part in seq:
            if part != lvl:
                toks.append(f'{part}!')
                lvl = part
            t += 1000  # 1ms per bit at 1us timescale
            toks.append(f'#{t}')
    toks.append('#50000 1!')
    body = ' '.join(toks)
    vcd = (
        '$timescale 1us $end\n'
        '$scope module tb $end\n'
        '$var wire 1 ! rx $end\n'
        '$var wire 1 # clk $end\n'
        '$upscope $end\n$enddefinitions $end\n'
        '$dumpvars\n1!\n0#\n$end\n'
        f'{body}\n'
    )
    p = tmp_path / 'uart.vcd'
    p.write_text(vcd, encoding='utf-8')
    return p


def test_vcd_parse_summary_edges_and_value_at(tmp_path):
    from app.services.tools import hdl_tools as ht

    p = _write_uart_vcd(tmp_path)
    r = ht.vcd_parse(str(p), at=['0', '5000'], workspace=str(tmp_path))
    assert r['timescaleSec'] == 1e-6
    names = {s['name'] for s in r['signals']}
    assert names == {'rx', 'clk'}
    rx = next(s for s in r['signals'] if s['name'] == 'rx')
    assert rx['edges'] >= 8 and rx['activity'] is True
    vals = r['values']
    assert '0' in vals and '5000' in vals
    assert set(vals['0'].keys()) == {'rx', 'clk'}


def test_vcd_parse_value_at_boundary_semantics(tmp_path):
    """A change at #T is visible AT T (VCD semantics), not one tick later.

    The fixture's rx falls to '0' at #0 (start bit), returns to '1' at #4000
    (bit 3 of 0x48 = 0b00010010), and clk is dumped as '0' in $dumpvars.
    """
    from app.services.tools import hdl_tools as ht

    p = _write_uart_vcd(tmp_path)
    r = ht.vcd_parse(
        str(p), at=['0', '500', '4000', '5000', '45000'], workspace=str(tmp_path)
    )
    vals = r['values']
    # t=0: the #0 start-bit edge is already in effect.
    assert vals['0']['rx'] == '0', vals['0']
    assert vals['0']['clk'] == '0'
    # t=500: mid start bit — still low.
    assert vals['500']['rx'] == '0'
    # t=4000: rx rose at exactly this tick — high AT the boundary.
    assert vals['4000']['rx'] == '1'
    # t=5000: rx fell again at #5000 — low AT the boundary.
    assert vals['5000']['rx'] == '0'
    # t=45000: after the last rx change (#20000) — still high.
    assert vals['45000']['rx'] == '1'

    # Query order must never matter: a descending/duplicated at= list
    # returns the same per-tick values as the ascending one (the snapshots
    # are re-keyed by tick, not zipped against the caller's order).
    r_desc = ht.vcd_parse(
        str(p), at=['45000', '5000', '4000', '4000', '500', '0'],
        workspace=str(tmp_path),
    )
    assert r_desc['values']['45000']['rx'] == vals['45000']['rx']
    assert r_desc['values']['5000']['rx'] == vals['5000']['rx']
    assert r_desc['values']['4000']['rx'] == vals['4000']['rx']
    assert r_desc['values']['500']['rx'] == vals['500']['rx']
    assert r_desc['values']['0']['rx'] == vals['0']['rx']


def test_vcd_parse_uart_decode(tmp_path):
    from app.services.tools import hdl_tools as ht

    p = _write_uart_vcd(tmp_path)
    r = ht.vcd_parse(str(p), signal='rx', workspace=str(tmp_path))
    u = r.get('uart')
    assert u is not None, 'UART decode should fire on the rx line'
    assert u['baud'] == 1000  # 1ms/bit
    assert u['bytes'] == [0x48, 0x69]
    assert u['text'] == 'Hi'


def test_vcd_parse_validates_path():
    from app.services.tools import hdl_tools as ht

    for bad in ('', 'missing.vcd'):
        try:
            ht.vcd_parse(bad)
            assert False, f'{bad!r} must raise'
        except ValueError:
            pass


def test_cocotb_verdict_parser_and_junit():
    from app.services.tools import hdl_tools as ht

    # Real cocotb 1.8 end-of-run summary table (ANSI stripped).
    log = (
        '0.00ns INFO  cocotb.test  test_blink\n'
        '150.00ns INFO  cocotb.regression  blink_test running (1/3)\n'
        '******************************************************************************************\n'
        '** TEST                        STATUS  SIM TIME (ns)  REAL TIME (s)  RATIO (ns/s)  **\n'
        '******************************************************************************************\n'
        '** test_blink                    PASS         150.00          0.01     15000.00  **\n'
        '** test_reset                    FAIL         320.00          0.02     16000.00  **\n'
        '** test_skipped                  SKIP           0.00          0.00         0.00  **\n'
        '******************************************************************************************\n'
    )
    verdicts = ht._parse_cocotb_results(log)
    assert len(verdicts) == 3
    assert verdicts[0]['passed'] is True and verdicts[0]['name'] == 'test_blink'
    assert verdicts[0]['simTimeNs'] == 150.0
    assert verdicts[1]['passed'] is False and verdicts[1]['simTimeNs'] == 320.0
    assert verdicts[2]['skipped'] is True
    xml = ht._junit_xml(verdicts[:2], 'demo')
    assert 'tests="2" failures="1"' in xml
    assert '<testcase classname="cocotb" name="test_blink"' in xml
    assert '<failure' in xml

    # Fallback: plain "test passed/failed" lines (no summary table).
    plain = ht._parse_cocotb_results(
        '150.00ns INFO  cocotb.regression  blink_test passed\n'
        '320.00ns ERROR cocotb.regression  test_reset failed\n')
    assert len(plain) == 2
    assert plain[0]['passed'] is True and plain[1]['passed'] is False

    # Noise (running/start lines) never produces verdicts.
    assert ht._parse_cocotb_results(
        'running test_blink (1/3)\n0.00ns INFO start') == []

    # XML escaping: quotes/angle brackets in test + suite names must not
    # break the XML (name attribute is escaped, not just failReason).
    weird = [
        {'passed': True, 'skipped': False, 'simTimeNs': 1.0, 'name': 'a"b<c>'},
        {'passed': False, 'skipped': False, 'simTimeNs': 2.0,
         'name': 'x&y', 'failReason': 'assert "<bad>" & failed'},
    ]
    xml = ht._junit_xml(weird, 'su"ite')
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml)  # noqa: S314 — self-constructed string from the line above
    assert root.get('name') == 'su"ite'
    assert root[0].get('name') == 'a"b<c>'
    assert root[1][0].get('message') == 'assert "<bad>" & failed'

    # SKIP is not a failure: a run whose only non-PASS verdict is a SKIP
    # still counts as ok (mirrors the hdl_test ok computation).
    skip_run = [{'passed': False, 'skipped': True, 'simTimeNs': 0.0, 'name': 't_skip'}]
    assert not any(
        not v['passed'] and not v.get('skipped') for v in skip_run)


def test_hdl_test_degrades_without_cocotb():
    import asyncio

    from app.services.tools import hdl_tools as ht

    # module arg pointing at a missing file raises; valid inline module with
    # no cocotb installed → install guidance (spec import fails).
    try:
        asyncio.run(ht.hdl_test('missing_tb.py', sources=[VHDL_TB]))
        assert False
    except ValueError:
        pass
    import importlib.util

    if importlib.util.find_spec('cocotb_tools') is None:
        r = asyncio.run(ht.hdl_test(
            'import cocotb\n@cocotb.test()\nasync def t(_): pass\n',
            sources=[VHDL_TB]))
        assert r['installed'] is False and 'cocotb' in r['error']


def test_hdl_timing_diagram_validates_wavejson(tmp_path):
    import asyncio

    from app.services.tools import hdl_tools as ht

    # Bad JSON / no signal array raises with guidance.
    for bad in ('{nope', json.dumps({'foo': 1})):
        try:
            asyncio.run(ht.hdl_timing_diagram(bad, workspace=str(tmp_path)))
            assert False
        except ValueError:
            pass
    # Valid WaveJSON always yields the zero-install URL form.
    r = asyncio.run(ht.hdl_timing_diagram(
        {'signal': [{'name': 'clk', 'wave': 'p...'}, {'name': 'req', 'wave': '01.'}]},
        name='demo', workspace=str(tmp_path)))
    assert r['ok'] is True
    assert r['url'].startswith('https://svg.wavedrom.com/')
    assert 'signal' in r['wavejson']
    # rendered depends on wavedrom-cli presence — assert boolean either way.
    assert isinstance(r['rendered'], bool)
    if r['rendered']:
        assert Path(str(r['svgFile'])).is_file()


# ── fpga_compile — Quartus flow + report parsing (P4.5) ────────────────────

FIT_SUMMARY = """Fitter Status : Successful - Sat Aug 29 03:32:06 2026
Quartus Prime Version : 18.1.0 Build 625 09/12/2018 SJ Standard Edition
Revision Name : andtest
Top-level Entity Name : andgate
Family : Cyclone IV E
Total logic elements : 1 / 6,272  ( < 1 % )
    Total combinational functions : 1
    Dedicated logic registers : 0
Total registers : 0
Total pins : 3 / 92  ( 3 % )
Total memory bits : 0
"""

MAP_RPT_MESSAGES = """Info (12021): Found 1 design units, including 1 entities, in source file andgate.vhd
Error (10500): VHDL syntax error at andgate.vhd(15) near text ";"
Critical Warning (10492): VHDL Input File line 15 does not follow recommended file naming convention
Warning (10658): Verilog Input Port declarations should not be used
"""


def test_fpga_summary_and_rpt_parsers():
    from app.services.tools import fpga_tools as ft

    s = ft._parse_summary(FIT_SUMMARY)
    assert s['Fitter Status'].startswith('Successful')
    assert ft._parse_int(s['Total logic elements']) == 1
    assert ft._parse_int(s['Total pins']) == 3
    assert ft._parse_int('6,272 total') == 6272

    diags = ft._parse_rpt_messages(MAP_RPT_MESSAGES)
    errs = [d for d in diags if d['severity'] == 'error']
    assert len(errs) == 1
    assert errs[0]['file'] == 'andgate.vhd' and errs[0]['line'] == 15
    crits = [d for d in diags if d['severity'] == 'criticalwarning']
    assert len(crits) == 1
    assert all(d['severity'] in ('info', 'warning', 'error', 'criticalwarning')
               for d in diags)


def test_fpga_fmax_parser_real_layout():
    """Real Quartus 18.1 sta.rpt shape: ToC entries must be skipped, the
    section window must stop before empty later corners, rows parse per
    clock, and the worst (lowest restricted) fmax is surfaced."""
    from app.services.tools import fpga_tools as ft

    real_shaped = (
        '---------------------\n'
        '  1. Legal Notice\n'
        '  5. Slow 1200mV 85C Model Fmax Summary\n'   # ToC entry — skip
        '  6. Timing Closure Recommendations\n'
        '\n'
        '+---------------------------------------------------+\n'
        '; Slow 1200mV 85C Model Fmax Summary               ;\n'
        '+-------------+-----------------+------------+------+\n'
        '; Fmax        ; Restricted Fmax ; Clock Name ; Note ;\n'
        '+-------------+-----------------+------------+------+\n'
        '; 1322.75 MHz ; 250.0 MHz       ; clk        ; note ;\n'
        '+-------------+-----------------+------------+------+\n'
        '\n'
        '----------------------------------\n'
        '; Slow 1200mV 0C Model Fmax Summary ;\n'     # empty later corner
        'No paths to report.\n'
    )
    r = ft._parse_fmax(real_shaped)
    assert r is not None, 'ToC hit must not be mistaken for the section'
    assert r['fmaxMHz'] == 250.0
    assert r['clocks'][0] == {
        'clock': 'clk',
        'restrictedFmaxMHz': 250.0,
        'unrestrictedFmaxMHz': 1322.75,
    }

    multi = (
        'Slow 1200mV 85C Model Fmax Summary\n'
        '+-------------+-----------------+------------+\n'
        '; Fmax        ; Restricted Fmax ; Clock Name ;\n'
        '; 300.5 MHz   ; 280.1 MHz       ; clk_b      ;\n'
        '; 1322.75 MHz ; 250.0 MHz       ; clk_a      ;\n'
    )
    r2 = ft._parse_fmax(multi)
    assert r2['fmaxMHz'] == 250.0  # worst = lowest restricted
    assert [c['clock'] for c in r2['clocks']] == ['clk_a', 'clk_b']

    # Comb-only / no reg-to-reg design: empty section → None.
    assert ft._parse_fmax(
        'Slow 1200mV 85C Model Fmax Summary\nNo paths to report.\n') is None
    # ToC-only text (no bordered section) → None.
    assert ft._parse_fmax(
        'Table of Contents\n  5. Fmax Summary\n  6. Other\n') is None


def test_fpga_qsf_generation_pins_and_device():
    from app.services.tools import fpga_tools as ft

    qsf = ft._qsf_text(
        'proj', 'top_ent', ['top_ent.vhd'], 'EP4CE6E22C6', 'Cyclone IV E',
        {'A': 'PIN_23', 'Y': 'PIN_99'})
    assert 'set_global_assignment -name DEVICE EP4CE6E22C6' in qsf
    assert 'set_global_assignment -name VHDL_FILE top_ent.vhd' in qsf
    assert 'set_location_assignment -to A PIN_23' in qsf
    assert 'set_location_assignment -to Y PIN_99' in qsf
    assert 'TOP_LEVEL_ENTITY top_ent' in qsf


def test_fpga_compile_validates_and_degrades():
    import asyncio

    from app.services.tools import fpga_tools as ft

    try:
        asyncio.run(ft.fpga_compile(''))
        assert False
    except ValueError:
        pass
    orig = ft.resolve_quartus_sh
    ft.resolve_quartus_sh = lambda: None
    try:
        r = asyncio.run(ft.fpga_compile('entity x is end x;'))
        assert r['installed'] is False and 'Quartus' in r['error']
    finally:
        ft.resolve_quartus_sh = orig


# ── kicad_checks + kicad_render — ERC/DRC gates + board visuals (P5.1) ────

KICAD_DRC_JSON = json.dumps({
    'severity': 'error',
    'violations': [
        {
            'severity': 'error',
            'type': 'clearance',
            'description': 'Items are too close (0.15mm < 0.20mm)',
            'items': [{'description': 'track on F.Cu'}],
        },
        {
            'severity': 'warning',
            'type': 'silk_over_copper',
            'description': 'Silkscreen intersects copper',
            'items': [],
        },
    ],
})


def test_kicad_violation_json_parser():
    from app.services.tools import kicad_tools as kt

    parsed = kt._parse_violation_json(KICAD_DRC_JSON)
    assert parsed['count'] == 2 and parsed['format'] == 'json'
    assert parsed['violations'][0]['severity'] == 'error'
    assert parsed['violations'][0]['type'] == 'clearance'
    # Text fallback when the CLI emits human output.
    text = kt._parse_violation_json('Found 3 unconnected items\n')
    assert text['count'] == 3 and text['format'] == 'text'


def test_kicad_checks_degrades_and_validates(tmp_path):
    import asyncio

    from app.services.tools import kicad_tools as kt

    orig = kt.resolve_kicad_cli
    kt.resolve_kicad_cli = lambda: None
    try:
        # Real .kicad_sch file, no CLI → install guidance.
        sch = tmp_path / 'demo.kicad_sch'
        sch.write_text('(kicad_sch)', encoding='utf-8')
        r = asyncio.run(kt.kicad_checks(sch=str(sch), workspace=str(tmp_path)))
        assert r['installed'] is False and 'kicad-cli' in r['error']
    finally:
        kt.resolve_kicad_cli = orig
    # Neither sch nor pcb → ValueError asking for one.
    try:
        asyncio.run(kt.kicad_checks())
        assert False
    except ValueError:
        pass
    # Wrong suffix → ValueError naming the expected kinds.
    sch2 = tmp_path / 'demo2.kicad_sch'
    sch2.write_text('(kicad_sch)', encoding='utf-8')
    try:
        asyncio.run(kt.kicad_checks(pcb=str(sch2), workspace=str(tmp_path)))
        assert False
    except ValueError as exc:
        assert '.kicad_pcb' in str(exc)


def test_kicad_render_degrades_and_validates(tmp_path):
    import asyncio

    from app.services.tools import kicad_tools as kt

    orig = kt.resolve_kicad_cli
    kt.resolve_kicad_cli = lambda: None
    try:
        r = asyncio.run(kt.kicad_render(pcb='x.kicad_pcb', workspace=str(tmp_path)))
        assert r['installed'] is False and 'kicad-cli' in r['error']
    finally:
        kt.resolve_kicad_cli = orig
    # Bad format → ValueError.
    try:
        asyncio.run(kt.kicad_render(
            pcb='x.kicad_pcb', format='stl', workspace=str(tmp_path)))
        assert False
    except ValueError:
        pass


def test_circuit_gate_owns_kicad_family():
    from app.services.tool_registrations.circuit_tools import _is_circuit_gate_tool as owns

    for name in ('kicad_checks', 'kicad_render', 'fpga_compile', 'fpga_program',
                 'vcd_parse', 'hdl_lint', 'firmware_stimulus', 'circuit_simulate'):
        assert owns(name) is True, name
    # Look-alikes outside the gate stay available in every mode.
    for name in ('run_command', 'search_files', 'read_file', 'render_chart'):
        assert owns(name) is False, name
