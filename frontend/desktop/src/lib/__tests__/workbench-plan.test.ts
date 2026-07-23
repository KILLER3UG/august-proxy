import { describe, it, expect } from 'vitest';
import type { WorkbenchPlan } from '@/types/workbench';
import {
  hasPendingWorkbenchPlan,
  isNonEmptyPlan,
  normalizeWorkbenchSession,
  planBodyText,
} from '../workbench-plan';

describe('workbench-plan helpers', () => {
  it('rejects empty / boolean / null plans', () => {
    expect(isNonEmptyPlan(null)).toBe(false);
    expect(isNonEmptyPlan(undefined)).toBe(false);
    expect(isNonEmptyPlan({})).toBe(false);
    expect(isNonEmptyPlan(true)).toBe(false);
    expect(isNonEmptyPlan({ summary: 'do the thing' })).toBe(true);
  });

  it('does not treat empty {} as a pending plan', () => {
    expect(
      hasPendingWorkbenchPlan({
        plan: {} as never,
        approved: false,
        approvedAt: null,
      }),
    ).toBe(false);
  });

  it('hides banner when planApproved is set (backend field)', () => {
    expect(
      hasPendingWorkbenchPlan({
        plan: { summary: 'x', id: 'p1', steps: [], files: [], risks: [], verification: [], createdAt: '' },
        approved: false,
        approvedAt: null,
        planApproved: true,
      }),
    ).toBe(false);
  });

  it('normalizes backend planApproved onto approved and clears empty plan', () => {
    const normalized = normalizeWorkbenchSession({
      id: 'wb_1',
      provider: 'claude',
      agentId: 'plan',
      plan: {},
      planApproved: true,
      approved: false,
      approvedAt: null,
    });
    expect(normalized?.plan).toBeNull();
    expect(normalized?.approved).toBe(true);
    expect(normalized?.planApproved).toBe(true);
  });
});

describe('planBodyText', () => {
  const base: WorkbenchPlan = {
    id: 'p1',
    summary: '',
    steps: [],
    files: [],
    risks: [],
    verification: [],
    createdAt: '',
  };

  it('falls back to the backend `plan` text key', () => {
    // Shape the backend actually stores from submit_plan({ plan: "..." }).
    expect(planBodyText({ ...base, plan: 'do the thing' })).toBe('do the thing');
  });

  it('prefers markdown > summary > plan', () => {
    expect(planBodyText({ ...base, summary: 'sum', plan: 'raw', markdown: 'md' })).toBe('md');
    expect(planBodyText({ ...base, summary: 'sum', plan: 'raw' })).toBe('sum');
  });

  it('returns null when no text field is present', () => {
    expect(planBodyText({ ...base })).toBeNull();
    expect(planBodyText(null)).toBeNull();
  });
});
