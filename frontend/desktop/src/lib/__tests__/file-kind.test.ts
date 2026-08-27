import { describe, it, expect } from 'vitest';
import { classifyFileKind } from '../file-kind';

describe('classifyFileKind (plan §4.5)', () => {
  it('classifies code files', () => {
    expect(classifyFileKind('app/main.py')).toMatchObject({ kind: 'code', label: 'PY' });
    expect(classifyFileKind('src/x.ts')).toMatchObject({ kind: 'code', label: 'TS' });
    expect(classifyFileKind('data.json')).toMatchObject({ kind: 'code', label: 'JSON' });
  });

  it('adds text/document kinds so .md reads Document · MD', () => {
    expect(classifyFileKind('notes.md')).toMatchObject({
      kind: 'document',
      label: 'Document · MD',
      badgeText: 'M↓',
    });
    expect(classifyFileKind('README.txt')).toMatchObject({
      kind: 'document',
      label: 'Document · TXT',
      badgeText: 'T↓',
    });
  });

  it('keeps office kind labels with the down-arrow glyph convention', () => {
    expect(classifyFileKind('deck.pptx')).toMatchObject({
      kind: 'document',
      label: 'Presentation · PPTX',
      badgeText: 'P↓',
    });
    expect(classifyFileKind('book.xlsx')).toMatchObject({
      kind: 'document',
      label: 'Spreadsheet · XLSX',
      badgeText: 'X↓',
    });
    expect(classifyFileKind('doc.docx')).toMatchObject({
      kind: 'document',
      label: 'Document · DOCX',
      badgeText: 'D↓',
    });
    expect(classifyFileKind('page.html')).toMatchObject({
      kind: 'document',
      label: 'Interactive · HTML',
      badgeText: 'H↓',
    });
  });

  it('classifies image, video, and pdf kinds', () => {
    expect(classifyFileKind('shot.png')).toMatchObject({
      kind: 'image',
      label: 'Image · PNG',
      badgeText: 'IMG',
    });
    expect(classifyFileKind('clip.mp4')).toMatchObject({
      kind: 'video',
      label: 'Video · MP4',
      badgeText: 'VID',
    });
    expect(classifyFileKind('paper.pdf')).toMatchObject({
      kind: 'pdf',
      label: 'PDF',
      badgeText: 'PDF',
    });
  });

  it('handles extensionless and backslash paths', () => {
    expect(classifyFileKind('Makefile')).toMatchObject({ kind: 'code', label: 'File' });
    expect(classifyFileKind('C:\\out\\notes.md')).toMatchObject({ kind: 'document' });
  });
});
