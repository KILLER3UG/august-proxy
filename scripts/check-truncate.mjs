#!/usr/bin/env node
/**
 * check-truncate.mjs — every `truncate` actually truncates.
 *
 * Tailwind's `truncate` is `overflow: hidden; text-overflow: ellipsis;
 * white-space: nowrap`. Two of those three only do anything on a BLOCK
 * CONTAINER: `overflow` and `text-overflow` do not apply to an inline box.
 *
 * So `truncate` on a bare `<span>` is INERT — the text does not get an
 * ellipsis, it does not get clipped, it just runs on and paints over
 * whatever sits next to it. That is not a subtle degradation: it is the
 * model list painting a 120-character model id straight over the token
 * badge, the source badge and the four action buttons beside it, which is
 * exactly what it did in `ModelRow.tsx` before the fix.
 *
 * `truncate` works when the element is EITHER:
 *
 *   - blockified by its own display utility — `block`, `flex`, `grid`,
 *     `inline-block`, `inline-flex`, `inline-grid`, `table`, `flow-root`,
 *     `list-item`; or
 *   - a flex or grid ITEM, because a flex/grid item is blockified by the
 *     parent's layout. This is the rule that trips people up in both
 *     directions: `flex-1` and `flex-none` are ITEM-SIZING classes, not
 *     container classes, and a regex that matches `\bflex\b` misses every
 *     `flex-1` in the tree.
 *
 * This script uses the TypeScript compiler API rather than a regex for
 * exactly that reason: a text scan cannot tell a container from an item,
 * cannot tell a real element from a string that mentions "truncate", and
 * cannot see a `cn('truncate', cond && 'x')` call.
 *
 * Usage: node scripts/check-truncate.mjs
 * Exit 0: every `truncate` is on an element that can actually truncate.
 * Exit 1: a `truncate` is inert — it is on an inline box that is neither
 *         blockified by its own class nor a flex/grid item.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(root, 'frontend/desktop/src');

/**
 * Display utilities that make the element a block container (so `overflow`
 * and `text-overflow` apply), or remove its box entirely.
 */
const BLOCKIFYING_DISPLAY = new Set([
  'block',
  'flex',
  'grid',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'table',
  'table-cell',
  'table-caption',
  'flow-root',
  'list-item',
  'hidden',
]);

/** Container utilities — an element that is a child of one of these is a
 *  flex/grid item, and a flex/grid item is blockified. */
const CONTAINER_DISPLAY = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

/** Default `display` by tag, for elements with no display utility. */
const DEFAULT_DISPLAY = new Map(
  Object.entries({
    span: 'inline',
    a: 'inline',
    b: 'inline',
    i: 'inline',
    em: 'inline',
    strong: 'inline',
    small: 'inline',
    sub: 'inline',
    sup: 'inline',
    code: 'inline',
    kbd: 'inline',
    samp: 'inline',
    var: 'inline',
    abbr: 'inline',
    cite: 'inline',
    dfn: 'inline',
    mark: 'inline',
    q: 'inline',
    s: 'inline',
    u: 'inline',
    label: 'inline',
    time: 'inline',
    button: 'inline-block',
    input: 'inline-block',
    select: 'inline-block',
    textarea: 'inline-block',
    div: 'block',
    p: 'block',
    h1: 'block',
    h2: 'block',
    h3: 'block',
    h4: 'block',
    h5: 'block',
    h6: 'block',
    li: 'list-item',
    ul: 'block',
    ol: 'block',
    section: 'block',
    article: 'block',
    header: 'block',
    footer: 'block',
    main: 'block',
    nav: 'block',
    aside: 'block',
    figure: 'block',
    figcaption: 'block',
    blockquote: 'block',
    pre: 'block',
    hr: 'block',
    table: 'table',
    tbody: 'table-row-group',
    thead: 'table-header-group',
    tfoot: 'table-footer-group',
    tr: 'table-row',
    td: 'table-cell',
    th: 'table-cell',
  }),
);

