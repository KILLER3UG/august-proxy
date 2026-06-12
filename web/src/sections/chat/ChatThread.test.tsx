import { describe, expect, it } from 'vitest';
import { getModelDisplayName, isLikelyReasoningModel } from './ChatThread';

describe('chat model display', () => {
  it('strips provider prefixes from backend model ids', () => {
    expect(getModelDisplayName('opencode-go/claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(getModelDisplayName('openai-api:gpt-4o')).toBe('gpt-4o');
  });

  it('keeps plain model ids unchanged', () => {
    expect(getModelDisplayName('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('marks reasoning-capable models for thinking UI', () => {
    expect(isLikelyReasoningModel('claude-sonnet-4-6')).toBe(true);
    expect(isLikelyReasoningModel('gpt-4o')).toBe(false);
  });
});
