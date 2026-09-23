import { describe, it, expect } from 'vitest';
import { safeExternalHref } from '../safe-href';

describe('safeExternalHref', () => {
  it('passes web URLs through unchanged', () => {
    expect(safeExternalHref('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(safeExternalHref('http://example.com')).toBe('http://example.com');
  });

  it('treats relative and fragment links as safe', () => {
    expect(safeExternalHref('/docs/intro')).toBe('/docs/intro');
    expect(safeExternalHref('#section')).toBe('#section');
    expect(safeExternalHref('notes.html')).toBe('notes.html');
  });

  it('drops script-bearing and local-file schemes', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///C:/Windows/win.ini',
    ]) {
      expect(safeExternalHref(bad), bad).toBeNull();
    }
  });

  it('catches control-character scheme obfuscation', () => {
    // Browsers strip tabs/newlines from URLs before resolving the scheme.
    expect(safeExternalHref('java\tscript:alert(1)')).toBeNull();
    expect(safeExternalHref('java\nscript:alert(1)')).toBeNull();
    expect(safeExternalHref('  javascript:alert(1)  ')).toBeNull();
  });

  it('handles empty and non-string input', () => {
    expect(safeExternalHref('')).toBeNull();
    expect(safeExternalHref('   ')).toBeNull();
    expect(safeExternalHref(null)).toBeNull();
    expect(safeExternalHref(undefined)).toBeNull();
    expect(safeExternalHref(42)).toBeNull();
  });

  it('does not mistake a colon in a path for a scheme', () => {
    expect(safeExternalHref('/search?q=a:b')).toBe('/search?q=a:b');
  });
});
