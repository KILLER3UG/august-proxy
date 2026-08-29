"""Golden-circuit regression — the accuracy anchor for the ngspice path.

A small corpus of decks with hand-computed expected measures ± tolerance.
These lock the physics BEFORE any simulation-path change (invocation mode,
convergence ladder, measure parsing) may touch the numbers: if a golden
deck drifts, the harness is no longer measuring like a bench.

Skipped cleanly when ngspice is absent; XSPICE-dependent decks skip
themselves when the installed build lacks code models.
"""

from __future__ import annotations

import asyncio
import math
from pathlib import Path

import pytest
from app.services.tools import circuit_tools

pytestmark = pytest.mark.skipif(
    circuit_tools.resolve_ngspice() is None,
    reason='ngspice not installed',
)


def _sim(deck: str) -> dict:
    return asyncio.run(circuit_tools.simulate_circuit(deck, name='golden'))


def _measure(result: dict, name: str) -> float:
    measures = result.get('measures')
    assert isinstance(measures, dict), f'no measures parsed: {result.get("errors")}'
    assert name in measures, f'{name} missing from {sorted(measures)}'
    return float(measures[name])  # type: ignore[arg-type]


def _assert_close(result: dict, name: str, expected: float, rel_tol: float) -> float:
    value = _measure(result, name)
    assert math.isclose(value, expected, rel_tol=rel_tol), (
        f'{name} = {value!r}, expected {expected!r} ± {rel_tol:.0%}'
    )
    return value


_XSPICE_AVAILABLE: bool | None = None


def _xspice_available() -> bool:
    """Probe the installed ngspice once with a known-good XSPICE deck.

    The verdict comes from circuit_env's validated inverter probe, so a
    broken golden deck fails loudly instead of hiding behind a skip.
    """
    global _XSPICE_AVAILABLE
    if _XSPICE_AVAILABLE is None:
        info = asyncio.run(circuit_tools._probe_ngspice())
        _XSPICE_AVAILABLE = info.get('xspice') is True
    return _XSPICE_AVAILABLE


# ── Golden decks ──────────────────────────────────────────────────────────

_DIVIDER = """* golden: voltage divider .op
V1 in 0 DC 10
R1 in mid 1k
R2 mid 0 1k
.op
.end
"""

# tau = R*C = 1ms; at t = tau the step response reaches 1 - 1/e of 5 V.
_RC_STEP = """* golden: RC step response .tran
V1 in 0 PULSE(0 5 0 1n 1n 10m 20m)
R1 in out 1k
C1 out 0 1u
.tran 10u 12m
.control
run
meas tran v_tau FIND v(out) AT=1m
meas tran v_final FIND v(out) AT=9m
.endc
.end
"""

# f_-3dB = 1/(2*pi*R*C) = 159.15 Hz for 1k / 1u.
_RC_LOWPASS_AC = """* golden: RC lowpass .ac -3dB point
V1 in 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 20 1 10k
.control
run
meas ac fc WHEN vdb(out)=-3
.endc
.end
"""

# 555 astable built from XSPICE primitives (adc_bridge comparators at
# 1/3 and 2/3 Vcc with 5mV hysteresis, d_srff latch, SW discharge FET).
# Ra=1k Rb=10k C=100n: ideal T = 0.693*(Ra+2Rb)*C = 1.458ms; the bridge
# hysteresis + switch Ron stretch that to ~1.48ms analytically.
_ASTABLE_555 = """* golden: 555 astable via XSPICE primitives
.model swmod SW(RON=10 ROFF=1e9 VT=0.5 VH=0.1)
.model cmphi adc_bridge(in_low=3.3283 in_high=3.3383)
.model cmplo adc_bridge(in_low=1.6617 in_high=1.6717)
.model pdmod d_pulldown
.model srffmod d_srff(ic=0)
.model invmod d_inverter
.model qbridge dac_bridge
.model obridge dac_bridge
Vcc vcc 0 DC 5
Ra vcc disch 1k
Rb disch cap 10k
C1 cap 0 100n IC=2.5
S1 disch 0 qana 0 swmod
A1 [cap] [thr] cmphi
A2 [cap] [trig] cmplo
A7 clk0 pdmod
A4 clk0 clk0 clk0 thr trign q nq srffmod
A3 trig trign invmod
A5 [q] [qana] qbridge
A6 [nq] [outa] obridge
.tran 1u 10m UIC
.control
run
meas tran period TRIG v(outa) VAL=0.5 RISE=1 TARG v(outa) VAL=0.5 RISE=2
meas tran tdis TRIG v(outa) VAL=0.5 FALL=1 TARG v(outa) VAL=0.5 RISE=1
meas tran tchg TRIG v(outa) VAL=0.5 RISE=1 TARG v(outa) VAL=0.5 FALL=2
.endc
.end
"""

