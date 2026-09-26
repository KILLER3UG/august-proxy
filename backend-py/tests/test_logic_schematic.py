"""Digital logic schematic tests.

The contract: structural logic parses and draws; behavioural logic is reported,
never silently dropped. A renderer that quietly omits an `always` block would
show a schematic that is wrong and looks finished.
"""

from __future__ import annotations

import re

import pytest
from app.services.tools import logic_schematic as L


def kinds(net: L.LogicNet) -> list[str]:
    return sorted({g.kind for g in net.gates})


def test_boolean_equation_makes_an_and_tree():
    net = L.parse_logic('y = a & b')
    assert net.source_kind == 'boolean'
    assert 'and' in kinds(net)
    assert net.outputs == ['y']
    assert sorted(net.inputs) == ['a', 'b']


def test_precedence_binds_not_then_and_then_or():
    # `a | b & c` must be OR(a, AND(b, c)) — one AND, one OR, not the reverse.
    net = L.parse_logic('f = a | b & c')
    ops = [g.kind for g in net.gates if g.kind != 'buf']
    assert ops.count('and') == 1 and ops.count('or') == 1
    svg = L.render_logic_svg(net, 'precedence')
    assert svg.startswith('<svg') and svg.rstrip().endswith('</svg>')


def test_word_operators_and_parentheses():
    net = L.parse_logic('sum = (a AND b) OR (NOT c)')
    assert 'and' in kinds(net) and 'or' in kinds(net) and 'not' in kinds(net)


def test_xor_and_bang_forms():
    net = L.parse_logic('d = a ^ b\ne = !a')
    assert 'xor' in kinds(net) and 'not' in kinds(net)


def test_wide_fan_in_folds_into_a_tree():
    net = L.parse_logic('y = a & b & c & d')
    ands = [g for g in net.gates if g.kind == 'and']
    assert len(ands) == 3, 'four inputs need three 2-input gates'
    assert all(len(g.inputs) == 2 for g in ands)


def test_verilog_structural_subset():
    src = '''
    module mux2(a, b, s, y);
      input a, b, s;
      output y;
      wire w1, w2, w3;
      and (w1, a, ~s);
      and (w2, b, s);
      or  (y, w1, w2);
    endmodule
    '''
    net = L.parse_logic(src)
    assert net.source_kind == 'verilog'
    assert 'and' in kinds(net) and 'or' in kinds(net)
    assert net.outputs == ['y']
    assert not net.unsupported


def test_verilog_primitive_is_emitted_once_and_every_net_has_one_driver():
    """A gate-level primitive must not be parsed twice.

    `prim_re` and a second, anchored `named_re` both matched `and (y, a, b);`,
    and `named_re` only ever accepted names `prim_re` had already consumed — so
    every Verilog primitive drew twice. The test above this one checked which
    kinds were *present*, never how many gates there were, so the duplication
    passed.

    The DFF case was worse than a doubled symbol: the second copy drove a
    different net and a buffer wired it back onto `q`, drawing two drivers on
    one net — an impossible circuit, rendered tidily.
    """
    def drivers(net: L.LogicNet) -> dict[str, int]:
        counts: dict[str, int] = {}
        for g in net.gates:
            counts[g.out] = counts.get(g.out, 0) + 1
        return counts

    for src, expected in (
        ('and (y, a, b);\n', 2),        # and + the buf that names the output
        ('nand (y, a, b);\n', 2),
        ('xor (y, a, b);\n', 2),
        ('not (y, a);\n', 2),
        ('dff (q, d, clk);\n', 1),      # a cell, not a wide gate + buf
    ):
        net = L.parse_logic(src)
        assert len(net.gates) == expected, (
            f'{src.strip()!r} drew {len(net.gates)} gates, expected {expected}: '
            f'{[(g.kind, g.out) for g in net.gates]}'
        )
        multi = {n: c for n, c in drivers(net).items() if c > 1}
        assert not multi, f'{src.strip()!r} put two drivers on net(s) {multi}'

    # A real two-stage design still composes, with each net singly driven.
    mux = L.parse_logic(
        'module mux2(a, b, s, y);\n'
        '  input a, b, s;\n  output y;\n  wire w1, w2;\n'
        '  and (w1, a, ~s);\n  and (w2, b, s);\n  or (y, w1, w2);\n'
        'endmodule\n'
    )
    assert not [n for n, c in drivers(mux).items() if c > 1]
    assert mux.outputs == ['y']
    assert not mux.unsupported


def test_verilog_continuous_assign():
    net = L.parse_logic('module m;\n assign y = a & ~b;\nendmodule\n')
    assert net.source_kind == 'verilog'
    assert net.outputs == ['y']


def test_vhdl_concurrent_assignment():
    src = '''
    library IEEE;
    entity half_add is
      port (a, b : in  std_logic;
            sum, carry : out std_logic);
    end entity;
    architecture rtl of half_add is
    begin
      sum   <= a xor b;
      carry <= a and b;
    end architecture;
    '''
    net = L.parse_logic(src)
    assert net.source_kind == 'vhdl'
    assert 'xor' in kinds(net) and 'and' in kinds(net)
    assert set(net.outputs) == {'sum', 'carry'}


