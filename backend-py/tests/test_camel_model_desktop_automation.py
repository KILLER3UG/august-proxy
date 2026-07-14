"""Characterization tests for CamelModel on the desktop_automation router.

Proves the ActionRequest boundary: CamelModel inheritance, Field descriptions
kept, model_validate + model_dump. Field names are single-word so snake_case
and camelCase are identical.
"""
from __future__ import annotations

from app.routers.desktop_automation import ActionRequest


def test_action_request_is_camel_model():
    from app.models.camel_base import CamelModel

    assert issubclass(ActionRequest, CamelModel)


def test_action_request_serializes():
    body = ActionRequest(action='screenshot', params={'x': 1})
    dumped = body.model_dump(by_alias=True)
    assert dumped['action'] == 'screenshot'
    assert dumped['params'] == {'x': 1}


def test_action_request_model_dump_default_params():
    body = ActionRequest(action='screen_size')
    dumped = body.model_dump()
    assert dumped['action'] == 'screen_size'
    assert dumped['params'] == {}


def test_action_request_accepts_json_input():
    body = ActionRequest.model_validate(
        {
            'action': 'click',
            'params': {'x': 10, 'y': 20},
        }
    )
    assert body.action == 'click'
    assert body.params == {'x': 10, 'y': 20}


def test_action_request_accepts_populate_by_name():
    body = ActionRequest(action='type', params={'text': 'hi'})
    assert body.action == 'type'
    assert body.params == {'text': 'hi'}


def test_action_request_field_descriptions_present():
    fields = ActionRequest.model_fields
    assert 'action' in fields
    assert fields['action'].description is not None
    assert 'screenshot' in (fields['action'].description or '')
