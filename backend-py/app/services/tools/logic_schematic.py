"""Digital logic schematics: boolean algebra, gate-level Verilog and VHDL.

The analog workbench draws SPICE decks. This draws the digital one, and it does
so with our own renderer rather than by bundling a synthesiser: the honest scope
here is *structural* logic — equations, gate primitives and concurrent
assignments — which is what a schematic can faithfully represent. Behavioural
HDL (clocked ``always``/``process`` blocks, FSMs, arithmetic) needs real
synthesis to become a gate netlist, so it is reported in ``unsupported`` instead
of being quietly dropped and drawn as if it had been understood.
"""
from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field

# Two-input fan-in everywhere: it is what a symbol on paper shows, and wider
# gates are drawn as a tree of them.
GATE_KINDS = ('and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not', 'buf', 'dff')

_BODY = {'and': '&', 'or': '≥1', 'xor': '=1', 'nand': '&', 'nor': '≥1',
         'xnor': '=1', 'not': '1', 'buf': '1', 'dff': 'D'}

_MAX_ROWS = 32
_MAX_TRUTH_INPUTS = 8

_WORD_OPS = {
    'and': 'and', 'or': 'or', 'xor': 'xor', 'nand': 'nand', 'nor': 'nor',
    'xnor': 'xnor', 'not': 'not', 'buf': 'buf',
}


@dataclass
class Gate:
    out: str
    kind: str
    inputs: list[str]
    name: str = ''


@dataclass
class LogicNet:
    gates: list[Gate] = field(default_factory=list)
    inputs: list[str] = field(default_factory=list)
    outputs: list[str] = field(default_factory=list)
    unsupported: list[str] = field(default_factory=list)
    source_kind: str = 'boolean'


# ── Parsing ────────────────────────────────────────────────────────────────

def _strip_comments(text: str) -> str:
    text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)
    text = re.sub(r'//.*', '', text)
    return re.sub(r'--[^\n]*', '', text)


def _detect(text: str) -> str:
    low = text.lower()
    if re.search(r'\bmodule\b|\bendmodule\b', low):
        return 'verilog'
    if re.search(r'\bentity\b|\barchitecture\b|\bend\s+(if|;)', low):
        return 'vhdl'
    return 'boolean'


def _split_ops(expr: str) -> list[tuple[str, str]]:
    """Yield (operator, operand) pairs from a postfix-ish token stream."""
    tokens = re.findall(r'\(|\)|[&|^~!]+|<=|=>|:=|=|[A-Za-z_][A-Za-z0-9_$\[\]<>]*|[0-1]',
                        expr)
    return [('tok', t) for t in tokens]


class _ExprError(ValueError):
    pass


