"""Bot Mode Phase A UX — roster row data: last-message preview + activity.

The plan's Bots rail spec: "one row per Bot = avatar + latest-message preview
+ timestamp + unread dot" and an "Active now" presence strip for Bots that
wrote within 90 s. The session summary already carries updatedAt; this pins
the added ``lastPreview`` (truncated last message text, safe for display).
"""

from __future__ import annotations


def test_summarize_session_carries_last_preview(isolatedData):
    from app.services.workbench import sessions as sm

    s = sm.create_workbench_session()
    s.messages = [
        {'role': 'user', 'content': 'hello there'},
        {'role': 'assistant', 'content': 'Plain text reply.'},
    ]
    summary = sm.summarize_session(s)
    assert summary['lastPreview'] == 'Plain text reply.'
    assert summary['updatedAt']


def test_last_preview_truncated_and_dict_content_flattened(isolatedData):
    from app.services.workbench import sessions as sm

    s = sm.create_workbench_session()
    long = 'x' * 300
    # Workbench stores assistant messages as dict payloads with content blocks.
    s.messages = [
        {'role': 'user', 'content': 'q'},
        {'role': 'assistant', 'content': [{'type': 'text', 'text': long}]},
    ]
    summary = sm.summarize_session(s)
    assert len(str(summary['lastPreview'])) <= 120
    assert str(summary['lastPreview']).startswith('xxx')

def test_last_preview_none_for_empty_session(isolatedData):
    from app.services.workbench import sessions as sm

    s = sm.create_workbench_session()
    summary = sm.summarize_session(s)
    assert summary['lastPreview'] == ''
