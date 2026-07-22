import { describe, expect, it } from 'vitest';
import {
  applyCarriageReturns,
  formatCommandOutputForDisplay,
} from '../CommandOutputPane';

describe('applyCarriageReturns', () => {
  it('keeps the last progress segment on a line', () => {
    const raw = 'Downloading a\rDownloading b (50%)\rDownloading b (100%)\nDone\n';
    expect(applyCarriageReturns(raw)).toBe('Downloading b (100%)\nDone\n');
  });
});

describe('formatCommandOutputForDisplay', () => {
  it('strips sandbox tags and exit code trailer', () => {
    const raw =
      '[sandbox:soft|sandboxed] Looking in indexes: https://example.com\nExit code: 1';
    const out = formatCommandOutputForDisplay(raw);
    expect(out.body).toBe('Looking in indexes: https://example.com');
    expect(out.exitCode).toBe(1);
    expect(out.failed).toBe(true);
  });

  it('softens STDERR header', () => {
    const out = formatCommandOutputForDisplay('ok\nSTDERR:\nbad');
    expect(out.body).toContain('Errors:');
    expect(out.body).not.toContain('STDERR:');
  });
});