# Digital inverter through the shipped code models; the dac_bridge exposes
# the digital output as a 0/1 V analog vector. The pulse starts at 10n —
# an edge at t=0 is swallowed by digital initial-state resolution.
_XSPICE_INVERTER = """* golden: XSPICE inverter
.model invmod d_inverter
.model br1 dac_bridge
V1 in 0 PULSE(0 5 10n 1n 1n 50n 100n)
A1 in dout invmod
A2 [dout] [outa] br1
.tran 1n 250n
.control
run
meas tran t_hl WHEN v(outa)=0.5 FALL=1
meas tran t_lh WHEN v(outa)=0.5 RISE=1
meas tran vmin MIN v(outa)
meas tran vmax MAX v(outa)
.endc
.end
"""


# ── Tests ─────────────────────────────────────────────────────────────────


def test_golden_voltage_divider_op():
    result = _sim(_DIVIDER)
    assert result.get('installed') is True
    # 10 V across two equal resistors: mid sits at half, source sinks 5 mA.
    _assert_close(result, 'v(mid)', 5.0, 1e-3)
    _assert_close(result, 'i(v1)', -5e-3, 1e-3)


def test_golden_rc_step_response():
    result = _sim(_RC_STEP)
    # v(tau) = 5*(1 - e^-1) = 3.1606 V; settled value within 0.5% of 5 V.
    _assert_close(result, 'v_tau', 5 * (1 - math.exp(-1)), 0.01)
    _assert_close(result, 'v_final', 5.0, 5e-3)


def test_golden_rc_lowpass_ac_3db():
    result = _sim(_RC_LOWPASS_AC)
    _assert_close(result, 'fc', 1 / (2 * math.pi * 1000 * 1e-6), 0.02)


def test_golden_555_astable_xspice():
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    result = _sim(_ASTABLE_555)
    # Ideal 555 formula ± slack for the 5mV comparator hysteresis and the
    # 10-ohm switch Ron (analytic stretch is +1.7%, measured +1.8%).
    _assert_close(result, 'period', 0.693 * (1000 + 2 * 10000) * 100e-9, 0.05)
    _assert_close(result, 'tdis', 0.693 * 10000 * 100e-9, 0.06)
    _assert_close(result, 'tchg', 0.693 * (1000 + 10000) * 100e-9, 0.06)


def test_golden_xspice_inverter():
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    result = _sim(_XSPICE_INVERTER)
    # Full rail-to-rail swing on the bridged output...
    assert _measure(result, 'vmin') < 0.2
    assert _measure(result, 'vmax') > 0.8
    # ...and real gate delay after each input edge (10.5ns / 61.5ns):
    # a handful of ns, never zero and never microseconds.
    t_hl = _measure(result, 't_hl')
    t_lh = _measure(result, 't_lh')
    assert 10.5e-9 < t_hl < 30e-9, f't_hl = {t_hl}'
    assert 61.5e-9 < t_lh < 80e-9, f't_lh = {t_lh}'


# ── 74xx XSPICE card goldens (P1.6) ──────────────────────────────────────
# These decks paste the exact card text circuit_integrate_component hands
# out (circuit_tools._XSPICE_CARDS) and exercise it end-to-end, so a card
# edit that breaks silicon breaks the suite. Digital outputs are bridged
# to 0–1 V analog vectors so ordinary .meas can see them.


def test_golden_7400_nand_card():
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    deck = circuit_tools._XSPICE_CARDS['7400'] + """* stimulus + bridge
.model pu d_pullup
.model pd d_pulldown
.model br dac_bridge
Ap1 hi pu
Ap2 lo pd
X1 lo lo y1 hi lo y2 hi hi y3 lo hi y4 7400
Ab1 [y1] [y1a] br
Ab2 [y2] [y2a] br
Ab3 [y3] [y3a] br
Ab4 [y4] [y4a] br
.tran 1n 100n
.control
run
meas tran y1 FIND v(y1a) AT=90n
meas tran y2 FIND v(y2a) AT=90n
meas tran y3 FIND v(y3a) AT=90n
meas tran y4 FIND v(y4a) AT=90n
.endc
.end
"""
    result = _sim(deck)
    # Full NAND truth table across gates 1–4: 00→1, 10→1, 11→0, 01→1.
    assert _measure(result, 'y1') > 0.8
    assert _measure(result, 'y2') > 0.8
    assert _measure(result, 'y3') < 0.2
    assert _measure(result, 'y4') > 0.8


def test_golden_74161_counter_card():
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    deck = circuit_tools._XSPICE_CARDS['74161'] + """* stimulus + bridge
.model pu d_pullup
.model br dac_bridge
Vclk clk 0 PULSE(0 5 10n 1n 1n 490n 1u)
Ap1 hi pu
X1 clk hi hi q0 q1 q2 q3 rco 74161
Ab0 [q0] [q0a] br
Ab1 [q1] [q1a] br
Ab2 [q2] [q2a] br
Abr [rco] [rcoa] br
.tran 10n 16u
.control
run
meas tran q0_5 FIND v(q0a) AT=4.5u
meas tran q1_5 FIND v(q1a) AT=4.5u
meas tran q2_5 FIND v(q2a) AT=4.5u
meas tran rco_15 FIND v(rcoa) AT=14.5u
meas tran rco_16 FIND v(rcoa) AT=15.5u
.endc
.end
"""
    result = _sim(deck)
    # Rising edges land at 10n, 1.01u, 2.01u… — after 5 of them the
    # count is 5 (0101b): q0=1, q1=0, q2=1.
    assert _measure(result, 'q0_5') > 0.8
    assert _measure(result, 'q1_5') < 0.2
    assert _measure(result, 'q2_5') > 0.8
    # RCO asserts while the count sits at 15…
    assert _measure(result, 'rco_15') > 0.8
    # …and drops once the counter rolls over to 0.
    assert _measure(result, 'rco_16') < 0.2


