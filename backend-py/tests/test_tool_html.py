"""Unit tests for pure HTML helpers (tool_html)."""

from __future__ import annotations

from app.services.tool_html import html_to_markdown, unescape_html


def test_unescape_html_entities():
    assert unescape_html('&amp; &lt; &gt; &quot; &#39;') == '& < > " \''
    assert unescape_html('plain text') == 'plain text'
    assert unescape_html('') == ''
    assert unescape_html('Tom &amp; Jerry') == 'Tom & Jerry'


def test_html_to_markdown_headings_and_emphasis():
    html = '<h1>Title</h1><p>Hello <b>world</b></p>'
    md = html_to_markdown(html)
    assert '# Title' in md
    assert '**world**' in md
    assert '<h1>' not in md
    assert '<b>' not in md


def test_html_to_markdown_links_and_entities():
    html = '<p>Go to <a href="https://example.com">example</a> &amp; back</p>'
    md = html_to_markdown(html)
    assert 'example' in md
    assert 'https://example.com' in md
    assert '&' in md
    assert '&amp;' not in md


def test_html_to_markdown_images():
    html = '<img src="photo.png" alt="A photo">'
    md = html_to_markdown(html)
    assert 'photo.png' in md
    assert 'A photo' in md or '![A photo]' in md


def test_html_to_markdown_empty_and_plain():
    assert html_to_markdown('').strip() == ''
    md = html_to_markdown('just text')
    assert 'just text' in md


def test_html_to_markdown_truncates_at_50000():
    # Build HTML large enough that markdown output exceeds the cap.
    chunk = '<p>' + ('x' * 1000) + '</p>'
    html = chunk * 60  # well over 50k chars of content
    md = html_to_markdown(html)
    assert len(md) <= 50000
