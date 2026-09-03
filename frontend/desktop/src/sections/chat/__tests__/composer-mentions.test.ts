/* Bot Mode @-mention middleware (Phase C, OQ8) — annotation only, never a
 * delivery. Pure-function tests: resolve against the roster, append the
 * identification note, and pass unknown handles / emails through untouched. */

import { describe, expect, it } from 'vitest';
import {
  annotateBotMentions,
  botMentionNote,
  resolveBotMentions,
  type ResolvedBotMention,
} from '../composer-mentions';
import type { Bot } from '@/api/api-client/bots';

const bot = (name: string, title: string): Bot =>
  ({ id: `ag_${name}`, name, description: '', uiMeta: { title, avatar: '', hidden: false, groups: [] } }) as Bot;

const roster: Bot[] = [bot('researcher', 'Research Buddy'), bot('coder', 'Coder')];

describe('resolveBotMentions', () => {
  it('resolves a handle by name', () => {
    const r = resolveBotMentions('@researcher look at this', roster);
    expect(r).toHaveLength(1);
    expect(r[0].handle).toBe('researcher');
    expect(r[0].title).toBe('Research Buddy');
  });

  it('resolves by display title (no-space form)', () => {
    const r = resolveBotMentions('ask @ResearchBuddy please', roster);
    expect(r.map((x) => x.handle)).toEqual(['researcher']);
  });

  it('dedupes repeated handles', () => {
    const r = resolveBotMentions('@coder and @coder again', roster);
    expect(r).toHaveLength(1);
  });

  it('passes unknown handles and emails through (no match)', () => {
    expect(resolveBotMentions('@ghost says hi', roster)).toEqual([]);
    expect(resolveBotMentions('mail me at a@b.com', roster)).toEqual([]);
  });
});

describe('annotateBotMentions', () => {
  it('appends the identification note when a handle resolves', () => {
    const out = annotateBotMentions('@researcher summarize this', roster);
    expect(out.startsWith('@researcher summarize this')).toBe(true);
    expect(out).toContain('resolved from the Bot Mode roster');
    expect(out).toContain('never forward');
    expect(out).toContain('message_agent');
  });

  it('leaves text untouched when nothing resolves', () => {
    const text = 'just a normal question @nobody';
    expect(annotateBotMentions(text, roster)).toBe(text);
  });

  it('empty roster → no note', () => {
    expect(botMentionNote([] as ResolvedBotMention[])).toBe('');
    expect(annotateBotMentions('@researcher hi', [])).toBe('@researcher hi');
  });
});
