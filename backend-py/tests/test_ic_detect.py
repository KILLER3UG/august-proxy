"""IC/topology identification — every pattern needs a positive AND a near-miss.

A matcher with only positives proves nothing: it could be string-matching the
deck, or matching "any resistor to ground", and still pass. Each topology in
``app/services/tools/ic_detect.py`` therefore gets

* a deck that MUST match it (exact pattern id), and
* a deck that differs in exactly one structural way and MUST NOT match it.

The deck pairs are written to be read as real netlists — arbitrary node names,
arbitrary ref numbers, terminals written in either order — because that is the
claim being tested.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from app.services.tools import ic_detect

# ── Helpers ────────────────────────────────────────────────────────────────

def _ids(result: dict[str, Any]) -> set[str]:
    return {p['patternId'] for p in result['patterns']}


def _matches(result: dict[str, Any], pattern_id: str) -> list[dict[str, Any]]:
    return [p for p in result['patterns'] if p['patternId'] == pattern_id]


def _deck(body: str) -> str:
    """A parseable deck: title comment + body + .end (SPICE wants both)."""
    return f'* test deck\n{body.rstrip()}\n.end\n'


# ── The library itself ─────────────────────────────────────────────────────

def test_library_is_structurally_sound():
    """Every pattern is well-formed: declared roles, connected bonds, evidence."""
    assert ic_detect.validate_library() == []


def test_library_covers_the_expected_topologies():
    ids = set(ic_detect.pattern_ids())
    expected = {
        'rc_low_pass', 'rc_high_pass', 'rc_snubber', 'capacitive_dropper',
        'voltage_divider', 'current_sense_shunt', 'led_indicator',
        'diode_series_limiter', 'totem_pole_pair', 'complementary_follower_pair',
        'common_emitter', 'common_collector', 'differential_pair',
        'current_mirror', 'lc_pi_filter', 'lc_t_filter', 'rc_feedback_loop',
        'debounce_rc', 'switch_pull_up', 'switch_pull_down',
        'amplifier_subckt', 'amplifier_feedback_stage',
    }
    missing = expected - ids
    assert not missing, f'patterns dropped from the library: {sorted(missing)}'


def test_every_pattern_declares_its_confidence_and_candidates():
    for info in ic_detect.describe_library():
        assert 0.0 < info['confidence'] <= 1.0, info['id']
        assert info['candidates'], f'{info["id"]} offers no part numbers'
        assert info['limits'], f'{info["id"]} hides nothing, so it must say what it ' \
                               f'cannot prove'
        assert info['purpose'] and info['name']


def test_ground_is_net_zero_like_the_rest_of_the_workbench():
    """``build_graph`` treats only ``0`` as ground; so does this module."""
    assert ic_detect.GROUND == '0'


# ── Pattern table: positive must match, near-miss must not ─────────────────

CASES: list[tuple[str, str, str]] = [
    # series R, shunt C to ground  vs  the cap not reaching ground
    (
        'rc_low_pass',
        'Vin in 0 DC 5\nR1 in out 1k\nC1 out 0 100n',
        'Vin in 0 DC 5\nR1 in out 1k\nC1 out mid 100n\nR2 mid 0 2k',
    ),
    # series C, shunt R to ground  vs  the resistor returning to a rail instead
    (
        'rc_high_pass',
        'Vin in 0 DC 5\nC1 in out 100n\nR1 out 0 10k',
        'Vin in 0 DC 5\nC1 in out 100n\nR1 out vdd 10k\nR2 vdd 0 1k',
    ),
    # series R-C branch with BOTH ends off ground  vs  the same pair to ground
    (
        'rc_snubber',
        'V1 rail 0 24\nS1 rail node_x sw\nR1 node_x mid 100\nC1 mid rail2 100n',
        'V1 rail 0 24\nR1 node_x mid 100\nC1 mid 0 100n',
    ),
    # dropper = series C + shunt R + an AC source card  vs  the same leg on DC
    (
        'capacitive_dropper',
        'V1 line 0 SIN(0 230 50)\nC1 line drop 470n\nR1 drop 0 100k',
        'V1 line 0 DC 230\nC1 line drop 470n\nR1 drop 0 100k',
    ),
    # two resistors in series to ground  vs  the pair floating / both grounded
    (
        'voltage_divider',
        'R1 vin tap 10k\nR2 tap 0 2k2',
        'R1 vin tap 10k\nR2 tap vref 2k2',
    ),
    # sub-ohm resistor to ground sitting in a current path  vs  a pull-down
    (
        'current_sense_shunt',
        'V1 vs 0 5\nRload vs out 1k\nRsh out 0 0.1\nRt out tap 10k',
        'V1 vs 0 5\nRload vs out 1k\nRpd out 0 10k\nRt out tap 100k',
    ),
    # LED-shaped model name behind a series resistor  vs  a signal diode
    (
        'led_indicator',
        'V1 drive 0 5\nR1 drive anode_k 330\nD1 anode_k 0 LED_RED',
        'V1 drive 0 5\nR1 drive anode_k 330\nD1 anode_k 0 1N4148',
    ),
    # a diode behind a resistor (identity unknown)  vs  the diode reversed
    (
        'diode_series_limiter',
        'V1 drive 0 5\nR1 drive kat 330\nD1 kat 0 1N4148',
        'V1 drive 0 5\nR1 drive kat 330\nD1 0 kat 1N4148',
    ),
    # common-emitter: emitter grounded + a collector resistor  vs  the emitter
    # lifted onto a resistor (which is a follower, not a CE stage)
    (
        'common_emitter',
        'V1 vcc 0 9\nRc vcc col 2k2\nQ1 col in 0 2N3904\nRb drive in 10k',
        'V1 vcc 0 9\nRc vcc col 2k2\nQ1 col in emit 2N3904\nRe emit 0 470\n'
        'Rb drive in 10k',
    ),
    # emitter follower: collector on a rail, emitter resistor to ground
    (
        'common_collector',
        'V1 vcc 0 9\nQ1 vcc in out 2N3904\nRe out 0 470',
        'V1 vcc 0 9\nQ1 vcc in out 2N3904',
    ),
    # long-tailed pair  vs  two transistors with emitters straight on ground
    (
        'differential_pair',
        'V1 vcc 0 9\nQ1 n1 in1 ee 2N3904\nQ2 n2 in2 ee 2N3904\nRee ee 0 4k7',
        'V1 vcc 0 9\nQ1 n1 in1 0 2N3904\nQ2 n2 in2 0 2N3904\nRc1 vcc n1 2k\n'
        'Rc2 vcc n2 2k',
    ),
    # current mirror (one diode-connected, shared base)  vs  shared base only
    (
        'current_mirror',
        'V1 in 0 5\nRbias in mirr 10k\nQ1 mirr mirr 0 2N3904\nQ2 out mirr 0 2N3904',
        'V1 in 0 5\nRbias in base 10k\nQ1 mirr base 0 2N3904\nQ2 out base 0 2N3904',
    ),
    # totem pole: hi.emitter == lo.collector, common base, low device grounded
    (
        'totem_pole_pair',
        'V1 vcc 0 5\nQ1 vcc in mid 2N3904\nQ2 mid in 0 2N3906',
        'V1 vcc 0 5\nQ1 vcc in1 mid 2N3904\nQ2 mid in2 0 2N3906',
    ),
    # complementary follower pair: crossed rails and output, nothing grounded
    (
        'complementary_follower_pair',
        'V1 vcc 0 9\nQ1 vcc in out 2N3904\nQ2 out in vcc 2N3906',
        'V1 vcc 0 9\nQ1 vcc in out 2N3904\nQ2 out in 0 2N3906',
    ),
    # pi (CLC)  vs  the second cap left off ground
    (
        'lc_pi_filter',
        'V1 in 0 1\nC1 in 0 100n\nL1 in out 10u\nC2 out 0 100n',
        'V1 in 0 1\nC1 in 0 100n\nL1 in out 10u\nC2 out mid 100n',
    ),
    # T (LCL)  vs  the middle element being a series cap
    (
        'lc_t_filter',
        'V1 in 0 1\nL1 in mid 10u\nC1 mid 0 100n\nL2 mid out 10u',
        'V1 in 0 1\nL1 in mid 10u\nC1 mid out 100n\nL2 out far 10u',
    ),
    # L in parallel with C across exactly two nets  vs  L then C to ground
    (
        'lc_parallel_tank',
        'V1 a 0 1\nL1 a b 10u\nC1 a b 100n',
        'V1 a 0 1\nL1 a b 10u\nC1 b 0 100n',
    ),
    # reactive loop through an active device  vs  the same resistor with no
    # capacitor closing back to the third terminal
    (
        'rc_feedback_loop',
        'V1 vcc 0 9\nM1 d g 0 bs170\nR1 d g 100k\nC1 g 0 1n',
        'V1 vcc 0 9\nM1 d g 0 bs170\nR1 d g 100k\nC1 g x 1n',
    ),
    # debounce RC: R + shunt C + a contact on the same net  vs  no contact
    (
        'debounce_rc',
        'V1 vcc 0 3.3\nR1 vcc mcu 100k\nC1 mcu 0 100n\nS1 mcu 0 button',
        'V1 vcc 0 3.3\nR1 vcc mcu 100k\nC1 mcu 0 100n\nR2 mcu vcc 1M',
    ),
    # pull-up: resistor to a rail + contact to ground  vs  contact to a rail
    (
        'switch_pull_up',
        'V1 vcc 0 5\nR1 vcc btn 10k\nS1 btn 0 pb',
        'V1 vcc 0 5\nR1 vcc btn 10k\nS1 btn other pb',
    ),
    # pull-down: resistor to ground + contact to the rail  vs  resistor floating
    (
        'switch_pull_down',
        'V1 vcc 0 5\nS1 btn vcc pb\nR1 btn 0 10k',
        'V1 vcc 0 5\nS1 btn vcc pb\nR1 btn other 10k',
    ),
    # amplifier instance named after a real part  vs  a non-amplifier name
    (
        'amplifier_subckt',
        'Vin in 0 DC 0.1\nX1 in out UA741',
        'Vin in 0 DC 0.1\nX1 in out 555timer',
    ),
    # amplifier + an element bridging its two visible pins  vs  no bridge
    (
        'amplifier_feedback_stage',
        'Vin in 0 DC 0.1\nR1 in ninv 10k\nX1 ninv out AMP\nR2 out ninv 100k',
        'Vin in 0 DC 0.1\nR1 in ninv 10k\nX1 ninv out AMP\nR2 out 0 10k',
    ),
]


@pytest.mark.parametrize('pattern_id, positive, negative', CASES,
                         ids=[c[0] for c in CASES])
def test_positive_deck_matches_and_near_miss_does_not(pattern_id: str, positive: str,
                                                     negative: str) -> None:
    hit = ic_detect.detect_ic_patterns(_deck(positive))
    assert pattern_id in _ids(hit), (
        f'{pattern_id} did not match its positive deck: {sorted(_ids(hit))}'
    )
    miss = ic_detect.detect_ic_patterns(_deck(negative))
    assert pattern_id not in _ids(miss), (
        f'{pattern_id} matched its near-miss deck — the pattern is too loose'
    )


@pytest.mark.parametrize('pattern_id, positive, _neg', CASES, ids=[c[0] for c in CASES])
def test_positive_deck_has_no_library_errors(pattern_id: str, positive: str,
                                            _neg: str) -> None:
    result = ic_detect.detect_ic_patterns(_deck(positive))
    assert result['library']['errors'] == []
    assert result['componentCount'] > 0, f'{pattern_id} positive parsed to nothing'


# ── Structural honesty: the rules that stop over-matching ─────────────────

def test_two_independent_pull_downs_are_not_a_divider():
    """Both resistors share ONE net — the class-collapse rule must reject it."""
    result = ic_detect.detect_ic_patterns(
        _deck('V1 x 0 5\nR1 x 0 10k\nR2 x 0 1k'))
    assert 'voltage_divider' not in _ids(result)


def test_a_shunt_is_not_a_divider_just_because_it_reaches_ground():
    """A lone resistor to ground with nothing in series is not a divider."""
    result = ic_detect.detect_ic_patterns(_deck('V1 a 0 5\nR1 a 0 10k'))
    assert 'voltage_divider' not in _ids(result)


def test_pattern_needs_both_bonds_not_just_two_parts_of_the_right_kind():
    """An unrelated resistor and capacitor on separate nets form no filter."""
    result = ic_detect.detect_ic_patterns(
        _deck('V1 a 0 5\nV2 b 0 5\nR1 a c 1k\nC1 b d 100n'))
    assert 'rc_low_pass' not in _ids(result)
    assert 'rc_high_pass' not in _ids(result)


def test_degenerate_same_net_terminals_do_not_match():
    """A capacitor with both pins on one net is a shorted part, not a filter."""
    result = ic_detect.detect_ic_patterns(
        _deck('V1 in 0 5\nR1 in x 1k\nC1 x x 100n'))
    assert 'rc_low_pass' not in _ids(result)


def test_symmetric_parts_are_recognised_whichever_way_round_they_are_written():
    left = ic_detect.detect_ic_patterns(_deck('R1 in out 1k\nC1 out 0 100n'))
    flipped = ic_detect.detect_ic_patterns(_deck('R1 out in 1k\nC1 0 out 100n'))
    assert _ids(left) == _ids(flipped)
    assert 'rc_low_pass' in _ids(left)


def test_led_reading_suppresses_the_weaker_diode_reading():
    result = ic_detect.detect_ic_patterns(
        _deck('V1 d 0 5\nR1 d k 330\nD1 k 0 LED_RED'))
    ids = _ids(result)
    assert 'led_indicator' in ids
    assert 'diode_series_limiter' not in ids, (
        'the unproven reading should be dropped when the lamp reading covers it')


def test_feedback_stage_suppresses_the_bare_amplifier_reading():
    result = ic_detect.detect_ic_patterns(
        _deck('Vin in 0 DC 0.1\nR1 in ninv 10k\nX1 ninv out AMP\nR2 out ninv 100k'))
    assert 'amplifier_feedback_stage' in _ids(result)
    assert 'amplifier_subckt' not in _ids(result)


def test_name_based_amplifier_upgrade_when_the_deck_names_a_real_part():
    stated = ic_detect.detect_ic_patterns(_deck('Vin in 0 DC 0.1\nX1 in out TL072'))
    generic = ic_detect.detect_ic_patterns(_deck('Vin in 0 DC 0.1\nX1 in out opamp'))
    s = _matches(stated, 'amplifier_subckt')[0]
    g = _matches(generic, 'amplifier_subckt')[0]
    # The deck LITERALLY names the chip: that is a fact, not a guess.
    assert s['estimated'] is False
    assert s['assertive'] is True
    assert s['candidates'][0]['part'] == 'TL072'
    assert s['candidates'][0]['estimated'] is False
    # A generic word is a guess about a class, and must not read as certain.
    assert g['estimated'] is True
    assert g['assertive'] is False
    assert g['confidence'] < ic_detect.MIN_DEFINITE_CONFIDENCE


def test_shape_proven_flag_separates_graph_facts_from_name_reads():
    by_id = {t['id']: t for t in ic_detect.describe_library()}
    assert by_id['amplifier_subckt']['source'] == 'name'
    assert by_id['voltage_divider']['source'] == 'topology'
    name_only = ic_detect.detect_ic_patterns(_deck('X1 a b opamp'))
    assert _matches(name_only, 'amplifier_subckt')[0]['shapeProven'] is False


# ── Robustness: node names / ref numbers / case are noise ─────────────────

_RENAMED_PAIRS = [
    (
        'R1 in out 1k\nC1 out 0 100n',
        'R447 SIG7 FILTER_NODE 4k7\nC902 FILTER_NODE 0 22n',
    ),
    (
        'V1 vcc 0 9\nQ1 vcc in mid 2N3904\nQ2 mid in 0 2N3906',
        'V22 RAIL9 0 9\nQ7 RAIL9 DRIVE MIDPOINT 2N3904\nQ8 MIDPOINT DRIVE 0 2N3906',
    ),
    (
        'Vin in 0 DC 0.1\nR1 in ninv 10k\nX1 ninv out AMP\nR2 out ninv 100k',
        'Vs SIG 0 DC 0.1\nRin SIG SUM 10k\nX7 SUM OUTPUT AMP\nRf OUTPUT SUM 100k',
    ),
]


@pytest.mark.parametrize('base, renamed', _RENAMED_PAIRS,
                         ids=[f'pair{i}' for i in range(len(_RENAMED_PAIRS))])
def test_renaming_nodes_and_refs_does_not_change_the_result(base: str, renamed: str):
    """The matcher sees nets and kinds, never a name from the deck.

    Ground (net ``0``) and the device-class letter (R/C/Q/X…) are not "names":
    they carry meaning for every SPICE tool, so they stay put here and the rest
    is arbitrary.
    """
    plain = ic_detect.detect_ic_patterns(_deck(base))
    shuffled = ic_detect.detect_ic_patterns(_deck(renamed))
    assert _ids(plain) == _ids(shuffled), (
        f'renaming changed the answer:\n {sorted(_ids(plain))}\n {sorted(_ids(shuffled))}')
    # Same number of matches too — not just the same set of pattern ids.
    assert len(plain['patterns']) == len(shuffled['patterns'])


def test_case_differences_do_not_change_the_result():
    lower = ic_detect.detect_ic_patterns(_deck('r1 in out 1k\nc1 out 0 100n'))
    upper = ic_detect.detect_ic_patterns(_deck('R1 IN OUT 1k\nC1 OUT 0 100n'))
    assert 'rc_low_pass' in _ids(lower)
    assert _ids(lower) == _ids(upper)


def test_extra_parts_on_the_matched_nets_do_not_break_a_match():
    """A load hanging off a divider tap is still a divider."""
    deck = _deck(
        'V1 vin 0 12\nR1 vin tap 10k\nR2 tap 0 2k2\nC1 tap 0 100n\nR3 tap adc 100k')
    result = ic_detect.detect_ic_patterns(deck)
    assert 'voltage_divider' in _ids(result)


def test_component_order_in_the_deck_does_not_matter():
    a = ic_detect.detect_ic_patterns(_deck('Q1 mirr mirr 0 2N3904\nQ2 out mirr 0 2N3904\n'
                                           'Rbias in mirr 10k\nV1 in 0 5'))
    b = ic_detect.detect_ic_patterns(_deck('V1 in 0 5\nRbias in mirr 10k\n'
                                           'Q2 out mirr 0 2N3904\nQ1 mirr mirr 0 2N3904'))
    assert _ids(a) == _ids(b)
    assert 'current_mirror' in _ids(a)


# ── Output contract: nothing may read as a fact that is not one ───────────

def test_every_match_carries_confidence_evidence_and_subgraph():
    decks = [_deck(pos) for _id, pos, _neg in CASES] + [_deck(neg) for _id, _pos, neg in CASES]
    seen = 0
    for deck in decks:
        result = ic_detect.detect_ic_patterns(deck)
        for match in result['patterns']:
            seen += 1
            assert isinstance(match['confidence'], float)
            assert 0.0 < match['confidence'] <= 1.0
            assert match['evidence'], f'{match["patternId"]} matched with no evidence'
            assert any(line.startswith('net ') for line in match['evidence']), (
                f'{match["patternId"]} reports no nets')
            assert match['matchedSubgraph']['refs'], 'a match without components is a claim'
            assert match['components'], 'no component list'
            assert match['limits'], f'{match["patternId"]} must state what it cannot prove'
            assert isinstance(match['assertive'], bool)
            assert match['assertive'] == (
                match['confidence'] >= ic_detect.MIN_DEFINITE_CONFIDENCE)
            for cand in match['candidates']:
                assert cand['part']
                assert isinstance(cand['confidence'], float)
                assert isinstance(cand['estimated'], bool)
                assert cand['note'], f'{match["patternId"]}/{cand["part"]} has no why'
    assert seen > 40, f'the positive/negative decks only produced {seen} matches'


def test_no_template_placeholder_survives_into_the_result():
    """An unsubstituted {role.p0} (or a bare {role}) means a broken template."""
    for deck in [_deck(pos) for _id, pos, _neg in CASES]:
        for match in ic_detect.detect_ic_patterns(deck)['patterns']:
            blob = json.dumps(match)
            leftovers = re.findall(r'\{\w+(?:\.\w+)?\}', blob)
            assert not leftovers, f'{match["patternId"]} left {leftovers} unsubstituted'


def test_a_pair_is_not_reported_twice_for_swapping_its_own_roles():
    """Q1/Q2 in either order is ONE reading, not two.

    A symmetric pair (which transistor is "hi") and a terminal written the
    other way round produce the same components on the same nets. Printing both
    would let a model claim two matches where the board has one.
    """
    deck = _deck('V1 vcc 0 9\nQ1 vcc in out 2N3904\nQ2 out in vcc 2N3906')
    result = ic_detect.detect_ic_patterns(deck)
    pairs = _matches(result, 'complementary_follower_pair')
    assert len(pairs) == 1, [p['matchedSubgraph']['refs'] for p in pairs]
    assert pairs[0]['matchedSubgraph']['refs'] == ['Q1', 'Q2']
    # And no pattern ever reports the same ref-set twice.
    for match in result['patterns']:
        key = (match['patternId'], tuple(match['matchedSubgraph']['refs']))
        assert [
            (m['patternId'], tuple(m['matchedSubgraph']['refs']))
            for m in result['patterns']
        ].count(key) == 1


def test_unexplained_names_only_the_parts_no_match_touched():
    deck = _deck('V1 vin 0 12\nR1 vin tap 10k\nR2 tap 0 2k2\nL1 lone wolf 10u')
    result = ic_detect.detect_ic_patterns(deck)
    assert 'voltage_divider' in _ids(result)
    assert 'L1' in result['unexplained']
    assert 'R1' not in result['unexplained']
    assert 'R2' not in result['unexplained']


def test_empty_and_comment_only_decks_answer_nothing_without_lying():
    for text in ('', '* just a title\n.end\n', '   \n\t\n'):
        result = ic_detect.detect_ic_patterns(text)
        assert result['patterns'] == []
        assert result['matched'] is False
        assert 'fallback' in result, 'an empty answer must name the fallback'


def test_garbage_input_raises_a_plain_message_never_an_attribute_error():
    for bad in (None, 42, 3.5, ['R1 a b 1k'], {'netlist': 'x'}, b'R1 a b 1k', object()):
        with pytest.raises(ValueError) as exc:
            ic_detect.detect_ic_patterns(bad)  # type: ignore[arg-type]
        message = str(exc.value)
        assert message and not message.startswith("'")
        assert 'string' in message.lower()
        assert 'attribute' not in message.lower()


def test_top_k_limits_the_result_and_says_so():
    deck = _deck('V1 vin 0 12\nR1 vin tap 10k\nR2 tap 0 2k2\nR3 vin other 1k\n'
                 'R4 other 0 2k2')
    full = ic_detect.detect_ic_patterns(deck)
    cut = ic_detect.detect_ic_patterns(deck, top_k=1)
    assert len(full['patterns']) >= 2, 'this deck should match more than one divider'
    assert len(cut['patterns']) == 1
    assert cut['truncated'] is True
    # topK must not lie about what was explained.
    assert cut['patterns'][0]['confidence'] == max(
        p['confidence'] for p in full['patterns'])


def test_top_k_tolerates_junk_from_a_model():
    deck = _deck('R1 vin tap 10k\nR2 tap 0 2k2')
    for junk in ('3', 'two', None, True, [], {}, 0):
        result = ic_detect.detect_ic_patterns(deck, top_k=junk)
        assert isinstance(result['patterns'], list)


def test_oscillator_reading_is_never_assertive():
    """The weakest claim in the library must stay flagged as one."""
    deck = _deck('V1 vcc 0 9\nM1 d g 0 bs170\nR1 d g 100k\nC1 g 0 1n')
    loop = _matches(ic_detect.detect_ic_patterns(deck), 'rc_feedback_loop')[0]
    assert loop['assertive'] is False
    assert loop['confidence'] < ic_detect.MIN_DEFINITE_CONFIDENCE
    assert any('CRYSTAL' in line or 'crystal' in line for line in loop['limits'])


# ── The confidence scale, and the floor that filters on it ─────────────────

def test_pattern_confidences_occupy_the_documented_bands():
    """The bands in the module docstring must be the bands the data uses."""
    bands = {'definite': 0, 'role': 0, 'stage': 0, 'hint': 0}
    for info in ic_detect.describe_library():
        conf = info['confidence']
        assert 0.0 < conf <= 0.95, f'{info["id"]} is off the scale'
        if conf >= 0.85:
            bands['definite'] += 1
        elif conf >= 0.70:
            bands['role'] += 1
        elif conf >= 0.60:
            bands['stage'] += 1
        else:
            bands['hint'] += 1
    assert all(bands.values()), f'a documented band has no members: {bands}'


def test_name_based_readings_are_never_assertive_on_their_own():
    """Only a part number the DECK states may cross the definite bar."""
    for info in ic_detect.describe_library():
        if info['source'].startswith('name'):
            assert info['confidence'] < ic_detect.MIN_DEFINITE_CONFIDENCE, (
                f'{info["id"]} rests on a name yet claims {info["confidence"]}')


def test_weak_readings_survive_by_default():
    deck = _deck('V1 d 0 5\nR1 d k 330\nD1 k 0 1N4148\nR2 d tap 10k\nR3 tap 0 10k')
    result = ic_detect.detect_ic_patterns(deck)
    assert result['minConfidence'] == 0.0
    assert result['filtered'] == 0
    assert 'diode_series_limiter' in _ids(result), (
        'the 0.5 reading must still be visible with no floor applied')
    weak = _matches(result, 'diode_series_limiter')[0]
    assert weak['confidence'] < ic_detect.MIN_DEFINITE_CONFIDENCE
    assert weak['assertive'] is False


def test_min_confidence_drops_weak_readings_and_counts_them():
    deck = _deck('V1 d 0 5\nR1 d k 330\nD1 k 0 1N4148\nR2 d tap 10k\nR3 tap 0 10k')
    floored = ic_detect.detect_ic_patterns(deck, min_confidence=0.8)
    assert _ids(floored) == {'voltage_divider'}
    assert floored['filtered'] == 1
    assert floored['minConfidence'] == 0.8
    # The dropped reading's parts are now honestly "not explained by what was kept".
    assert {'R1', 'D1'} <= set(floored['unexplained'])
    assert any('min_confidence' in note for note in floored['notes']), (
        'a filtered answer must say it was filtered')


def test_a_floor_that_erases_everything_does_not_claim_nothing_matched():
    deck = _deck('V1 d 0 5\nR1 d k 330\nD1 k 0 1N4148')
    result = ic_detect.detect_ic_patterns(deck, min_confidence=0.9)
    assert result['patterns'] == []
    assert result['filtered'] == 1
    assert 'min_confidence' in result['fallback'] or 'floor' in result['fallback'], (
        result['fallback'])


def test_min_confidence_tolerates_junk_and_clamps():
    deck = _deck('V1 d 0 5\nR1 d k 330\nD1 k 0 1N4148\nR2 d tap 10k\nR3 tap 0 10k')
    for junk in (None, 'high', True, [], {}):
        cut = ic_detect.detect_ic_patterns(deck, min_confidence=junk)
        assert cut['minConfidence'] == 0.0, junk
        assert cut['filtered'] == 0, junk
        assert 'diode_series_limiter' in _ids(cut), junk
    assert ic_detect.detect_ic_patterns(deck, min_confidence=-5)['filtered'] == 0
    # A floor of 1.0 keeps nothing here (no pattern is that sure of itself).
    assert ic_detect.detect_ic_patterns(deck, min_confidence=1.0)['patterns'] == []
    # A numeric string is a real floor, not junk.
    assert ic_detect.detect_ic_patterns(deck, min_confidence='0.8')['filtered'] == 1


def test_floor_is_applied_before_top_k():
    """topK must count the kept set, not the whole match list."""
    deck = _deck('V1 d 0 5\nR1 d k 330\nD1 k 0 1N4148\nR2 d tap 10k\nR3 tap 0 10k\n'
                 'R4 d other 20k\nR5 other 0 1k')
    result = ic_detect.detect_ic_patterns(deck, top_k=1, min_confidence=0.8)
    assert len(result['patterns']) == 1
    assert result['patterns'][0]['confidence'] >= ic_detect.MIN_DEFINITE_CONFIDENCE
    assert result['filtered'] >= 1


# ── Deck loading goes through circuit_tools' helpers, both ways ────────────

def test_detect_for_deck_accepts_inline_text_without_touching_the_disk(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = ic_detect.detect_ic_for_deck('R1 in out 1k\nC1 out 0 100n')
    assert 'rc_low_pass' in _ids(result)
    assert result.get('deckPath', '') == ''
    # The conftest owns other files in this dir; what must NOT appear is a deck.
    stray = [p.name for p in tmp_path.iterdir() if p.name.startswith('_schematic_inline_')
             or p.suffix in ('.cir', '.net', '.ckt', '.sp', '.layout.json')]
    assert stray == [], 'a read-only tool wrote a scratch deck'


def test_detect_for_deck_accepts_a_workspace_path(tmp_path):
    deck = tmp_path / 'divider.cir'
    deck.write_text('* divider\nV1 vin 0 12\nR1 vin tap 10k\nR2 tap 0 2k2\n.end\n',
                    encoding='utf-8')
    result = ic_detect.detect_ic_for_deck('divider.cir', workspace=str(tmp_path))
    assert 'voltage_divider' in _ids(result)
    assert result['deckPath'].endswith('divider.cir')


def test_detect_for_deck_rejects_non_string_and_missing_files_cleanly(tmp_path):
    with pytest.raises(ValueError) as exc:
        ic_detect.detect_ic_for_deck(42)  # type: ignore[arg-type]
    assert 'string' in str(exc.value)
    with pytest.raises(ValueError) as exc:
        ic_detect.detect_ic_for_deck('missing.cir', workspace=str(tmp_path))
    assert 'not found' in str(exc.value).lower()
    with pytest.raises(ValueError):
        ic_detect.detect_ic_for_deck('   ')


# ── The registered tool + policy classification ────────────────────────────

def _registry() -> dict[str, dict[str, Any]]:
    from app.services import tool_registry
    from app.services.tool_registrations import register_all

    register_all()
    return tool_registry._registry  # noqa: SLF001 — read-only inspection of the surface


def test_tool_is_registered_with_the_expected_schema():
    registry = _registry()
    tool = registry.get('circuit_detect_ic')
    assert tool is not None, 'circuit_detect_ic is not registered'
    schema = tool['parameters']
    assert schema['required'] == ['netlist']
    assert schema['properties']['netlist']['type'] == 'string'
    assert 'topK' in schema['properties']
    assert schema['properties']['topK']['type'] == 'number'


def test_tool_description_points_at_the_fallback_and_the_threshold():
    from app.services.tools.ic_detect import MIN_DEFINITE_CONFIDENCE

    description = _registry()['circuit_detect_ic']['description']
    assert 'circuit_search_component' in description
    assert 'circuit_integrate_component' in description
    assert str(MIN_DEFINITE_CONFIDENCE) in description, (
        'the description must state the same bar the code uses')


def test_tool_is_gated_behind_the_circuit_workbench():
    from app.services.tool_registrations.circuit_tools import _is_circuit_gate_tool

    assert _is_circuit_gate_tool('circuit_detect_ic') is True


def test_tool_is_classified_read_only():
    from app.services import tool_policy

    assert tool_policy.prompt_bucket('circuit_detect_ic') == 'tool_read'
    assert tool_policy.is_mutating('circuit_detect_ic') is False
    assert tool_policy.is_shell_mutation('circuit_detect_ic') is False
    assert tool_policy.needs_approval_in('plan', 'circuit_detect_ic') is False


@pytest.mark.asyncio
async def test_dispatch_with_junk_arguments_returns_a_plain_error(tmp_path, monkeypatch):
    """The smoke-matrix contract: no raw interpreter text at the boundary."""
    from types import SimpleNamespace

    from app.services import tool_registry
    from app.services.tool_registrations import register_all
    from app.services.workbench import sessions as sess_mod
    from app.services.workbench.context import currentSessionId

    register_all()
    fake = SimpleNamespace(id='ic-smoke', workspacePath=str(tmp_path), guardMode='full',
                           metadata={'circuitMode': True})
    monkeypatch.setattr(sess_mod, 'get_workbench_session', lambda sid: fake)
    token = currentSessionId.set('ic-smoke')
    try:
        for args in ({}, {'netlist': 42}, {'netlist': None}, {'netlist': {'a': 1}},
                     {'netlist': 'R1 a b 1k', 'topK': 'lots'}):
            result = await tool_registry.dispatch('circuit_detect_ic', args)
            assert isinstance(result, str)
            parsed: object = None
            if not result.startswith('Error'):
                parsed = json.loads(result)
            assert parsed is None or isinstance(parsed, dict)
    finally:
        currentSessionId.reset(token)


@pytest.mark.asyncio
async def test_dispatch_finds_a_topology_in_a_real_deck(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from app.services import tool_registry
    from app.services.tool_registrations import register_all
    from app.services.workbench import sessions as sess_mod
    from app.services.workbench.context import currentSessionId

    register_all()
    fake = SimpleNamespace(id='ic-real', workspacePath=str(tmp_path), guardMode='full',
                           metadata={'circuitMode': True})
    monkeypatch.setattr(sess_mod, 'get_workbench_session', lambda sid: fake)
    token = currentSessionId.set('ic-real')
    try:
        raw = await tool_registry.dispatch(
            'circuit_detect_ic',
            {'netlist': 'V1 vcc 0 5\nR1 vcc btn 10k\nS1 btn 0 pb', 'topK': 5},
        )
        payload = json.loads(raw)
        assert 'patterns' in payload, raw
        assert 'switch_pull_up' in {p['patternId'] for p in payload['patterns']}
    finally:
        currentSessionId.reset(token)


# ── Realistic end-to-end decks (the "does it read like a board?" check) ────

def test_psu_and_sensor_deck_reports_several_topologies_with_evidence():
    deck = _deck(
        'V1 mains 0 SIN(0 230 50)\n'
        'C1 mains dropped 330n\n'
        'R1 dropped 0 220k\n'
        'R2 dropped bias 1k\n'
        'C2 bias 0 100n\n'
        'V3 vcc 0 5\n'
        'R3 vcc sense 100\n'
        'R4 sense 0 0R47\n'
        'R5 vcc btn 10k\n'
        'S1 btn 0 sw1\n')
    result = ic_detect.detect_ic_patterns(deck)
    ids = _ids(result)
    assert {'capacitive_dropper', 'rc_low_pass', 'voltage_divider',
            'switch_pull_up'} <= ids, sorted(ids)
    assert all(p['evidence'] for p in result['patterns'])
    assert not result['library']['errors']


def test_result_is_json_serialisable():
    deck = _deck('V1 vcc 0 9\nQ1 vcc in out 2N3904\nRe out 0 470')
    text = json.dumps(ic_detect.detect_ic_patterns(deck))
    assert 'common_collector' in text
