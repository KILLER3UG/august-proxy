"""ModelSim driver for ``hdl_lint`` / ``hdl_simulate`` + GHDL resolver hardening.

The EDA environment report (2026-08-31) found ModelSim-Altera installed at
``C:\intelFPGA\18.1\modelsim_ase\`` but unused: ``hdl_tools`` drove GHDL
only, so a machine with ModelSim but no GHDL still showed "install GHDL"
guidance. The driver here keeps the environment-detected posture:
GHDL stays preferred; ModelSim (``vcom`` / ``vsim -c``) serves as the VHDL
fallback so VHDL lint/sim works on Intel-FPGA-kit machines zero-install.

Also covered: the winget GHDL package installs into the WinGet Packages
tree — none of the hard-coded roots — so ``resolve_ghdl`` gains the same
``AUGUST_GHDL`` env override ``resolve_quartus_sh`` already has, plus the
WinGet dir on its search path.
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest
from app.services.tools import hdl_tools as ht

VHDL_TB = '''library ieee;
use ieee.std_logic_1164.all;

entity tb_driven is
end entity;

architecture sim of tb_driven is
  signal x : std_logic := '0';
begin
  x <= not x after 10 ns;
  process
  begin
    wait for 40 ns;
    report "done" severity note;
    wait;
  end process;
end architecture;
'''


# ── resolve_modelsim ────────────────────────────────────────────────────────


def test_resolve_modelsim_returns_none_when_absent(monkeypatch, tmp_path):
    """A plain dir with no vsim/vcom resolves to None — absence is data."""

    async def _fake_probe(names, args, version_re, extra_dirs=(), timeout=10.0):
        return {'installed': False}

    monkeypatch.setattr(ht, '_probe_binary', _fake_probe)
    assert asyncio.run(ht.resolve_modelsim()) is None


def test_resolve_modelsim_probes_modelsim_ase_roots(monkeypatch, tmp_path):
    """The probe must search the intelFPGA versioned modelsim_ase trees —
    where ModelSim actually lives on Quartus-kit machines."""
    seen: dict[str, object] = {}

    async def _fake_probe(names, args, version_re, extra_dirs=(), timeout=10.0):
        seen['extra_dirs'] = extra_dirs
        return {'installed': False}

    monkeypatch.setattr(ht, '_probe_binary', _fake_probe)
    asyncio.run(ht.resolve_modelsim())
    dirs = seen['extra_dirs']
    assert any('modelsim_ase' in str(d) for d in dirs), (
        f'modelsim_ase roots missing from search: {dirs}')
    assert any('intelFPGA' in str(d) for d in dirs)


@pytest.mark.skipif(sys.platform != 'win32', reason='win32 versioned roots')
def test_resolve_modelsim_live_machine_probe():
    """On this dev machine (ModelSim 18.1 present) the resolver finds it —
    or cleanly returns None when the install is absent. Skipped on CI."""
    r = asyncio.run(ht.resolve_modelsim())
    if r is None:
        pytest.skip('ModelSim not installed')
    assert 'vsim' in r.lower() or 'vcom' in r.lower()


# ── hdl_lint / hdl_simulate ModelSim fallback ───────────────────────────────


def test_hdl_lint_falls_back_to_modelsim(monkeypatch):
    """GHDL absent + ModelSim present → lint runs vcom, NOT install guidance."""
    orig = (ht.resolve_ghdl, ht.resolve_modelsim)
    ran: list[list[str]] = []

    async def _none():
        return None

    async def _fake_run(argv, timeout, cwd=None):
        ran.append(argv)
        return (0, '')

    async def _modelsim():
        return r'C:\intelFPGA\18.1\modelsim_ase\win32aloem\vsim.exe'

    monkeypatch.setattr(ht, 'resolve_ghdl', _none)
    monkeypatch.setattr(ht, 'resolve_modelsim', _modelsim)
    monkeypatch.setattr(ht, '_run', _fake_run)
    try:
        r = asyncio.run(ht.hdl_lint(VHDL_TB))
        assert r['installed'] is True, r
        assert r['engine'] == 'modelsim', r
        assert ran, 'vcom never ran'
        assert any('vcom' in ' '.join(a) for a in ran), ran
    finally:
        monkeypass_restore(orig)


def test_hdl_lint_prefers_ghdl_over_modelsim(monkeypatch):
    """Both present → GHDL wins (the open-source default is unchanged)."""
    orig = (ht.resolve_ghdl, ht.resolve_modelsim)
    ran: list[list[str]] = []

    async def _ghdl():
        return r'C:\ghdl\bin\ghdl.exe'

    async def _modelsim():
        return r'C:\intelFPGA\18.1\modelsim_ase\win32aloem\vsim.exe'

    async def _fake_run(argv, timeout, cwd=None):
        ran.append(argv)
        return (0, '')

    monkeypatch.setattr(ht, 'resolve_ghdl', _ghdl)
    monkeypatch.setattr(ht, 'resolve_modelsim', _modelsim)
    monkeypatch.setattr(ht, '_run', _fake_run)
    try:
        r = asyncio.run(ht.hdl_lint(VHDL_TB))
        assert r['engine'] == 'ghdl', r
    finally:
        monkeypass_restore(orig)


def test_hdl_simulate_falls_back_to_modelsim(monkeypatch):
    """GHDL absent + ModelSim present → simulate runs vcom + vsim -c."""
    orig = (ht.resolve_ghdl, ht.resolve_modelsim)
    ran: list[list[str]] = []

    async def _none():
        return None

    async def _modelsim():
        return r'C:\intelFPGA\18.1\modelsim_ase\win32aloem\vsim.exe'

    async def _fake_run(argv, timeout, cwd=None):
        ran.append(argv)
        return (0, '')

    monkeypatch.setattr(ht, 'resolve_ghdl', _none)
    monkeypatch.setattr(ht, 'resolve_modelsim', _modelsim)
    monkeypatch.setattr(ht, '_run', _fake_run)
    try:
        r = asyncio.run(ht.hdl_simulate(VHDL_TB))
        assert r['installed'] is True, r
        assert r['engine'] == 'modelsim', r
        assert any('vsim' in ' '.join(a) for a in ran), ran
        assert any('-c' in a for a in ran), ran
    finally:
        monkeypass_restore(orig)


def test_hdl_lint_modelsim_dependency_missing_guidance(monkeypatch):
    """Both engines absent → guidance mentions BOTH install paths."""
    orig = (ht.resolve_ghdl, ht.resolve_modelsim)

    async def _none():
        return None

    monkeypatch.setattr(ht, 'resolve_ghdl', _none)
    monkeypatch.setattr(ht, 'resolve_modelsim', _none)
    try:
        r = asyncio.run(ht.hdl_lint(VHDL_TB))
        assert r['installed'] is False
        assert 'GHDL' in r['error']
        assert 'ModelSim' in r['error'], 'guidance should mention ModelSim'
    finally:
        monkeypass_restore(orig)


# ── resolve_ghdl env override + WinGet root ────────────────────────────────


def test_resolve_ghdl_honors_august_ghdl_env(monkeypatch, tmp_path):
    """AUGUST_GHDL pointing at a real exe short-circuits the search —
    same contract as AUGUST_QUARTUS_SH."""
    exe = tmp_path / 'ghdl.exe'
    exe.write_bytes(b'')

    async def _boom(*a, **k):
        raise AssertionError('env override must short-circuit _probe_binary')

    monkeypatch.setenv('AUGUST_GHDL', str(exe))
    monkeypatch.setattr(ht, '_probe_binary', _boom)
    got = asyncio.run(ht.resolve_ghdl())
    assert got == str(exe), got


def test_resolve_ghdl_searches_winget_root(monkeypatch, tmp_path):
    """The winget GHDL package lands in the WinGet Packages tree — the
    probe must search it (this machine's actual install location)."""
    seen: dict[str, object] = {}

    async def _fake_probe(names, args, version_re, extra_dirs=(), timeout=10.0):
        seen['extra_dirs'] = extra_dirs
        return {'installed': False}

    monkeypatch.delenv('AUGUST_GHDL', raising=False)
    monkeypatch.setattr(ht, '_probe_binary', _fake_probe)
    asyncio.run(ht.resolve_ghdl())
    dirs = seen['extra_dirs']
    assert any('WinGet' in str(d) for d in dirs), (
        f'WinGet Packages root missing from GHDL search: {dirs}')


def monkeypass_restore(orig):
    ht.resolve_ghdl, ht.resolve_modelsim = orig


# ── GHDL VCD timescale regression (found live 2026-08-31) ──────────────────


def test_vcd_summary_parses_ghdl_spaced_timescale():
    """GHDL writes ``$timescale 1 fs`` (number and unit separated by a
    space). The old single-token capture read just ``1`` and defaulted the
    unit to ns — durations 10^6x inflated. Found during live ModelSim/GHDL
    comparison (ModelSim 1ps reported 2e-8s, GHDL 1fs reported 0.02s)."""
    d = chr(10)
    gh = (
        '$timescale 1 fs $end' + d
        + '$enddefinitions $end' + d
        + '#1000' + d + '1!' + d + '#20000' + d + '0!' + d
    )
    r = ht.vcd_summary(gh)
    assert r['timescaleSec'] == pytest.approx(1e-15)
    assert r['durationSec'] == pytest.approx(2e-11)
    # Single-token ModelSim/Icarus form keeps working.
    ms = (
        '$timescale 1ps $end' + d
        + '$enddefinitions $end' + d
        + '#1000' + d + '1!' + d + '#20000' + d + '0!' + d
    )
    r2 = ht.vcd_summary(ms)
    assert r2['timescaleSec'] == pytest.approx(1e-12)
    assert r2['durationSec'] == pytest.approx(2e-08)
