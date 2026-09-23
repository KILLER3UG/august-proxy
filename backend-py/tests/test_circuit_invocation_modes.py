"""Invocation-mode parity — batch and server must report the same bench.

Two defects lived on the seam between ngspice's batch mode
(``ngspice_con -b -o out.txt``) and server mode (``-s``, control block fed on
stdin), and both made the golden numbers hinge on whether ngspice happened to
print its own "could not open a temporary file" line — the ONLY thing that
flips ``_NGSPICE_MODE_CACHE``:

1. Batch prints the operating point as a space-ALIGNED table
   (``mid   5.000000e+00``) with no ``=``, which _MEASURE_RE alone cannot
   read — a control-less deck reported zero measures in batch mode and full
   ones in server mode.
2. A trailing ``.control`` section makes batch mode drop its automatic run,
   so the trace sample hit an empty plot ("no such vector" / "incomplete or
   empty netlist") on control-less decks.

Pinned here: a captured batch log for the pure parser, the trace block's
shape, and forced-mode round trips through simulate_circuit. The captured log
and the forced modes are what keep this honest — neither test can pass by
picking the friendly ngspice mode.
"""

from __future__ import annotations

import asyncio

import pytest
from app.services.tools import circuit_tools

# Verbatim `ngspice_con -b -o out.txt` output for the golden divider,
# trimmed to the parts that matter: the two op sections, plus the device
# listings that use the same two-column shape but are NOT measures.
_BATCH_LOG = """
No. of Data Rows : 1
\tNode                                  Voltage
\t----                                  -------
\t----\t-------
\tmid                              5.000000e+00
\tin                               1.000000e+01

\tSource\tCurrent
\t------\t-------

\tv1#branch                        -5.00000e-03

 Resistor models (Simple linear resistor)
      model                     R

        rsh                     0
     narrow                     0

 Vsource: Independent voltage source
     device                    v1
         dc                    10
      acmag                     0
      freq                     0
"""

_DIVIDER = """* golden: voltage divider .op
V1 in 0 DC 10
R1 in mid 1k
R2 mid 0 1k
.op
.end
"""

_RC_STEP = """* RC step, control-less — batch must run it for the trace to have data
V1 in 0 PULSE(0 5 0 1n 1n 10m 20m)
R1 in out 1k
C1 out 0 1u
.tran 10u 12m
.end
"""


def test_op_table_reads_sections_but_not_device_parameters():
    """The pure parser runs without ngspice — it is a text concern.

    ``rsh``/``narrow``/``dc``/``acmag``/``freq`` sit in device listings that
    share the table's two-column shape; if the section scoping ever loosens
    they appear here as extra keys.
    """
    got = circuit_tools._op_table_measures(_BATCH_LOG)
    assert got == {'mid': 5.0, 'in': 10.0, 'v1#branch': -0.005}


def test_trace_block_runs_the_analysis_when_the_deck_does_not():
    """A control-less deck gets ``run`` with the wrdata lines, not after.

    Without it, batch mode skips the analysis entirely (a .control section
    puts the commands in charge) and every trace comes back empty.
    """
    out = circuit_tools._with_trace_block(
        '* x\nR1 a 0 1k\n.tran 1u 1m\n.end\n', ['wrdata tr0.dat v(a)'],
    )
    control = out[out.index('.control'):out.index('.endc')].splitlines()
    assert control[1].strip() == 'run', control
    assert control[2].strip() == 'wrdata tr0.dat v(a)', control
    # Exactly one run — a deck that already runs itself must not run twice.
    assert sum(1 for ln in out.splitlines() if ln.strip() == 'run') == 1


def test_trace_block_does_not_add_a_second_run():
    """The deck's own ``run`` already executed before our sample block."""
    deck = (
        '* x\nR1 a 0 1k\n.tran 1u 1m\n'
        '.control\nrun\nmeas tran v_max max v(a)\n.endc\n.end\n'
    )
    out = circuit_tools._with_trace_block(deck, ['wrdata tr0.dat v(a)'])
    assert sum(1 for ln in out.splitlines() if ln.strip() == 'run') == 1
    assert 'wrdata tr0.dat v(a)' in out


@pytest.mark.skipif(
    circuit_tools.resolve_ngspice() is None, reason='ngspice not installed',
)
def test_batch_and_server_report_identical_measures(monkeypatch):
    """Same deck, both invocation modes → the same measures dict.

    This is the contract `_alias_op_measures` advertises and the one that
    broke when ngspice stopped printing the temp-file error this machine
    used to see.
    """
    exe = circuit_tools.resolve_ngspice()
    assert exe is not None
    results: dict[str, dict[str, float]] = {}
    for mode in ('batch', 'server'):
        monkeypatch.setitem(circuit_tools._NGSPICE_MODE_CACHE, exe, mode)
        result = asyncio.run(circuit_tools.simulate_circuit(_DIVIDER, name='parity'))
        assert result.get('errors') == [], result.get('errors')
        results[mode] = result['measures']

    assert results['batch'] == results['server'], (
        f'batch={sorted(results["batch"])} server={sorted(results["server"])}'
    )
    assert results['batch']['v(mid)'] == pytest.approx(5.0, rel=1e-3)
    assert results['batch']['i(v1)'] == pytest.approx(-5e-3, rel=1e-3)


@pytest.mark.skipif(
    circuit_tools.resolve_ngspice() is None, reason='ngspice not installed',
)
def test_control_less_deck_yields_trace_data_in_batch_mode(
    monkeypatch, tmp_path,
):
    """Forced batch mode: the RC step must actually be sampled.

    This is the firmware-stimulus golden test's shape without needing
    arduino-cli — a control-less `.tran` deck plus traces.
    """
    exe = circuit_tools.resolve_ngspice()
    assert exe is not None
    monkeypatch.setitem(circuit_tools._NGSPICE_MODE_CACHE, exe, 'batch')
    result = asyncio.run(circuit_tools.simulate_circuit(
        _RC_STEP, name='trace_batch', workspace=str(tmp_path),
        traces=['v(out)'],
    ))
    traces = result.get('traces') or {}
    out = traces.get('v(out)')
    assert out is not None, (
        f'no v(out) trace in batch mode: {list(traces)} '
        f'errors={result.get("errors")} log={str(result.get("logTail"))[:400]}'
    )
    # τ = 1 ms ≪ the 10 ms half-period: the filter must reach the HIGH rail.
    assert max(out['y']) > 3.0, f'never reached HIGH: max={max(out["y"])}'
