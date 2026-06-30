"""
DOM snapshot — collect interactive elements and tag them with stable refs.

Port of ``browser-tools.js``'s ``domSnapshotScript``. The improvement over
the Node original: each interactive element is tagged with a
``data-august-ref="N"`` attribute during the walk, so a later
``browserClick(ref="@e3")`` resolves to ``[data-august-ref="3"]`` regardless
of whether the element has an id/name (the Node selector fallback was empty
for most elements).
"""
from __future__ import annotations
DOM_SNAPSHOT_SCRIPT = '\n() => {\n  const interactiveTags = [\'A\',\'BUTTON\',\'INPUT\',\'SELECT\',\'TEXTAREA\',\'DETAILS\',\'SUMMARY\'];\n  const interactiveRoles = [\n    \'button\',\'link\',\'textbox\',\'combobox\',\'listbox\',\'menuitem\',\n    \'checkbox\',\'radio\',\'switch\',\'tab\',\'treeitem\',\'searchbox\',\n    \'spinbutton\',\'slider\',\'option\',\'progressbar\',\'scrollbar\',\'tabpanel\'\n  ];\n  const tagToRole = {\n    A:\'link\', BUTTON:\'button\', INPUT:\'textbox\', SELECT:\'listbox\',\n    TEXTAREA:\'textbox\', DETAILS:\'group\', SUMMARY:\'button\',\n    NAV:\'navigation\', MAIN:\'main\', HEADER:\'banner\', FOOTER:\'contentinfo\',\n    ASIDE:\'complementary\', FORM:\'form\', TABLE:\'table\', IMG:\'img\',\n    H1:\'heading\', H2:\'heading\', H3:\'heading\', H4:\'heading\', H5:\'heading\', H6:\'heading\',\n    UL:\'list\', OL:\'list\', LI:\'listitem\'\n  };\n  const result = [];\n  let counter = 0;\n  function walk(node, depth) {\n    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;\n    const el = node;\n    const tag = el.tagName;\n    const explicitRole = el.getAttribute(\'role\');\n    const role = explicitRole || tagToRole[tag] || tag.toLowerCase();\n    const isInteractive = interactiveTags.indexOf(tag) >= 0 ||\n      interactiveRoles.indexOf(role) >= 0 ||\n      (tag === \'IMG\' && el.hasAttribute(\'alt\')) ||\n      tag === \'IFRAME\' ||\n      el.hasAttribute(\'tabindex\') || el.hasAttribute(\'onclick\') ||\n      el.getAttribute(\'contenteditable\') === \'true\' ||\n      (el.style && el.style.cursor === \'pointer\');\n    if (isInteractive || explicitRole || tagToRole[tag]) {\n      counter++;\n      const ref = \'@e\' + counter;\n      el.setAttribute(\'data-august-ref\', String(counter));\n      result.push({\n        ref: ref,\n        role: role,\n        name: el.getAttribute(\'aria-label\') || (el.textContent ? el.textContent.trim().slice(0, 200) : \'\') || \'\',\n        value: el.value !== undefined ? String(el.value).slice(0, 120) : \'\',\n        description: el.getAttribute(\'aria-description\') || el.title || \'\',\n        tag: tag.toLowerCase(),\n        selector: \'[data-august-ref="\' + counter + \'"]\',\n        depth: depth\n      });\n    }\n    for (let i = 0; i < el.children.length; i++) {\n      walk(el.children[i], depth + 1);\n    }\n  }\n  walk(document.body, 0);\n  return result;\n}\n'

async def runSnapshot(page: object) -> list[dict[str, object]]:
    """Execute the snapshot script on ``page`` and return element descriptors."""
    try:
        elements = await page.evaluate(DOM_SNAPSHOT_SCRIPT)
    except Exception:
        elements = []
    return elements if isinstance(elements, list) else []

def buildCompactSnapshot(elements: list[dict[str, object]]) -> str:
    """Format elements as one line each: ``[@e1] button "Search"``.

    Only interactive roles, headings, and text are shown, matching the Node
    compact mode so the model gets a concise, click-addressable view.
    """
    interactiveRoles = {'button', 'link', 'textbox', 'combobox', 'listbox', 'menuitem', 'checkbox', 'radio', 'switch', 'tab', 'treeitem', 'searchbox', 'spinbutton', 'slider', 'option', 'progressbar', 'scrollbar', 'tabpanel', 'heading'}
    lines: list[str] = []
    for el in elements:
        role = el.get('role', '')
        if role not in interactiveRoles and role != 'text':
            continue
        parts = [f"[{el.get('ref', '')}]"]
        if role:
            parts.append(role)
        name = (el.get('name') or '')[:120]
        if name:
            parts.append('"' + name + '"')
        value = (el.get('value') or '')[:80]
        if value:
            parts.append(f'value={value!r}')
        desc = (el.get('description') or '')[:80]
        if desc:
            parts.append(f'desc={desc!r}')
        lines.append(' '.join(parts))
    return '\n'.join(lines)