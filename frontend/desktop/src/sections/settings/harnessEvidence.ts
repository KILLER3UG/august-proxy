/* ── harness evidence parsing ──────────────────────────────────────────────
 * Extracted from HarnessImprovementsSection so the pure parser is not exported
 * from a component module (react-refresh requires one component per file), the
 * same way the sibling helper modules here are plain .ts.
 *
 * The scheduled passes build evidence as "Section header:" lines followed by
 * "- item" bullets (refine_store.build_scheduled_evidence,
 * harness_self_improve._run_scheduled_pass). As raw text it is a wall the
 * reviewer skims past; as chips each datum is a scannable unit. Text that
 * does not parse into that shape (prose from the memory queue, hand-written
 * observations) falls back to the old block — the parser must never eat or
 * reorder evidence a human is deciding on.
 */

export interface EvidenceSection {
  title: string;
  items: string[];
}

export interface EvidenceParse {
  sections: EvidenceSection[];
  structured: boolean;
}

export function parseEvidence(body: string): EvidenceParse {
  const lines = (body || '').split(/\r?\n/);
  const sections: EvidenceSection[] = [];
  let current: EvidenceSection = { title: '', items: [] };
  let sawBullet = false;
  let bulletChars = 0;
  let prose = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('- ')) {
      sawBullet = true;
      bulletChars += line.length;
      current.items.push(line.slice(2).trim());
    } else if (line.endsWith(':') && line.length <= 120) {
      if (current.items.length) sections.push(current);
      current = { title: line.slice(0, -1).trim(), items: [] };
    } else {
      prose += line.length;
      current.items.push(line);
    }
  }
  if (current.items.length) sections.push(current);
  // Structured = bullets exist and the text isn't mostly non-bullet prose.
  const structured = sawBullet && bulletChars >= prose;
  return { sections, structured };
}