def _parse_expr(expr: str, net: LogicNet, hint: str) -> str:
    """Reduce a boolean expression to a single signal name, emitting gates.

    Recursive descent over OR -> XOR -> AND -> NOT -> atom, which is the usual
    precedence and matches what a reader expects from the drawn tree.
    """
    toks = _split_ops(expr)
    pos = 0

    def peek() -> str | None:
        return toks[pos][1] if pos < len(toks) else None

    def take(value: str | None = None) -> str:
        nonlocal pos
        tok = peek()
        if tok is None or (value is not None and tok != value):
            raise _ExprError(f'unexpected token in {hint!r}')
        pos += 1
        return tok

    def new_gate(kind: str, inputs: list[str]) -> str:
        out = f'{hint}#{len(net.gates)}'
        net.gates.append(Gate(out=out, kind=kind, inputs=inputs, name=hint))
        return out

    def atom() -> str:
        tok = peek()
        if tok is None:
            raise _ExprError(f'truncated expression in {hint!r}')
        if tok == '(':
            take('(')
            inner = or_expr()
            take(')')
            return inner
        if tok in ('~', '!'):
            take(tok)
            return new_gate('not', [atom()])
        if tok and (tok[0].isalpha() or tok[0] == '_' or tok in ('0', '1')):
            take()
            if peek() == '(' and tok.lower() in _WORD_OPS:
                take('(')
                args = [or_expr()]
                while peek() == ',':
                    take(',')
                    args.append(or_expr())
                take(')')
                return new_gate(_WORD_OPS[tok.lower()], args)
            return tok
        raise _ExprError(f'cannot parse {tok!r} in {hint!r}')

    def unary_not_and() -> str:
        tok = peek()
        if tok in ('~', '!'):
            take()
            return new_gate('not', [unary_not_and()])
        if tok and tok.lower() == 'not':
            take()
            return new_gate('not', [unary_not_and()])
        return atom()

    def is_infix(*forms: str) -> bool:
        tok = peek()
        return bool(tok) and (tok in forms or tok.lower() in forms)

    def and_expr() -> str:
        left = unary_not_and()
        while is_infix('&', '*', 'and'):
            take()
            left = new_gate('and', [left, unary_not_and()])
        return left

    def xor_expr() -> str:
        left = and_expr()
        while is_infix('^', 'xor'):
            take()
            left = new_gate('xor', [left, and_expr()])
        return left

    def or_expr() -> str:
        left = xor_expr()
        # VHDL spells the compound gates out as infix operators too.
        while True:
            tok = peek()
            if not tok:
                break
            lowered = tok.lower()
            if tok in ('|', '+') or lowered == 'or':
                take()
                left = new_gate('or', [left, xor_expr()])
            elif lowered in ('nand', 'nor', 'xnor'):
                take()
                left = new_gate(lowered, [left, xor_expr()])
            else:
                break
        return left

    result = or_expr()
    if pos != len(toks):
        raise _ExprError(f'trailing tokens in {hint!r}')
    return result


def _resolve_arg(arg: str, net: LogicNet, hint: str) -> str:
    """A gate-primitive argument may be a complemented literal (`~s`, `!s`,
    `not(s)`). Folding it into a real inverter keeps it out of the primary
    input list, where it would read as a signal the block never drives."""
    a = arg.strip()
    if a.startswith(('~', '!')):
        inner = _resolve_arg(a[1:], net, hint)
        out = f'n{len(net.gates)}.{inner}'
        net.gates.append(Gate(out=out, kind='not', inputs=[inner], name=hint))
        return out
    m = re.fullmatch(r'not\s*\(\s*([A-Za-z_]\w*)\s*\)', a, re.I)
    if m:
        out = f'n{len(net.gates)}.{m.group(1)}'
        net.gates.append(Gate(out=out, kind='not', inputs=[m.group(1)], name=hint))
        return out
    return a


def _add_wide(kind: str, args: list[str], hint: str, net: LogicNet) -> str:
    """Fold a >2-input gate into a balanced tree of 2-input gates."""
    if kind in ('not', 'buf', 'dff') or len(args) <= 2:
        net.gates.append(Gate(out=f'{hint}#{len(net.gates)}', kind=kind,
                              inputs=args, name=hint))
        return net.gates[-1].out
    acc = args[0]
    for arg in args[1:]:
        acc = _add_wide(kind, [acc, arg], hint, net)
    return acc


def _record_outputs(net: LogicNet, declared: list[str]) -> None:
    used = {i for g in net.gates for i in g.inputs}
    produced = {g.out for g in net.gates}
    if declared:
        # A structural netlist names its internal wires the same way as its
        # ports; only the ones nothing downstream reads are block outputs.
        net.outputs = [d for d in dict.fromkeys(declared) if d not in used]
    else:
        # Nothing was declared, so anything no other gate reads is an output.
        net.outputs = [s for s in dict.fromkeys(
            [g.out for g in net.gates] + [i for g in net.gates for i in g.inputs]
        ) if s not in used]
    seen_inputs: list[str] = []
    for g in net.gates:
        for i in g.inputs:
            if i not in produced and i not in seen_inputs and i not in net.outputs:
                seen_inputs.append(i)
    net.inputs = seen_inputs


