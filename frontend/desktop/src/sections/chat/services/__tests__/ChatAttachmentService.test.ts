import { describe, expect, it } from 'vitest';
import {
  ChatAttachmentService,
  LONG_PASTE_CHAR_THRESHOLD,
  LONG_PASTE_LINE_THRESHOLD,
} from '../ChatAttachmentService';

describe('ChatAttachmentService long paste', () => {
  it('treats short text as inline paste', () => {
    expect(ChatAttachmentService.isLongPasteText('hello')).toBe(false);
    expect(ChatAttachmentService.isLongPasteText('a'.repeat(LONG_PASTE_CHAR_THRESHOLD - 1))).toBe(
      false,
    );
  });

  it('converts by character threshold', () => {
    expect(
      ChatAttachmentService.isLongPasteText('a'.repeat(LONG_PASTE_CHAR_THRESHOLD)),
    ).toBe(true);
  });

  it('converts by line threshold even under char limit', () => {
    const lines = Array.from({ length: LONG_PASTE_LINE_THRESHOLD }, (_, i) => `line ${i}`).join(
      '\n',
    );
    expect(lines.length).toBeLessThan(LONG_PASTE_CHAR_THRESHOLD);
    expect(ChatAttachmentService.isLongPasteText(lines)).toBe(true);
  });

  it('builds a text/plain pasted file', () => {
    const body = 'hello\nworld';
    const file = ChatAttachmentService.textFileFromPaste(
      body,
      'pasted-20260101-120000.txt',
    );
    expect(file.name).toBe('pasted-20260101-120000.txt');
    expect(file.type).toBe('text/plain');
    expect(file.size).toBeGreaterThan(0);
  });

  it('names pasted files with a timestamp', () => {
    const name = ChatAttachmentService.pastedTextFilename(
      new Date('2026-07-20T11:51:04Z'),
    );
    expect(name).toMatch(/^pasted-\d{8}-\d{6}\.txt$/);
  });
});