def test_golden_74595_shift_card():
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    deck = circuit_tools._XSPICE_CARDS['74595'] + """* stimulus + bridge
.model br dac_bridge
Vser ser 0 PWL(0 5 1u 5 1.01u 0 2u 0 2.01u 5 4u 5 4.01u 0 6u 0 6.01u 5 7u 5 7.01u 0 12u 0)
Vsrclk srclk 0 PULSE(0 5 0.5u 1n 1n 490n 1u)
Vrclk rclk 0 PULSE(0 5 8.2u 1n 1n 100n 10u)
X1 ser srclk rclk q0 q1 q2 q3 q4 q5 q6 q7 qhs 74595
Ab0 [q0] [q0a] br
Ab1 [q1] [q1a] br
Ab2 [q2] [q2a] br
Ab3 [q3] [q3a] br
Ab4 [q4] [q4a] br
Ab5 [q5] [q5a] br
Ab6 [q6] [q6a] br
Ab7 [q7] [q7a] br
Abh [qhs] [qhsa] br
.tran 20n 10u
.control
run
meas tran q0 FIND v(q0a) AT=9.5u
meas tran q1 FIND v(q1a) AT=9.5u
meas tran q2 FIND v(q2a) AT=9.5u
meas tran q3 FIND v(q3a) AT=9.5u
meas tran q4 FIND v(q4a) AT=9.5u
meas tran q5 FIND v(q5a) AT=9.5u
meas tran q6 FIND v(q6a) AT=9.5u
meas tran q7 FIND v(q7a) AT=9.5u
meas tran qhs FIND v(qhsa) AT=8u
.endc
.end
"""
    result = _sim(deck)
    # 10110010 shifted in MSB-first on 8 SRCLK edges (0.5u…7.5u),
    # latched at 8.2u: Q7..Q0 must read the pattern back.
    expected = {'q7': 1, 'q6': 0, 'q5': 1, 'q4': 1,
                'q3': 0, 'q2': 0, 'q1': 1, 'q0': 0}
    for name, bit in expected.items():
        value = _measure(result, name)
        if bit:
            assert value > 0.8, f'{name} = {value}'
        else:
            assert value < 0.2, f'{name} = {value}'
    # QHS is the unlatched shift chain: it echoes the last bit (1)
    # before a ninth edge at 8.5u pushes a zero through.
    assert _measure(result, 'qhs') > 0.8


def test_golden_7474_dff_card():
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    deck = circuit_tools._XSPICE_CARDS['7474'] + """* stimulus + bridge
.model pu d_pullup
.model pd d_pulldown
.model br dac_bridge
Vclk clk 0 PULSE(0 5 10n 1n 1n 90n 200n)
Vd d1 0 PULSE(0 5 5n 1n 1n 100n 400n)
Vpre pre2 0 PULSE(5 0 300n 1n 1n 50n 1u)
Ap1 hi pu
Ap2 lo pd
X1 clk d1 hi hi q1 nq1 clk lo pre2 hi q2 nq2 7474
Ab1 [q1] [q1a] br
Ab2 [q2] [q2a] br
.tran 1n 600n
.control
run
meas tran q1_100 FIND v(q1a) AT=100n
meas tran q1_300 FIND v(q1a) AT=300n
meas tran q2_200 FIND v(q2a) AT=200n
meas tran q2_400 FIND v(q2a) AT=400n
.endc
.end
"""
    result = _sim(deck)
    # FF1 tracks D on rising clock: D=1 at the 10n edge, D=0 at 210n.
    assert _measure(result, 'q1_100') > 0.8
    assert _measure(result, 'q1_300') < 0.2
    # FF2 has D=0, so Q stays low through both edges…
    assert _measure(result, 'q2_200') < 0.2
    # …until the active-low preset fires asynchronously at 300n.
    assert _measure(result, 'q2_400') > 0.8