def parse_logic(source: str) -> LogicNet:
    """Parse boolean equations, gate-level Verilog or concurrent VHDL."""
    if not isinstance(source, str):
        raise ValueError('source must be a string (boolean equations, or gate-level Verilog/VHDL)')
    text = _strip_comments(source)
    net = LogicNet(source_kind=_detect(text))

    declared_out: list[str] = []
    assign_re = re.compile(
        r'\bassign\s+([A-Za-z_]\w*)\s*=\s*([^;]+);'          # verilog continuous
        r'|\b([A-Za-z_]\w*)\s*<=\s*([^;]+);'                  # vhdl concurrent
        r'|^\s*([A-Za-z_]\w*)\s*[:=]=?\s*(.+?)\s*$',          # y = a & b
        re.M | re.I,
    )
    prim_re = re.compile(
        r'\b(and|or|nand|nor|xor|xnor|not|buf|dff)\s*\(([^)]*)\)', re.I)
    named_re = re.compile(
        r'^\s*([A-Za-z_]\w*)\s+\(([^)]*)\)\s*;\s*$', re.M | re.I)

    behavioural = re.compile(
        r'\balways\b|\bprocess\b|\bbegin\b\s*$|\bif\b|\bcase\b|\bfor\b|\bwhile\b'
        r'|\bposedge\b|\bnegedge\b', re.I)

    body = re.sub(r'\binput\b|\boutput\b|\binout\b|\bwire\b|\breg\b\s*(?=[;,)\s])',
                  ' ', text)
    body = re.sub(r'\breg\b|\blogic\b|\bbit\b|\bstd_logic\b', ' ', body)

    matched_any = False
    for m in behavioural.finditer(body):
        line = body[:m.start()].count('\n')
        frag = body.splitlines()[line].strip() if line < len(body.splitlines()) else m.group(0)
        net.unsupported.append(frag[:80] or m.group(0))
    if net.unsupported:
        # Drop the behavioural lines from the assignment scan so a half-parsed
        # process never masquerades as an equation.
        body = '\n'.join(ln for ln in body.splitlines()
                         if not behavioural.search(ln))

    for m in assign_re.finditer(body):
        target = m.group(1) or m.group(3) or m.group(5)
        expr = m.group(2) or m.group(4) or m.group(6)
        if not target or not expr:
            continue
        matched_any = True
        try:
            driven = _parse_expr(expr.strip(), net, target)
        except _ExprError as exc:
            net.unsupported.append(f'{target} = {expr.strip()}  ({exc})')
            continue
        net.gates.append(Gate(out=target, kind='buf', inputs=[driven], name=target))
        declared_out.append(target)

    for m in prim_re.finditer(body):
        kind = m.group(1).lower()
        args = [a.strip() for a in m.group(2).split(',') if a.strip()]
        if kind == 'dff':
            if len(args) < 2:
                net.unsupported.append(m.group(0))
                continue
            matched_any = True
            net.gates.append(Gate(out=args[0], kind='dff',
                                  inputs=[_resolve_arg(a, net, args[0]) for a in args[1:]],
                                  name=args[0]))
            declared_out.append(args[0])
            continue
        if len(args) < 2:
            net.unsupported.append(m.group(0))
            continue
        matched_any = True
        out = _add_wide(kind, [_resolve_arg(a, net, args[0]) for a in args[1:]],
                        args[0], net)
        net.gates.append(Gate(out=args[0], kind='buf', inputs=[out], name=args[0]))
        declared_out.append(args[0])

    for m in named_re.finditer(body):
        inst, args_raw = m.group(1), m.group(2)
        args = [a.strip() for a in args_raw.split(',') if a.strip()]
        kind = inst.lower()
        if kind not in GATE_KINDS or len(args) < 2:
            continue
        matched_any = True
        out = _add_wide(kind, [_resolve_arg(a, net, args[0]) for a in args[1:]],
                        args[0], net)
        net.gates.append(Gate(out=args[0], kind='buf', inputs=[out], name=args[0]))
        declared_out.append(args[0])

    if not matched_any and text.strip():
        net.unsupported.append('no structural assignments recognised')
    # The behavioural scan and the assignment scan can both flag one line, and
    # a repeated list reads as though there were several distinct problems.
    net.unsupported = list(dict.fromkeys(u.strip().rstrip(';') for u in net.unsupported))
    _record_outputs(net, declared_out)
    return net


