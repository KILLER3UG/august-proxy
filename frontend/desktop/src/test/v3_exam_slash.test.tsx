/* v3 — /Exam slash command is registered via the voice registry
 *
 * 0.17.0: the composer's built-in command surface was intentionally trimmed
 * to /compact · /init · /btw · /goal (user directive). The exam flow remains
 * reachable through the ExamHost component (ChatThread), so the first test
 * now asserts the trim itself instead of a standalone /exam registration. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('v3 — slash command surface', () => {
  const readSrc = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

  it('builtins.ts keeps only the core four commands (/compact /init /btw /goal)', () => {
    const src = readSrc('../api/voice/builtins.ts');
    for (const id of ['compact', 'init-aug', 'btw', 'goal']) {
      expect(src).toMatch(new RegExp(`id:\\s*['"]${id}['"]`));
    }
    // Trimmed commands must not come back.
    expect(src).not.toMatch(/id:\s*['"]exam['"]/);
    expect(src).not.toMatch(/slashCommand:\s*['"]\/help['"]/);
  });

  it('ChatThread still wires exam activation via ExamHost (component path, not slash)', () => {
    const src = readSrc('../sections/chat/ChatThread.tsx');
    expect(src).toMatch(
      /import\s*\{\s*ExamHost\s*\}\s*from\s*['"]@\/sections\/exam\/ExamHost['"]/,
    );
  });
});
