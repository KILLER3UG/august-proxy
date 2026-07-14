"""
Pure HTML helpers used by web/tool handlers.

Extracted from tool_definitions for Phase 3 modularization.
"""

from __future__ import annotations


def html_to_markdown(html: str) -> str:
    """Convert HTML to clean Markdown using html2text."""
    import html2text  # type: ignore[import-not-found]

    converter = html2text.HTML2Text()
    converter.body_width = 0
    converter.ignore_links = False
    converter.ignore_images = False
    converter.ignore_emphasis = False
    converter.protect_links = True
    converter.unicode_snob = True
    converter.skip_internal_links = True
    return converter.handle(html)[:50000]


def unescape_html(text: str) -> str:
    """Unescape HTML entities like &amp; &lt; &gt; &quot; &#39; etc."""
    import html as _html

    return _html.unescape(text)
