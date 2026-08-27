import { describe, expect, it } from 'vitest';
import { commandErrorOneLiner } from '../command-error-line';

describe('commandErrorOneLiner', () => {
  it('returns null for empty output', () => {
    expect(commandErrorOneLiner('')).toBeNull();
    expect(commandErrorOneLiner(null)).toBeNull();
    expect(commandErrorOneLiner('   \n  ')).toBeNull();
  });

  it('prefers the structured pytest digest', () => {
    const out = [
      'collected 5 items',
      'test_a.py::test_ok PASSED',
      'test_a.py::test_bad FAILED',
      'AssertionError: expected 200, got 500',
      '===== 1 failed, 1 passed in 0.42s =====',
    ].join('\n');
    expect(commandErrorOneLiner(out)).toBe('1 failed, 1 passed in 0.42s');
  });

  it('takes the first error-looking line when no digest exists', () => {
    const out = [
      'loading config',
      'starting server',
      'ModuleNotFoundError: No module named "fastapi"',
      'shutting down',
    ].join('\n');
    expect(commandErrorOneLiner(out)).toBe(
      'ModuleNotFoundError: No module named "fastapi"',
    );
  });

  it('surfaces the exception line of a python traceback, not the header', () => {
    const out = [
      'Traceback (most recent call last):',
      '  File "app.py", line 3, in <module>',
      '    do_thing()',
      'ValueError: bad thing',
    ].join('\n');
    expect(commandErrorOneLiner(out)).toBe('ValueError: bad thing');
  });

  it('falls back to the last non-empty line', () => {
    const out = ['building...', 'compiling...', 'make: *** [all] Error 2'];
    expect(commandErrorOneLiner(out.join('\n'))).toBe('make: *** [all] Error 2');
  });

  it('caps at 120 chars with an ellipsis', () => {
    const long = `AssertionError: ${'x'.repeat(300)}`;
    const line = commandErrorOneLiner(long)!;
    expect(line.length).toBe(120);
    expect(line.endsWith('…')).toBe(true);
  });

  it('is idempotent on an already-extracted one-liner', () => {
    const digest = '1 failed, 1 passed in 0.42s';
    expect(commandErrorOneLiner(digest)).toBe(digest);
  });

  it('strips ANSI escapes before extracting', () => {
    const out = '\x1b[31mERROR: boom\x1b[0m\nbye';
    expect(commandErrorOneLiner(out)).toBe('ERROR: boom');
  });
});