/** Every `.tsx` file under a directory. */
function tsxFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'gen') continue;
        walk(full);
      } else if (entry.endsWith('.tsx')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * `display` and `text-overflow` declarations from the app's own stylesheets,
 * by class name.
 *
 * A Tailwind utility is not the only thing that can set `display` — the
 * repo's CSS sets it on its own classes too, and a class that says
 * `display: flex` makes its children flex items, which are blockified. And a
 * class that declares `text-overflow: ellipsis` truncates on its own,
 * whether or not `truncate` is there. Reading the stylesheets is what keeps
 * the gate from crying wolf on those.
 */
function cssRules() {
  const displays = new Map();
  const truncates = new Set();
  const stylesDir = resolve(root, 'frontend/desktop/src/styles');
  if (!existsSync(stylesDir)) return { displays, truncates };
  for (const entry of readdirSync(stylesDir)) {
    if (!entry.endsWith('.css')) continue;
    const text = readFileSync(join(stylesDir, entry), 'utf8');
    for (const m of text.matchAll(/\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g)) {
      const body = m[2];
      const d = body.match(/(?:^|;)\s*display\s*:\s*([a-z-]+)/);
      if (d) displays.set(m[1], d[1]);
      if (/(?:^|;)\s*text-overflow\s*:\s*ellipsis/.test(body)) truncates.add(m[1]);
    }
  }
  return { displays, truncates };
}

const { displays: CSS_DISPLAYS, truncates: CSS_TRUNCATES } = cssRules();

/** Every string literal inside a className expression, whatever shape it is. */
function classStrings(node) {
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      // A template literal with a substitution — `flex items-center ${
      //   x ? 'a' : 'b'
      // }` — is the commonest shape a className takes, and its classes live
      // in the HEAD and in each SPAN, not in a plain literal.
      out.push(n.head.text);
      for (const span of n.templateSpans) out.push(span.literal.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (node) visit(node);
  return out;
}

/** The className attribute's value expression, if the element has one. */
function classNameExpression(openingElement) {
  for (const prop of openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(prop)) continue;
    if (prop.name.text !== 'className') continue;
    if (!prop.initializer) return undefined;
    if (ts.isStringLiteral(prop.initializer)) {
      // className="truncate" — the literal IS the class list.
      return { literal: prop.initializer.text };
    }
    if (ts.isJsxExpression(prop.initializer)) {
      return { expression: prop.initializer.expression };
    }
  }
  return undefined;
}

/** The class tokens of an element. */
function classTokens(openingElement) {
  const cn = classNameExpression(openingElement);
  if (!cn) return [];
  if (cn.literal !== undefined) return cn.literal.split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const s of classStrings(cn.expression)) tokens.push(...s.split(/\s+/).filter(Boolean));
  return tokens;
}

/** The element's tag name, lowercased (`div`, `span`, `Fragment`, …). */
function tagName(openingElement) {
  const tag = openingElement.tagName;
  return ts.isIdentifier(tag) ? tag.text : tag.getText();
}

/** The DOM parent of a JSX element: the nearest ancestor ELEMENT. */
function domParent(elementNode, parents) {
  let cur = elementNode;
  let p = parents.get(cur);
  while (p) {
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) {
      return p.openingElement;
    }
    if (ts.isJsxFragment(p)) {
      // A fragment's children belong to the fragment's own parent.
      return domParent(p, parents);
    }
    cur = p;
    p = parents.get(cur);
  }
  return undefined;
}

/** True when the element is a flex or grid ITEM. */
function isFlexOrGridItem(elementNode, parents) {
  const parent = domParent(elementNode, parents);
  if (!parent) return false;
  const tokens = classTokens(parent);
  if (tokens.some((t) => CONTAINER_DISPLAY.has(t))) return true;
  // The parent may be a flex container because one of the app's own
  // stylesheet classes says so, not because of a Tailwind utility.
  for (const t of tokens) {
    const declared = CSS_DISPLAYS.get(t);
    if (declared && CONTAINER_DISPLAY.has(declared)) return true;
  }
  // `display: contents` removes the parent's box, so its children are laid
  // out as children of ITS parent — the element is an item of the
  // grandparent, not of the parent.
  if (tokens.includes('contents')) {
    const grandparent = domParentOfOpening(parent, parents);
    if (!grandparent) return false;
    const gtTokens = classTokens(grandparent);
    if (gtTokens.some((t) => CONTAINER_DISPLAY.has(t))) return true;
    for (const t of gtTokens) {
      const declared = CSS_DISPLAYS.get(t);
      if (declared && CONTAINER_DISPLAY.has(declared)) return true;
    }
  }
  return false;
}