def test_golden_7476_jkff_card():
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    deck = circuit_tools._XSPICE_CARDS['7476'] + """* stimulus + bridge
.model pu d_pullup
.model br dac_bridge
Vclk clk 0 PULSE(0 5 10n 1n 1n 90n 200n)
Vclr clr2 0 PULSE(5 0 400n 1n 1n 50n 1u)
Ap1 jhi pu
Ap2 hi2 pu
X1 clk jhi jhi hi2 hi2 q1 nq1 clk jhi jhi hi2 clr2 q2 nq2 7476
Ab1 [q1] [q1a] br
Ab2 [q2] [q2a] br
.tran 1n 600n
.control
run
meas tran q1_100 FIND v(q1a) AT=100n
meas tran q1_300 FIND v(q1a) AT=300n
meas tran q2_100 FIND v(q2a) AT=100n
meas tran q2_500 FIND v(q2a) AT=500n
.endc
.end
"""
    result = _sim(deck)
    # J=K=1 toggles on every rising edge: high after the first (10n),
    # low again after the second (210n).
    assert _measure(result, 'q1_100') > 0.8
    assert _measure(result, 'q1_300') < 0.2
    # FF2 toggles high too, then its active-low clear drops it at 400n
    # with no clock edge involved.
    assert _measure(result, 'q2_100') > 0.8
    assert _measure(result, 'q2_500') < 0.2


def test_golden_ne555_macro_astable():
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    deck = circuit_tools._XSPICE_CARDS['ne555'] + """* astable: Ra=1k Rb=10k C=100n
Vcc vcc 0 DC 5
Ra vcc disch 1k
Rb disch cap 10k
C1 cap 0 100n IC=2.5
X1 0 cap out rstctl rstctl cap disch vcc NE555
.tran 1u 10m UIC
.control
run
meas tran period TRIG v(out) VAL=2.5 RISE=1 TARG v(out) VAL=2.5 RISE=2
meas tran vmin MIN v(out)
meas tran vmax MAX v(out)
.endc
.end
"""
    result = _sim(deck)
    # Ideal 555 astable period ± the same hysteresis/Ron slack as the
    # primitive-level golden deck above.
    _assert_close(result, 'period', 0.693 * (1000 + 2 * 10000) * 100e-9, 0.05)
    # Macro output swings rail-to-rail on the external VCC.
    assert _measure(result, 'vmin') < 0.5
    assert _measure(result, 'vmax') > 4.5


# ── VCD export (P1.7) ─────────────────────────────────────────────────────


def test_golden_vcd_export_inverter(tmp_path):
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    result = asyncio.run(circuit_tools.circuit_export_vcd(
        _XSPICE_INVERTER, name='golden_vcd', workspace=str(tmp_path),
    ))
    assert result.get('installed') is True, result
    vcd_file = result.get('vcdFile')
    assert vcd_file, result
    text = Path(str(vcd_file)).read_text(encoding='utf-8')
    assert '$timescale' in text
    assert '$var' in text and 'dout' in text
    # Discovery pass exports every event node (input + output).
    assert set(result['signals']) >= {'in', 'dout'}  # type: ignore[operator]
    # eprvcd timestamps stop at the last value change (~212 ns for the
    # inverter's 250 ns window), so the duration is bounded by the
    # .tran window, not equal to it.
    duration = float(result['duration'])  # type: ignore[arg-type]
    assert 200e-9 < duration <= 260e-9, duration
    # Two input edges + two inverted output edges, at minimum.
    assert int(result['valueChanges']) >= 4  # type: ignore[arg-type]


def test_golden_vcd_export_explicit_signals(tmp_path):
    if not _xspice_available():
        pytest.skip('XSPICE code models unavailable in this ngspice build')
    result = asyncio.run(circuit_tools.circuit_export_vcd(
        _XSPICE_INVERTER, signals=['dout'], name='one_sig',
        workspace=str(tmp_path),
    ))
    assert result.get('vcdFile'), result
    assert result['signals'] == ['dout']
    assert result['signalCount'] == 1


def test_vcd_export_requires_tran():
    result = asyncio.run(circuit_tools.circuit_export_vcd(
        '* no tran here\nR1 1 0 1k\nV1 1 0 DC 1\n.end'
    ))
    assert '.tran' in result.get('error', '')


def test_vcd_export_no_event_nodes():
    deck = """* pure analog RC — no XSPICE A-devices
V1 in 0 PULSE(0 5 10n 1n 1n 50n 100n)
R1 in out 1k
C1 out 0 1n
.tran 1n 250n
.end
"""
    result = asyncio.run(circuit_tools.circuit_export_vcd(deck))
    assert 'No event' in result.get('error', '')


# ── Symbolic ↔ numeric cross-check (P1.4) ──────────────────────────────────


def test_golden_symbolic_vs_ngspice_cutoff():
    """lcapy's symbolic −3 dB point must match ngspice's .ac measure.

    The RC lowpass has H(s) = 1/(1 + sRC); its −3 dB angular frequency is
    1/RC. This is the plan's stated use for circuit_symbolic: cross-check
    simulated numbers against closed-form math.
    """
    if not circuit_tools._lcapy_ok():
        pytest.skip('lcapy not installed (uv sync --extra eda)')
    sym = circuit_tools.circuit_symbolic(_RC_LOWPASS_AC)
    assert sym['installed'] is True, sym
    # Pole at −1/RC → cutoff ω = 1000 rad/s → f = 1000/(2π) ≈ 159.15 Hz.
    assert sym['poles'] == {'-1000': 1}
    fc_symbolic = 1000 / (2 * math.pi)

    result = _sim(_RC_LOWPASS_AC)
    _assert_close(result, 'fc', fc_symbolic, 0.02)


