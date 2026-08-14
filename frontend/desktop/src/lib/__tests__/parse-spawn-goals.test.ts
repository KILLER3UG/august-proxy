import { describe, expect, it } from 'vitest';
import { parseSpawnGoalLine, parseSpawnGoals, previewWaves } from '../parse-spawn-goals';

describe('parseSpawnGoals', () => {
  it('parses bare goals', () => {
    expect(parseSpawnGoalLine('map the repo')).toEqual({ goal: 'map the repo' });
  });

  it('parses name: goal', () => {
    expect(parseSpawnGoalLine('explore: map the repo')).toEqual({
      name: 'explore',
      goal: 'map the repo',
    });
  });

  it('parses dependsOn', () => {
    expect(parseSpawnGoalLine('profile after:setup,explore: measure hot path')).toEqual({
      name: 'profile',
      dependsOn: ['setup', 'explore'],
      goal: 'measure hot path',
    });
  });

  it('previews sequential waves', () => {
    const items = parseSpawnGoals('setup: install\nprofile after:setup: measure');
    expect(previewWaves(items)).toEqual([['setup'], ['profile']]);
  });
});
