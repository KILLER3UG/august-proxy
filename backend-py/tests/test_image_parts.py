"""Hermes-style inline image parts on the chat wire.

Composer images land under <workspace>/.aug/attachments/ and the message text
names the path; inline_image_parts upgrades those user messages to multipart
content at dispatch (storage keeps plain text) so the CHAT model sees the
image directly instead of detouring through analyze_media.
"""

from __future__ import annotations

import base64

from app.services.workbench.image_parts import inline_image_parts


def _receipt(path: str, kind: str = 'image') -> str:
    # Exact template ChatAttachmentService.ts composes for uploads.
    return (
        f'What is this?\n[Attached file — stored at {path}. '
        f'Open it with analyze_media ({kind}) or read_file.]'
    )


def _png(tmp_path, name='shot.png', blob=b'\x89PNG\r\n\x1a\nfakebytes'):
    p = tmp_path / name
    p.write_bytes(blob)
    return p


def test_inline_upgrades_user_message_with_image(tmp_path):
    p = _png(tmp_path)
    msgs = [{'role': 'user', 'content': _receipt(str(p))}]
    out = inline_image_parts(msgs)
    assert out is not msgs, 'a matching message must be rebuilt, not mutated'
    content = out[0]['content']
    assert isinstance(content, list)
    assert content[0] == {'type': 'text', 'text': _receipt(str(p))}
    img = content[1]
    assert img['type'] == 'image'
    src = img['source']
    assert src['type'] == 'base64'
    assert src['media_type'] == 'image/png'
    assert base64.b64decode(src['data']) == b'\x89PNG\r\n\x1a\nfakebytes'
    # Storage shape untouched.
    assert msgs[0]['content'] == _receipt(str(p))


def test_inline_skips_non_images_and_missing_files(tmp_path):
    txt = tmp_path / 'notes.txt'
    txt.write_text('hello')
    missing = tmp_path / 'gone.png'
    msgs = [
        {'role': 'user', 'content': _receipt(str(txt), 'document')},
        {'role': 'user', 'content': _receipt(str(missing))},
        {'role': 'user', 'content': 'plain message, no attachments'},
        {'role': 'assistant', 'content': 'reply'},
    ]
    out = inline_image_parts(msgs)
    assert out is msgs, 'no image markers matched — must return the input untouched'
    for m in out:
        assert isinstance(m['content'], str)


def test_inline_is_cached_per_path_mtime(tmp_path):
    p = _png(tmp_path)
    msgs = [{'role': 'user', 'content': _receipt(str(p))}]
    first = inline_image_parts(msgs)[0]['content'][1]
    second = inline_image_parts(msgs)[0]['content'][1]
    assert first is second, 'unchanged file must reuse the cached block'

    p.write_bytes(b'\x89PNG-changed')
    third = inline_image_parts(msgs)[0]['content'][1]
    assert third is not first
    assert base64.b64decode(third['source']['data']).endswith(b'changed')


def test_openai_translator_maps_inline_image_to_data_uri(tmp_path):
    """The OpenAI/Responses path converts the Anthropic-style block to an
    image_url data URI (translateMessages)."""
    from app.adapters.anthropic import translateMessages

    p = _png(tmp_path)
    msgs = [{'role': 'user', 'content': _receipt(str(p))}]
    wire = inline_image_parts(msgs)
    openaiMsgs = translateMessages(wire)
    content = openaiMsgs[0]['content']
    assert isinstance(content, list)
    kinds = [part['type'] for part in content]
    assert kinds == ['text', 'image_url']
    url = content[1]['image_url']['url']
    assert url.startswith('data:image/png;base64,')


def test_anthropic_translator_passes_image_blocks_through(tmp_path):
    """The Anthropic path forwards the multipart user content verbatim."""
    from app.adapters.anthropic import translateMessagesToAnthropic

    p = _png(tmp_path)
    msgs = [{'role': 'user', 'content': _receipt(str(p))}]
    wire = inline_image_parts(msgs)
    out = translateMessagesToAnthropic(wire)
    content = out[0]['content']
    assert isinstance(content, list)
    assert content[1]['source']['type'] == 'base64'