# ── Waveform traces (P1.1) ────────────────────────────────────────────────


def test_traces_rc_step_tran():
    result = asyncio.run(circuit_tools.simulate_circuit(
        _RC_STEP, name='golden_tr', traces=['v(out)', 'v(in)'],
    ))
    traces = result.get('traces')
    assert isinstance(traces, dict), f'no traces: {result.get("traceWarnings")}'
    assert set(traces) == {'v(out)', 'v(in)'}
    t = traces['v(out)']
    xs, ys = t['x'], t['y']
    assert t['xunit'] == 's' and t['unit'] == 'V'
    assert len(xs) == len(ys) <= 2000
    assert xs == sorted(xs)
    assert xs[0] == pytest.approx(0.0, abs=1e-12)
    assert xs[-1] == pytest.approx(12e-3, rel=1e-3)
    # Step-response physics: starts at 0, charges to 5 V, and at t = tau
    # has covered 1 - 1/e of the way.
    assert ys[0] == pytest.approx(0.0, abs=1e-6)
    assert max(ys) == pytest.approx(5.0, rel=5e-3)
    i_tau = min(range(len(xs)), key=lambda i: abs(xs[i] - 1e-3))
    assert ys[i_tau] == pytest.approx(5 * (1 - math.exp(-1)), rel=0.02)
    # The input square wave reaches the full rail on its own trace.
    assert max(traces['v(in)']['y']) == pytest.approx(5.0, rel=1e-3)
    # Measures still parse alongside traces (deck .control untouched).
    _assert_close(result, 'v_final', 5.0, 5e-3)


def test_traces_ac_db_and_magnitude():
    result = asyncio.run(circuit_tools.simulate_circuit(
        _RC_LOWPASS_AC, name='golden_ac_tr', traces=['vdb(out)', 'v(out)'],
    ))
    traces = result.get('traces')
    assert isinstance(traces, dict), f'no traces: {result.get("traceWarnings")}'
    db = traces['vdb(out)']
    assert db['xunit'] == 'Hz' and db['unit'] == 'dB'
    # Passband gain ≈ 0 dB rolling off to ≈ -36 dB at 10 kHz (fc = 159 Hz).
    assert db['y'][0] == pytest.approx(0.0, abs=0.02)
    assert db['y'][-1] < -30
    # Bare v(out) in .ac is complex — wrdata emits (f, re, im), reduced
    # to magnitude: ≈ 1 in band, ≈ fc/f at the top of the sweep.
    mag = traces['v(out)']
    assert mag['unit'] == 'mag'
    assert mag['y'][0] == pytest.approx(1.0, rel=1e-2)
    assert mag['y'][-1] == pytest.approx(159.15 / 10000, rel=0.05)


def test_traces_skipped_without_sweep_analysis():
    result = asyncio.run(circuit_tools.simulate_circuit(
        _DIVIDER, name='golden_op_tr', traces=['v(mid)'],
    ))
    assert 'traces' not in result
    warns = result.get('traceWarnings')
    assert warns and '.tran/.ac/.dc' in str(warns[0])
    # The .op measures are unaffected.
    _assert_close(result, 'v(mid)', 5.0, 1e-3)


# ── Parametric sweeps (P1.2) ──────────────────────────────────────────────

_RC_STEP_PARAM = """* golden: RC step with sweepable R
.param tau_r=1k
V1 in 0 PULSE(0 5 0 1n 1n 10m 20m)
R1 in out {tau_r}
C1 out 0 1u
.tran 10u 12m
.control
run
meas tran v_tau FIND v(out) AT=1m
.endc
.end
"""

_DIVIDER_PARAM = """* golden: divider with sweepable R2
.param r2=1k
V1 in 0 DC 10
R1 in mid 1k
R2 mid 0 {r2}
.op
.end
"""


def test_sweep_rc_time_constant():
    # The deck's own .control (run + meas) is wrapped into the loop, so
    # v_tau comes back once per step: 5*(1 - e^(-1ms/tau)).
    result = asyncio.run(circuit_tools.simulate_circuit(
        _RC_STEP_PARAM, name='golden_sweep',
        sweep={'param': 'tau_r', 'from': 500, 'to': 2000, 'steps': 4},
    ))
    sr = result.get('sweepResults')
    assert isinstance(sr, list) and len(sr) == 4, result.get('sweepWarnings')
    assert [r['paramValue'] for r in sr] == [500, 1000, 1500, 2000]
    expected = {
        500: 5 * (1 - math.exp(-2)),
        1000: 5 * (1 - math.exp(-1)),
        1500: 5 * (1 - math.exp(-2 / 3)),
        2000: 5 * (1 - math.exp(-0.5)),
    }
    for r in sr:
        assert r['measures']['v_tau'] == pytest.approx(
            expected[r['paramValue']], rel=0.01
        ), r
    # Contract: scalar measures stay empty on sweep runs.
    assert result['measures'] == {}
    assert result['sweep'] == {'param': 'tau_r', 'from': 500.0, 'to': 2000.0, 'steps': 4}


