/* ── EditRailRow — the receipt tone contract, on the edit path ──────────────
 * ToolStepRow already splits a settled error row into `failure` (red) and
 * `denial` (muted), and the backend decides that from the receipt's own marker
 * (`tool_protocol.RECEIPT_TONE`). An edit-class tool does not render through
 * ToolStepRow — AssistantBlockTimeline routes it here — so the same rule has to
 * hold in this component too, or a `[Blocked]` edit comes back screaming red
 * while the identical `[Blocked]` read sits quietly.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { EditRailRow } from '../EditRailRow';
import type { ToolEntry } from '@/components/chat/ToolCallItem';

function editTool(tone?: 'failure' | 'denial'): ToolEntry {
  const t: Record<string, unknown> = {
    id: 'edit-1',
    name: 'edit_file',
    status: 'error',
    context: JSON.stringify({ filePath: 'C:/proj/src/a.ts' }),
    error:
      tone === 'denial'
        ? '[Blocked] path escapes the workspace'
        : '[Validation Error] missing "filePath"',
  };
  if (tone) t.tone = tone;
  return t as unknown as ToolEntry;
}

function glyphClass(tool: ToolEntry): string {
  const { container } = render(<EditRailRow tool={tool} expanded={false} />);
  const glyph = container.querySelector('.rail-glyph');
  if (!glyph) throw new Error('no .rail-glyph rendered');
  return glyph.getAttribute('class') ?? '';
}

describe('EditRailRow — receipt tone', () => {
  it('a failure tone renders red', () => {
    expect(glyphClass(editTool('failure'))).toContain('text-danger');
  });

  it('a denial tone is muted, not red', () => {
    expect(glyphClass(editTool('denial'))).not.toContain('text-danger');
  });

  it('a row with no tone still renders red — an unknown error looks like an error', () => {
    // History stored before tone existed, and any frame that omits it. Absence
    // means loud, exactly as in ToolStepRow; the marker text is never re-matched.
    expect(glyphClass(editTool(undefined))).toContain('text-danger');
  });

  it('a settled success is not tinted by tone at all', () => {
    const done = {
      ...editTool('failure'),
      status: 'done',
    } as unknown as ToolEntry;
    expect(glyphClass(done)).not.toContain('text-danger');
  });
});