# ── Layout ─────────────────────────────────────────────────────────────────

CELL = 20.0
GATE_W, GATE_H = 60.0, 44.0
COL_STEP = 5.0     # cells between signal depths
ROW_STEP = 3.2     # cells between siblings in a column


def layout_logic(net: LogicNet) -> dict[str, dict[str, float]]:
    """Assign each gate a column by logic depth and a row within that column."""
    depth: dict[str, int] = {}
    for name in net.inputs:
        depth[name] = 0
    # Iterate to a fixed point: equations may be written in any order.
    for _ in range(len(net.gates) + 2):
        changed = False
        for g in net.gates:
            if not g.inputs:
                continue
            known = [depth.get(i) for i in g.inputs]
            if any(k is None for k in known):
                continue
            want = max(k for k in known if k is not None) + 1
            if depth.get(g.out, -1) < want:
                depth[g.out] = want
                changed = True
        if not changed:
            break
    for g in net.gates:
        depth.setdefault(g.out, 1)

    by_col: dict[int, list[Gate]] = {}
    for g in net.gates:
        by_col.setdefault(depth[g.out], []).append(g)
    placed: dict[str, dict[str, float]] = {}
    for col, gates in sorted(by_col.items()):
        for slot, g in enumerate(gates):
            placed[f'{g.kind}:{g.out}'] = {
                'col': col * COL_STEP,
                'row': (slot - (len(gates) - 1) / 2.0) * ROW_STEP,
            }
    return placed


# ── Rendering ──────────────────────────────────────────────────────────────

def _esc(t: str) -> str:
    return (t.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def render_logic_svg(net: LogicNet, title: str = 'Logic') -> str:
    """Draw the gate tree: inputs at the left, outputs at the right."""
    if not net.gates:
        detail = f' Not understood: {"; ".join(net.unsupported[:3])}' if net.unsupported else ''
        raise ValueError(
            'nothing to draw: the source produced no structural logic.' + detail
        )
    placed = layout_logic(net)
    pts: list[tuple[float, float]] = []

    def centre(key: str) -> tuple[float, float, float, float]:
        p = placed[key]
        cx, cy = p['col'] * CELL, p['row'] * CELL
        return cx, cy, cx + GATE_W / 2, cy + GATE_H / 2

    bodies: list[str] = []
    for g in net.gates:
        key = f'{g.kind}:{g.out}'
        if key not in placed:
            continue
        x0, y0, cx, cy = centre(key)
        pts += [(x0, y0), (cx, y0), (x0, cy), (cx, cy)]
        inverted = g.kind in ('nand', 'nor', 'xnor', 'not')
        label = _BODY.get(g.kind, g.kind)
        body = (f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{GATE_W:.0f}" height="{GATE_H:.0f}" '
                f'rx="6" fill="#ffffff" stroke="#334155" stroke-width="2"/>'
                f'<text x="{cx:.0f}" y="{cy + 4:.0f}" text-anchor="middle" font-size="13" '
                f'font-weight="600" fill="#334155">{_esc(label)}</text>')
        if inverted and g.kind != 'not':
            body += (f'<circle cx="{cx + GATE_W / 2 + 4:.0f}" cy="{cy:.0f}" r="4" '
                     f'fill="#ffffff" stroke="#334155" stroke-width="2"/>')
        if g.kind == 'not':
            body = (f'<path d="M {x0:.0f} {y0:.0f} L {x0 + GATE_W:.0f} {cy:.0f} '
                    f'L {x0:.0f} {y0 + GATE_H:.0f} Z" fill="#ffffff" stroke="#334155" '
                    f'stroke-width="2"/>'
                    f'<circle cx="{x0 + GATE_W + 4:.0f}" cy="{cy:.0f}" r="4" '
                    f'fill="#ffffff" stroke="#334155" stroke-width="2"/>')
        bodies.append(body)
        bodies.append(f'<text x="{cx:.0f}" y="{y0 - 6:.0f}" text-anchor="middle" '
                      f'font-size="10" fill="#0f172a">{_esc(g.out)}</text>')
        for i, sig in enumerate(g.inputs):
            iy = y0 + (i + 1) * GATE_H / (len(g.inputs) + 1)
            bodies.append(f'<line x1="{x0 - 10:.0f}" y1="{iy:.0f}" x2="{x0:.0f}" '
                          f'y2="{iy:.0f}" stroke="#475569" stroke-width="1.5"/>')
            driver = next((k for k in placed if k.endswith(f':{sig}')), None)
            if driver:
                _, _, scx, scy = centre(driver)
                bodies.append(f'<path d="M {scx + GATE_W / 2:.0f} {scy:.0f} '
                              f'L {scx + GATE_W / 2 + 14:.0f} {scy:.0f} '
                              f'L {scx + GATE_W / 2 + 14:.0f} {iy:.0f} '
                              f'L {x0 - 10:.0f} {iy:.0f}" fill="none" '
                              f'stroke="#475569" stroke-width="1.5"/>')
            else:
                bodies.append(f'<text x="{x0 - 14:.0f}" y="{iy + 4:.0f}" '
                              f'text-anchor="end" font-size="10" fill="#0f172a">'
                              f'{_esc(sig)}</text>')

    xs = [p[0] for p in pts] or [0, 200]
    ys = [p[1] for p in pts] or [0, 120]
    pad = 46
    minx, maxx = min(xs) - pad, max(xs) + pad + 60
    miny, maxy = min(ys) - pad - 26, max(ys) + pad
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="{minx:.0f} {miny:.0f} {maxx - minx:.0f} {maxy - miny:.0f}" '
            f'font-family="Segoe UI, system-ui, sans-serif">'
            f'<rect x="{minx:.0f}" y="{miny:.0f}" width="{maxx - minx:.0f}" '
            f'height="{maxy - miny:.0f}" fill="#fdfdfb"/>'
            f'<text x="{minx + 8:.0f}" y="{miny + 20:.0f}" font-size="14" '
            f'font-weight="600" fill="#0f172a">{_esc(title)}</text>')
    return '\n'.join([head, *bodies, '</svg>'])