def test_sweep_op_divider_print_all():
    # Control-less .op deck: the loop injects `print all` per step, and
    # bare op keys get the usual v(node) aliases.
    result = asyncio.run(circuit_tools.simulate_circuit(
        _DIVIDER_PARAM, name='golden_sweep_op',
        sweep={'param': 'r2', 'from': 500, 'to': 2000, 'steps': 4},
    ))
    sr = result.get('sweepResults')
    assert isinstance(sr, list) and len(sr) == 4, result.get('sweepWarnings')
    # v(mid) = 10 * r2 / (1k + r2)
    expected = {500: 10 * 500 / 1500, 1000: 5.0, 1500: 6.0, 2000: 10 * 2000 / 3000}
    for r in sr:
        assert r['measures']['v(mid)'] == pytest.approx(
            expected[r['paramValue']], rel=1e-3
        ), r


# ── circuit_test — assertions over measures (P1.3) ────────────────────────


def test_circuit_test_passes_on_golden_decks():
    # The golden decks graded through the assertion tool instead of
    # hand-rolled pytest.approx — this is the agent's self-verify loop.
    verdict = asyncio.run(circuit_tools.circuit_test(_DIVIDER, [
        {'measure': 'v(mid)', 'expect': 5.0, 'tolerance': 1e-3},
        {'measure': 'i(v1)', 'expect': -5e-3, 'tolerance': 1e-3},
    ], name='ct_divider'))
    assert verdict['passed'] is True, verdict
    assert all(r['ok'] for r in verdict['results'])

    rc = asyncio.run(circuit_tools.circuit_test(_RC_STEP, [
        {'measure': 'v_tau', 'expect': 5 * (1 - math.exp(-1)), 'tolerance': 0.01},
        {'measure': 'v_final', 'min': 4.95, 'max': 5.05},
    ], name='ct_rc'))
    assert rc['passed'] is True, rc


def test_circuit_test_fails_loudly_on_bad_expectation():
    verdict = asyncio.run(circuit_tools.circuit_test(_DIVIDER, [
        {'measure': 'v(mid)', 'expect': 9.9, 'tolerance': 0.01},  # wrong on purpose
    ], name='ct_bad'))
    assert verdict['passed'] is False
    assert verdict['results'][0]['ok'] is False
    # The underlying measures are attached so the agent can fix the deck.
    assert verdict['measures'].get('v(mid)') == pytest.approx(5.0, rel=1e-3)


def test_circuit_test_flags_missing_measure():
    verdict = asyncio.run(circuit_tools.circuit_test(_DIVIDER, [
        {'measure': 'v(nonexistent)', 'expect': 1.0},
    ], name='ct_missing'))
    assert verdict['passed'] is False
    assert 'not found' in str(verdict['results'][0]['note'])


def test_fault_injection_end_to_end():
    # Fault a golden deck, then simulate the variant: the symptom must
    # match circuit theory (the troubleshooting-exercise loop).
    shorted = circuit_tools.inject_fault(_DIVIDER, 'R2', 'short')
    assert 'error' not in shorted
    sim = asyncio.run(circuit_tools.simulate_circuit(
        shorted['netlist'], name='fault_short'))
    assert sim.get('exitCode') == 0, sim
    assert sim['measures']['v(mid)'] == pytest.approx(0.0, abs=0.05)

    drifted = circuit_tools.inject_fault(_DIVIDER, 'R1', 'drift', 100)
    assert 'error' not in drifted and '2000' in str(drifted['change'])
    sim2 = asyncio.run(circuit_tools.simulate_circuit(
        drifted['netlist'], name='fault_drift'))
    assert sim2.get('exitCode') == 0, sim2
    # R1 = 2 kΩ, R2 = 1 kΩ → v(mid) = 10 · 1/3.
    assert sim2['measures']['v(mid)'] == pytest.approx(10 / 3, rel=1e-3)

    opened = circuit_tools.inject_fault(_DIVIDER, 'R2', 'open')
    assert 'error' not in opened
    sim3 = asyncio.run(circuit_tools.simulate_circuit(
        opened['netlist'], name='fault_open'))
    assert sim3.get('exitCode') == 0, sim3
    # Divider leg gone: mid rises to in through R1 (no DC current).
    assert sim3['measures']['v(mid)'] == pytest.approx(10.0, rel=1e-3)


