"""
DOM snapshot — collect interactive elements and tag them with stable refs.

Port of ``browser-tools.js``'s ``domSnapshotScript``. The improvement over
the Node original: each interactive element is tagged with a
``data-august-ref="N"`` attribute during the walk, so a later
``browser_click(ref="@e3")`` resolves to ``[data-august-ref="3"]`` regardless
of whether the element has an id/name (the Node selector fallback was empty
for most elements).
"""

from __future__ import annotations

from typing import Any

# JS executed via page.evaluate. Walks the DOM, tags interactive elements,
# and returns a compact descriptor list. Runs as an async function expression.
DOM_SNAPSHOT_SCRIPT = r"""
() => {
  const interactiveTags = ['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY'];
  const interactiveRoles = [
    'button','link','textbox','combobox','listbox','menuitem',
    'checkbox','radio','switch','tab','treeitem','searchbox',
    'spinbutton','slider','option','progressbar','scrollbar','tabpanel'
  ];
  const tagToRole = {
    A:'link', BUTTON:'button', INPUT:'textbox', SELECT:'listbox',
    TEXTAREA:'textbox', DETAILS:'group', SUMMARY:'button',
    NAV:'navigation', MAIN:'main', HEADER:'banner', FOOTER:'contentinfo',
    ASIDE:'complementary', FORM:'form', TABLE:'table', IMG:'img',
    H1:'heading', H2:'heading', H3:'heading', H4:'heading', H5:'heading', H6:'heading',
    UL:'list', OL:'list', LI:'listitem'
  };
  const result = [];
  let counter = 0;
  function walk(node, depth) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    const explicitRole = el.getAttribute('role');
    const role = explicitRole || tagToRole[tag] || tag.toLowerCase();
    const isInteractive = interactiveTags.indexOf(tag) >= 0 ||
      interactiveRoles.indexOf(role) >= 0 ||
      (tag === 'IMG' && el.hasAttribute('alt')) ||
      tag === 'IFRAME' ||
      el.hasAttribute('tabindex') || el.hasAttribute('onclick') ||
      el.getAttribute('contenteditable') === 'true' ||
      (el.style && el.style.cursor === 'pointer');
    if (isInteractive || explicitRole || tagToRole[tag]) {
      counter++;
      const ref = '@e' + counter;
      el.setAttribute('data-august-ref', String(counter));
      result.push({
        ref: ref,
        role: role,
        name: el.getAttribute('aria-label') || (el.textContent ? el.textContent.trim().slice(0, 200) : '') || '',
        value: el.value !== undefined ? String(el.value).slice(0, 120) : '',
        description: el.getAttribute('aria-description') || el.title || '',
        tag: tag.toLowerCase(),
        selector: '[data-august-ref="' + counter + '"]',
        depth: depth
      });
    }
    for (let i = 0; i < el.children.length; i++) {
      walk(el.children[i], depth + 1);
    }
  }
  walk(document.body, 0);
  return result;
}
"""


async def run_snapshot(page: Any) -> list[dict[str, Any]]:
    """Execute the snapshot script on ``page`` and return element descriptors."""
    try:
        elements = await page.evaluate(DOM_SNAPSHOT_SCRIPT)
    except Exception:
        elements = []
    return elements if isinstance(elements, list) else []


def build_compact_snapshot(elements: list[dict[str, Any]]) -> str:
    """Format elements as one line each: ``[@e1] button "Search"``.

    Only interactive roles, headings, and text are shown, matching the Node
    compact mode so the model gets a concise, click-addressable view.
    """
    interactive_roles = {
        "button", "link", "textbox", "combobox", "listbox", "menuitem",
        "checkbox", "radio", "switch", "tab", "treeitem", "searchbox",
        "spinbutton", "slider", "option", "progressbar", "scrollbar", "tabpanel",
        "heading",
    }
    lines: list[str] = []
    for el in elements:
        role = el.get("role", "")
        if role not in interactive_roles and role != "text":
            continue
        parts = [f"[{el.get('ref', '')}]"]
        if role:
            parts.append(role)
        name = (el.get("name") or "")[:120]
        if name:
            parts.append('"' + name + '"')
        value = (el.get("value") or "")[:80]
        if value:
            parts.append(f"value={value!r}")
        desc = (el.get("description") or "")[:80]
        if desc:
            parts.append(f"desc={desc!r}")
        lines.append(" ".join(parts))
    return "\n".join(lines)