/** The DOM parent of an OPENING ELEMENT (one level up from its element). */
function domParentOfOpening(openingElement, parents) {
  const element = parents.get(openingElement);
  if (!element) return undefined;
  return domParent(element, parents);
}

/** True when one of the element's own classes truncates it by itself. */
function truncatesByItsOwnClass(openingElement) {
  return classTokens(openingElement).some((t) => CSS_TRUNCATES.has(t));
}

/**
 * The effective `display` of an element, as far as static analysis can tell.
 *
 * A Tailwind display utility wins; then a `display` declared by one of the
 * app's own stylesheet classes; then the tag's default.
 */
function effectiveDisplay(openingElement) {
  const tokens = classTokens(openingElement);
  const utility = tokens.find(
    (t) => BLOCKIFYING_DISPLAY.has(t) || t === 'inline' || t === 'inline-table',
  );
  if (utility) return utility;
  for (const t of tokens) {
    const declared = CSS_DISPLAYS.get(t);
    if (declared) return declared;
  }
  const tag = tagName(openingElement);
  return DEFAULT_DISPLAY.get(tag) ?? 'inline';
}

/**
 * True when the element's parent is a CUSTOM COMPONENT.
 *
 * A component's own layout is invisible from the call site: `<Button>` is
 * `inline-flex` by construction, so every child of one is a flex item and
 * every flex item is blockified. Reporting a `truncate` inside a component
 * we cannot see the markup of would be reporting a guess, so those are left
 * alone — the gate only claims what it can PROVE.
 */
function parentIsCustomComponent(elementNode, parents) {
  const parent = domParent(elementNode, parents);
  if (!parent) return true;
  const tag = tagName(parent);
  return /^[A-Z]/.test(tag);
}

const problems = [];
let checked = 0;

for (const file of tsxFiles(SRC)) {
  const rel = file.slice(root.length + 1).split('\\').join('/');
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Parent map, so the DOM parent of an element can be found.
  const parents = new Map();
  const buildParents = (node) => {
    ts.forEachChild(node, (child) => {
      parents.set(child, node);
      buildParents(child);
    });
  };
  buildParents(source);

  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tokens = classTokens(opening);
      if (tokens.includes('truncate')) {
        checked += 1;
        const { line } = source.getLineAndCharacterOfPosition(opening.getStart(source));
        const tag = tagName(opening);
        const effective = effectiveDisplay(opening);
        const blockified = BLOCKIFYING_DISPLAY.has(effective) && effective !== 'inline';
        const unknownParent = parentIsCustomComponent(node, parents);
        const selfTruncating = truncatesByItsOwnClass(opening);
        if (!blockified && !unknownParent && !selfTruncating && !isFlexOrGridItem(node, parents)) {
          problems.push({
            file: rel,
            line: line + 1,
            tag,
            effective,
            tokens,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (problems.length > 0) {
  console.error('[check-truncate] FAIL — these `truncate` classes cannot truncate:');
  for (const p of problems) {
    console.error(
      `  ${p.file}:${p.line}  <${p.tag}>  display: ${p.effective}  class="${p.tokens.join(' ')}"`,
    );
  }
  console.error(
    '\n`overflow: hidden` and `text-overflow: ellipsis` do not apply to an inline box, so ' +
      'the text is not clipped and not ellipsised — it paints over whatever sits beside it.\n' +
      'Fix it by giving the element a blockifying display (`block`, `flex`, `inline-block`, …) ' +
      'or by making it a flex/grid item (`flex-1` inside a `flex` parent, for example).\n' +
      '`flex-1` and `flex-none` are ITEM-SIZING classes; they are not container classes.',
  );
  process.exit(1);
}

console.log(
  `[check-truncate] ok — ${checked} \`truncate\` class(es) checked, every one on an element ` +
    'that can actually truncate',
);