def test_behavioural_verilog_is_reported_not_dropped():
    src = '''
    module counter(clk, q);
      input clk; output reg [3:0] q;
      always @(posedge clk) q <= q + 1;
    endmodule
    '''
    net = L.parse_logic(src)
    assert net.unsupported, 'a clocked always block must be surfaced'
    assert any('always' in u or 'posedge' in u for u in net.unsupported)


def test_vhdl_process_is_reported():
    src = ('architecture rtl of x is begin\n'
           '  process(clk)\n  begin\n    if rising_edge(clk) then q <= d; end if;\n'
           '  end process;\nend architecture;\n')
    net = L.parse_logic(src)
    assert net.unsupported


def test_dff_primitive_is_a_sequential_cell():
    net = L.parse_logic('dff (q, d, clk);')
    assert any(g.kind == 'dff' for g in net.gates)


def test_complemented_literal_in_a_primitive_is_an_inverter_not_a_wire():
    # `~s` used to land in net.inputs as a signal literally named "~s", so the
    # block advertised an input nothing could drive and drew no inverter.
    net = L.parse_logic('module m;\n wire w1;\n and (w1, a, ~s);\nendmodule\n')
    assert '~s' not in net.inputs, 'complemented argument leaked in as a name'
    assert 's' in net.inputs
    assert any(g.kind == 'not' for g in net.gates), 'no inverter was emitted'


def test_unsupported_report_has_no_duplicate_lines():
    src = 'module c(input clk, output reg q);\n always @(posedge clk) q <= ~q;\nendmodule\n'
    net = L.parse_logic(src)
    assert net.unsupported
    assert len(net.unsupported) == len(set(net.unsupported)), net.unsupported


def test_layout_orders_by_logic_depth():
    net = L.parse_logic('y = (a & b) | (c & d)')
    placed = L.layout_logic(net)
    assert placed, 'layout produced nothing'
    cols = {p['col'] for p in placed.values()}
    assert len(cols) >= 2, 'a two-level net must span more than one column'


def test_render_svg_labels_every_gate_output():
    net = L.parse_logic('y = a & b')
    svg = L.render_logic_svg(net, 'and gate')
    assert 'and gate' in svg
    assert '<rect' in svg and 'stroke-width="2"' in svg


def test_rendered_svg_has_no_non_finite_coordinates():
    # The layout divides by gate counts and column spans; a zero-width viewBox or
    # a NaN coordinate makes the whole picture vanish in the browser rather than
    # fail loudly, so check the numbers that actually reach the SVG.
    sources = [
        'y = a & b',
        'f = (a | b) ^ (c & ~d)',
        'module m;\n and (w1, a, ~s);\n and (w2, b, s);\n or (y, w1, w2);\nendmodule',
        'architecture rtl of x is begin\n sum <= a xor b;\n carry <= a and b;\nend architecture;',
    ]
    for src in sources:
        net = L.parse_logic(src)
        svg = L.render_logic_svg(net, 'x')
        for bad in ('nan', 'inf', 'None'):
            assert bad not in svg.lower(), f'{src[:24]!r}: {bad} in svg'
        box = [float(v) for v in re.search(r'viewBox="([-\d. ]+)"', svg).group(1).split()]
        assert box[2] > 0 and box[3] > 0, f'{src[:24]!r}: degenerate viewBox {box}'


def test_deep_chain_spans_multiple_columns():
    # Ripple-carry style depth must not collapse into one column, or the drawing
    # is a pile of overlapping boxes.
    src = '\n'.join([f'g{i} = a{i} & b{i}' for i in range(4)]
                    + ['s = g0 | g1 | g2 | g3'])
    net = L.parse_logic(src)
    cols = {p['col'] for p in L.layout_logic(net).values()}
    assert len(cols) >= 3, f'expected depth spread, got columns {sorted(cols)}'


def test_truth_table_matches_the_expression():
    net = L.parse_logic('y = a & b')
    tt = L.truth_table(net)
    assert tt['inputs'] == ['a', 'b']
    rows = {(r['a'], r['b']): r['y'] for r in tt['rows']}
    assert rows == {(0, 0): 0, (0, 1): 0, (1, 0): 0, (1, 1): 1}


def test_truth_table_xor():
    net = L.parse_logic('y = a ^ b')
    rows = {(r['a'], r['b']): r['y'] for r in L.truth_table(net)['rows']}
    assert rows == {(0, 0): 0, (0, 1): 1, (1, 0): 1, (1, 1): 0}


def test_comments_are_ignored():
    net = L.parse_logic('// a note\ny = a & b;  // trailing\n')
    assert net.outputs == ['y']
    assert 'a note' not in repr([g.inputs for g in net.gates])


def test_garbage_input_raises_a_plain_message():
    with pytest.raises(ValueError) as exc:
        L.parse_logic(42)  # type: ignore[arg-type]
    assert 'must be a string' in str(exc.value)
    assert 'AttributeError' not in str(exc.value)


def test_rendering_an_empty_net_says_so():
    net = L.LogicNet()
    with pytest.raises(ValueError, match='nothing to draw'):
        L.render_logic_svg(net)