def test_golden_annotate_overlay_matches_op():
    """circuit_annotate must agree with simulate_circuit's .op numbers.

    Divider: 10 V across 1k+1k → mid = 5 V, source current 10 mA. The
    SVG must carry the same values, colored per the blue→red ramp.
    """
    ws = Path(__file__).parent / '.golden_ws'
    ws.mkdir(exist_ok=True)
    try:
        r = asyncio.run(circuit_tools.circuit_annotate(
            _DIVIDER, name='divider_op', workspace=str(ws)))
        assert r.get('installed') is True and r.get('converged') is True, r
        assert r['nodeVoltages']['mid'] == pytest.approx(5.0, rel=1e-3)
        # Cross-check the branch current against simulate_circuit's own
        # .op parse — annotate and simulate must agree exactly (that is
        # the whole promise of the overlay).
        sim = asyncio.run(circuit_tools.simulate_circuit(
            _DIVIDER, name='annotate_xcheck'))
        assert 'i(v1)' in sim['measures']
        assert r['branchCurrents']['v1'] == pytest.approx(
            sim['measures']['i(v1)'], rel=1e-6)

        svg = Path(r['savedTo']).read_text(encoding='utf-8')
        assert svg.startswith('<svg') and '</svg>' in svg
        assert '5 V' in svg  # mid label
        assert 'R1 1k' in svg and 'V1' in svg  # element rungs
        # Voltage ramp present: at least one colored node dot (fill="#hex").
        import re as _re
        assert _re.search(r'fill="#[0-9a-f]{6}"', svg)
    finally:
        import shutil
        shutil.rmtree(ws, ignore_errors=True)


def test_golden_firmware_compile_blink(tmp_path):
    """Real arduino-cli compile through firmware_compile: blink.hex + sizes.

    Skips when arduino-cli is absent (the env-detected posture — other
    machines get guidance tests in test_circuit_gate).
    """
    import asyncio

    from app.services.tools import firmware_tools as ft

    if ft._resolve_arduino_cli() is None:
        pytest.skip('arduino-cli not installed')
    sketch = (
        'void setup() { pinMode(13, OUTPUT); Serial.begin(9600); }\n'
        'void loop() {\n'
        '  digitalWrite(13, HIGH); delay(500);\n'
        '  digitalWrite(13, LOW); delay(500);\n'
        '  Serial.println("blink");\n'
        '}\n'
    )
    r = asyncio.run(ft.firmware_compile(
        sketch, name='blink', board='uno', workspace=str(tmp_path)))
    assert r.get('ok') is True, r
    assert r['board'] == 'arduino:avr:uno'
    hex_path = Path(r['hexFile'])
    assert hex_path.exists() and hex_path.stat().st_size > 100
    assert hex_path.suffix == '.hex'
    # Intel HEX starts with the ':' record marker.
    assert hex_path.read_text(encoding='utf-8', errors='replace').lstrip().startswith(':')
    # Flash report parsed from the arduino-cli output.
    assert r['flash']['bytes'] > 0 and r['flash']['percent'] < 100


def test_golden_firmware_run_blink_serial_and_pins(tmp_path):
    """Real compile → emulate chain: serial "blink" + pin-13 timeline.

    Skips when arduino-cli or the Node sidecar is missing.
    """
    import asyncio

    from app.services.tools import firmware_tools as ft

    if ft._resolve_arduino_cli() is None:
        pytest.skip('arduino-cli not installed')
    if ft._resolve_node() is None or not ft._sidecar_ready():
        pytest.skip('Node sidecar not available')

    sketch = (
        'void setup() { pinMode(13, OUTPUT); Serial.begin(9600); }\n'
        'void loop() {\n'
        '  digitalWrite(13, HIGH); delay(500);\n'
        '  digitalWrite(13, LOW); delay(500);\n'
        '  Serial.println("blink");\n'
        '}\n'
    )
    build = asyncio.run(ft.firmware_compile(
        sketch, name='blink', board='uno', workspace=str(tmp_path)))
    assert build.get('ok') is True, build

    run = asyncio.run(ft.firmware_run(
        build['hexFile'], ms=1200, expect='blink', timeline='blink',
        workspace=str(tmp_path)))
    assert run.get('ok') is True, run
    # Serial captured with the blink text.
    assert 'blink' in run['serial']
    # Expectation evaluated true.
    assert run['assertionsOk'] is True
    assert run['expectChecks'][0]['found'] is True
    # Pin 13 toggled at the 500ms half-period cadence.
    t13 = run['toggles']['13']
    assert t13['count'] >= 3
    edges = [e['t'] for e in t13['edges']]
    assert any(400 < t < 600 for t in edges)
    # Final GPIO state is an output.
    assert run['pins']['13']['mode'] == 'out'
    # Timeline JSON persisted (P3.5 PWL seed).
    tl = Path(run['timelineFile'])
    assert tl.exists()
    assert '13' in tl.read_text(encoding='utf-8')


def test_golden_firmware_run_fail_assertion(tmp_path):
    """failText present in serial → assertionsOk False."""
    import asyncio

    from app.services.tools import firmware_tools as ft

    if ft._resolve_arduino_cli() is None:
        pytest.skip('arduino-cli not installed')
    if ft._resolve_node() is None or not ft._sidecar_ready():
        pytest.skip('Node sidecar not available')

    sketch = (
        'void setup() { Serial.begin(9600); }\n'
        'void loop() { Serial.println("hello world"); delay(100); }\n'
    )
    build = asyncio.run(ft.firmware_compile(
        sketch, name='hello', board='uno', workspace=str(tmp_path)))
    assert build.get('ok') is True, build
    run = asyncio.run(ft.firmware_run(
        build['hexFile'], ms=400, expect='hello', fail='goodbye',
        workspace=str(tmp_path)))
    assert run['ok'] is True
    assert 'hello' in run['serial']
    # fail-text missing from serial → still ok; but when present it flips.
    assert run['assertionsOk'] is True
    run_bad = asyncio.run(ft.firmware_run(
        build['hexFile'], ms=400, fail='hello', workspace=str(tmp_path)))
    assert run_bad['assertionsOk'] is False
    assert run_bad['failChecks'][0]['found'] is True


