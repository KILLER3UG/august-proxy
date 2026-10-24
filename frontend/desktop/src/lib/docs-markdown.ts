/* docs-markdown — the two source-level transforms the docs reader applies.
 *
 * These live apart from `DocsPage` because they are pure functions over a
 * document string, and the fast-refresh rule (rightly) wants a component module
 * to export components. Keeping them here also makes them reachable to a probe
 * without mounting the page. */

export interface Segment {
  kind: 'text' | 'diagram';
  value: string;
}

/** Same fence shape the backend counts in `docs_state._MERMAID_BLOCK_RE`, so
 *  the reader and the validator agree on what a diagram is. A fence the
 *  validator counted but the reader did not lift would render as a code block. */
const MERMAID_FENCE = /^```[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n^[ \t]*```[ \t]*$/m;

/** The authored text under a heading, up to the next heading of the same or a
 *  higher level.
 *
 *  `diagramDetails` points at a heading in the same document rather than
 *  copying prose into metadata, and the contract says the browser shows that
 *  content. Returning the heading's own section is what makes the panel show
 *  something instead of telling the reader to go find it.
 *
 *  Matching is trimmed and case-insensitive because the mapping is authored by
 *  hand next to a heading written by hand; the validator already refuses a
 *  `diagramDetails` target that is not one of the document's headings, so this
 *  only has to be forgiving about whitespace, not about existence.
 */
export function extractSection(body: string, heading: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const wanted = heading.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim().toLowerCase() === wanted) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return '';
  const collected: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) break;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

/** Split a document into markdown and diagram segments, in source order. */
export function splitMermaidSegments(body: string): Segment[] {
  const segments: Segment[] = [];
  let rest = body.replace(/\r\n/g, '\n');
  while (rest.length > 0) {
    const match = MERMAID_FENCE.exec(rest);
    if (!match || match.index === undefined) {
      segments.push({ kind: 'text', value: rest });
      break;
    }
    const before = rest.slice(0, match.index);
    if (before.trim()) segments.push({ kind: 'text', value: before });
    segments.push({ kind: 'diagram', value: match[1] });
    rest = rest.slice(match.index + match[0].length);
  }
  return segments;
}

/** Drop a document's own leading `# Title` when it repeats the frontmatter
 *  title. The format carries both and the page renders the frontmatter one as
 *  its h1, so leaving the body heading in place showed the same sentence twice
 *  in the first browser pass.
 *
 *  Only the first non-blank heading is considered, and only when it matches, so
 *  a page that opens on a different heading keeps it. */
export function stripDuplicateTitle(body: string, title: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return lines.slice(i).join('\n');
    if (match[1].trim().toLowerCase() === title.trim().toLowerCase()) {
      return lines.slice(i + 1).join('\n');
    }
    return lines.slice(i).join('\n');
  }
  return body;
}
