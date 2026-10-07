"""The fleet's role set and its per-role gateway.

Three things are pinned here, all of them broken before 2026-10-07:

* the settings tab offered five roles the service refused to save, so a patch
  containing any of them 400ed and NOTHING persisted;
* a role stored only a model id, so a model served by two gateways ran on
  whichever provider listed it first;
* an unknown role answered with the cortex model, which made a typo in a caller
  look like a configured role.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from app.services import memory_store
from app.services.model_fleet_service import (
    ROLES,
    getFleet,
    getFleetProviders,
    getModelForRole,
    resolveRoleModel,
    updateFleet,
)

FLEET_TAB = (
    Path(__file__).resolve().parents[2] / 'frontend/desktop/src/sections/workspace/ModelFleetTab.tsx'
)


@pytest.fixture(autouse=True)
def _init():
    memory_store.init()
    yield


def _copyRoles() -> set[str]:
    """The role keys in the settings tab's prose map."""
    text = FLEET_TAB.read_text('utf-8')
    block = text.split('const ROLE_COPY', 1)[1].split('};', 1)[0]
    return set(re.findall(r'^\s{2}([a-z_]+):\s*\{', block, re.M))


def test_the_service_and_the_settings_prose_cover_the_same_roles():
    """The tab renders whatever the SERVER lists, so a role can no longer exist
    in one place and not the other — which is how five fields ended up
    unsavable (and 400ed the whole patch, discarding the six valid ones too).
    """
    copy = _copyRoles()
    assert copy, 'the fleet tab no longer declares role prose in ROLE_COPY'
    assert copy - set(ROLES) == set(), 'prose for a role the service does not know'
    assert set(ROLES) - copy == set(), 'a role with no label or hint'


def test_every_role_carries_a_gateway_slot():
    fleet = getFleet()
    providers = getFleetProviders()
    assert set(fleet) == set(ROLES)
    assert set(providers) == set(ROLES)


def test_a_role_round_trips_its_model_and_its_gateway():
    ok, err, state = updateFleet(
        {'models': {'chat_smol': 'stepfun/step-3.7-flash'}, 'providers': {'chat_smol': 'KiloCode'}}
    )
    assert ok, err
    assert state['models']['chat_smol'] == 'stepfun/step-3.7-flash'
    assert resolveRoleModel('chat_smol') == ('stepfun/step-3.7-flash', 'KiloCode')


def test_the_legacy_flat_patch_still_saves():
    """Callers that predate the wrapped body must not silently stop persisting."""
    ok, err, state = updateFleet({'cerebellum': 'llama-3.3-70b'})
    assert ok, err
    assert state['models']['cerebellum'] == 'llama-3.3-70b'
    assert resolveRoleModel('cerebellum') == ('llama-3.3-70b', '')


def test_an_unknown_role_is_rejected_in_either_map():
    ok, err, _state = updateFleet({'models': {'no_such_role': 'm'}})
    assert not ok and 'no_such_role' in err
    ok2, err2, _ = updateFleet({'providers': {'no_such_role': 'P'}})
    assert not ok2 and 'no_such_role' in err2


def test_an_unknown_role_no_longer_answers_with_the_cortex_model():
    updateFleet({'models': {'cortex': 'the-cortex-model'}})
    assert getModelForRole('not_a_role') == ''
