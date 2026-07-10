/**
 * Tests for the /init slash command + AUG.md event flow.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Importing builtins registers all default commands on the singleton registry.
import '@/api/voice/builtins';
import { voiceCommandRegistry } from '@/api/voice/registry';
import { voiceCommandEvents } from '@/api/voice/registry-events';

describe('/init command registration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const ctx = (args: string) => ({
    sessionId: 's1',
    transcript: '/init ' + args,
    args,
    messages: [],
    setMessages: vi.fn(),
  });

  it('registers /init with the expected slash command and triggers', () => {
    const cmd = voiceCommandRegistry.getBySlashCommand('/init');
    expect(cmd).not.toBeNull();
    expect(cmd!.id).toBe('init-aug');
    expect(cmd!.description.toLowerCase()).toContain('aug.md');
    expect(cmd!.triggers).toEqual(
      expect.arrayContaining(['init', 'initialize', 'set up project', 'aug init']),
    );
  });

  it('emits an init-aug event when invoked', () => {
    const cmd = voiceCommandRegistry.getBySlashCommand('/init')!;
    const spy = vi.fn();
    const unsub = voiceCommandEvents.subscribe(spy);
    void cmd.handler(ctx(''));
    unsub();
    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0][0];
    expect(event.type).toBe('init-aug');
  });

  it('passes the workspace path argument through', () => {
    const cmd = voiceCommandRegistry.getBySlashCommand('/init')!;
    const spy = vi.fn();
    const unsub = voiceCommandEvents.subscribe(spy);
    void cmd.handler(ctx('/some/path'));
    unsub();
    expect(spy.mock.calls[0][0].workspacePath).toBe('/some/path');
  });
});

describe('aug event types', () => {
  it('init-aug / aug-preview / aug-saved are valid event shapes', () => {
    const spy = vi.fn();
    const unsub = voiceCommandEvents.subscribe(spy);
    voiceCommandEvents.emit({ type: 'init-aug', workspacePath: '/w' });
    voiceCommandEvents.emit({ type: 'aug-preview', draft: '# x', existing: true, workspacePath: '/w' });
    voiceCommandEvents.emit({ type: 'aug-saved', path: '/w/AUG.md' });
    unsub();
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