def truth_table(net: LogicNet, max_inputs: int = _MAX_TRUTH_INPUTS) -> dict[str, object]:
    """Evaluate the net over its primary inputs."""
    produced = {g.out for g in net.gates}
    all_inputs = [s for s in net.inputs if s not in produced]
    cols = all_inputs[:max_inputs]
    rows: list[dict[str, object]] = []

    def evaluate(assign: dict[str, int]) -> dict[str, int]:
        env = dict(assign)
        for _ in range(len(net.gates) + 2):
            progressed = False
            for g in net.gates:
                if g.out in env or any(i not in env for i in g.inputs):
                    continue
                vals = [env[i] for i in g.inputs]
                if g.kind == 'and':
                    env[g.out] = int(vals[0] and vals[1])
                elif g.kind == 'or':
                    env[g.out] = int(vals[0] or vals[1])
                elif g.kind == 'xor':
                    env[g.out] = int(vals[0] ^ vals[1])
                elif g.kind == 'nand':
                    env[g.out] = int(not (vals[0] and vals[1]))
                elif g.kind == 'nor':
                    env[g.out] = int(not (vals[0] or vals[1]))
                elif g.kind == 'xnor':
                    env[g.out] = int(vals[0] == vals[1])
                elif g.kind == 'not':
                    env[g.out] = int(not vals[0])
                elif g.kind == 'dff':
                    env[g.out] = vals[0] if vals else 0
                else:
                    env[g.out] = vals[0]
                progressed = True
            if not progressed:
                break
        return env

    for bits in itertools.islice(itertools.product((0, 1), repeat=len(cols)), 2 ** max_inputs):
        env = evaluate(dict(zip(cols, bits)))
        row: dict[str, object] = dict(zip(cols, bits))
        for o in net.outputs:
            row[o] = env.get(o, 'x')
        rows.append(row)
    return {'inputs': cols, 'outputs': net.outputs, 'rows': rows,
            'truncated': len(all_inputs) > max_inputs or len(rows) > _MAX_ROWS,
            'rowCap': _MAX_ROWS}