def test_golden_firmware_stimulus_pwl_into_rc_filter(tmp_path):
    """P3.5 rung 1 end-to-end: blink firmware → pin timeline → PWL deck →
    ngspice .tran RC filter — the filtered pin voltage must swing between
    the rails (a real low-pass, not a pass-through)."""
    import asyncio

    from app.services.tools import firmware_tools as ft

    if ft._resolve_arduino_cli() is None:
        pytest.skip('arduino-cli not installed')
    if ft._resolve_node() is None or not ft._sidecar_ready():
        pytest.skip('Node sidecar not available')
    if circuit_tools.resolve_ngspice() is None:
        pytest.skip('ngspice not installed')

    sketch = (
        'void setup() { pinMode(13, OUTPUT); Serial.begin(9600); }\n'
        'void loop() {\n'
        '  digitalWrite(13, HIGH); delay(100);\n'
        '  digitalWrite(13, LOW); delay(100);\n'
        '  Serial.println("blink");\n'
        '}\n'
    )
    build = asyncio.run(ft.firmware_compile(
        sketch, name='stimblink', board='uno', workspace=str(tmp_path)))
    assert build.get('ok') is True, build
    run = asyncio.run(ft.firmware_run(
        build['hexFile'], ms=1000, timeline='stimblink',
        workspace=str(tmp_path)))
    assert run['ok'] is True, run
    tl_file = run.get('timelineFile')
    assert tl_file, run

    # RC low-pass on the pin: τ = 1kΩ × 100nF = 100 µs ≪ 100 ms half-period,
    # so v(out) settles near the instantaneous pin level each half-cycle.
    deck = (
        '* firmware stimulus RC filter\n'
        'R1 N13 out 1k\n'
        'C1 out 0 100n\n'
        '.tran 0.5m 1\n'
        '.end\n'
    )
    stim = ft.firmware_stimulus(
        tl_file, netlist=deck, name='stimdeck', workspace=str(tmp_path))
    assert stim.get('ok') is True, stim
    assert '13' in stim['pins']
    saved = Path(str(stim['savedTo']))
    assert saved.is_file()
    text = saved.read_text(encoding='utf-8')
    assert 'Vp13 N13 0 PWL(' in text
    # PWL card injected BEFORE the analysis card.
    assert text.index('Vp13') < text.index('.tran')

    sim = asyncio.run(circuit_tools.simulate_circuit(
        str(saved), name='stimrc', workspace=str(tmp_path),
        traces=['v(out)', 'v(n13)']))
    assert sim.get('exitCode') == 0, sim.get('logTail', sim)
    traces = sim.get('traces') or {}
    out = traces.get('v(out)')
    assert out is not None, f'no v(out) trace: {list(traces)}'
    ys = out['y']
    # Filtered square wave: near 0 during LOW halves, near 5 during HIGH
    # halves; never parked at exactly one rail the whole window.
    assert max(ys) > 3.0, f'filter never reached HIGH level: max={max(ys)}'
    assert min(ys) < 2.0, f'filter never fell to LOW level: min={min(ys)}'
    n13 = traces.get('v(n13)')
    if n13 is not None:
        assert max(n13['y']) > 4.5


def test_golden_fpga_compile_and_gate(tmp_path):
    """P4.5 golden: real Quartus flow on an AND gate — parsed utilization
    (1 LE / 0 regs / 3 pins on EP4CE6E22C6), pin map honored, .sof
    artifact in the workspace."""
    import asyncio

    from app.services.tools import fpga_tools as ft

    if ft.resolve_quartus_sh() is None:
        pytest.skip('Quartus not installed')

    vhd = """library IEEE;
use IEEE.std_logic_1164.all;
entity andgate is
  port(A: in std_logic; B: in std_logic; Y: out std_logic);
end andgate;
architecture rtl of andgate is
begin
  Y <= A AND B;
end rtl;
"""
    r = asyncio.run(ft.fpga_compile(
        vhd, name='andgolden', top='andgate',
        pins={'A': 'PIN_23', 'B': 'PIN_25', 'Y': 'PIN_99'},
        workspace=str(tmp_path)))
    assert r.get('ok') is True, r.get('logTail', r)
    fit = r['fit']
    assert fit['status'].startswith('Successful')
    assert fit['logicElements'] == 1
    assert fit['registers'] == 0
    assert fit['pins'] == 3
    util = r['utilization']
    assert util['logicElementsPct'] < 1.0
    assert util['pinsPct'] == pytest.approx(3 * 100 / 92, abs=0.1)
    sof = Path(str(r['sofFile']))
    assert sof.is_file() and sof.name == 'andgolden.sof'
    assert sof.stat().st_size > 100_000  # real bitstream, not a stub
