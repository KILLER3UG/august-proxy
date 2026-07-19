import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRightDrawerSection,
  clearActivityAutoOpenSuppression,
  closeRightDrawer,
  closeRightDrawerSection,
  toggleRightDrawerSection,
  useRightDrawerStore,
} from '../RightDrawerState';

describe('RightDrawerState', () => {
  beforeEach(() => {
    closeRightDrawer({ fromAuto: true });
    clearActivityAutoOpenSuppression();
  });

  it('opens when a section is added', () => {
    addRightDrawerSection('plan');
    const state = useRightDrawerStore.getState();
    expect(state.open).toBe(true);
    expect(state.sections).toEqual(['plan']);
    expect(state.activeSection).toBe('plan');
  });

  it('closes the drawer when the last section is closed', () => {
    addRightDrawerSection('plan');
    addRightDrawerSection('tasks');
    closeRightDrawerSection('plan');
    expect(useRightDrawerStore.getState().sections).toEqual(['tasks']);
    expect(useRightDrawerStore.getState().open).toBe(true);

    closeRightDrawerSection('tasks');
    const state = useRightDrawerStore.getState();
    expect(state.open).toBe(false);
    expect(state.sections).toEqual([]);
    expect(state.activeSection).toBeUndefined();
  });

  it('toggle off of the last section closes the drawer', () => {
    toggleRightDrawerSection('terminal');
    expect(useRightDrawerStore.getState().open).toBe(true);
    toggleRightDrawerSection('terminal');
    expect(useRightDrawerStore.getState().open).toBe(false);
    expect(useRightDrawerStore.getState().sections).toEqual([]);
  });

  it('does not leave an empty open shell', () => {
    addRightDrawerSection('activity');
    closeRightDrawerSection('activity');
    const state = useRightDrawerStore.getState();
    expect(state.open).toBe(false);
    expect(state.sections).toHaveLength(0);
  });

  it('does not auto-reopen Activity after the user dismisses it', () => {
    addRightDrawerSection('activity', { fromAuto: true });
    expect(useRightDrawerStore.getState().open).toBe(true);

    closeRightDrawer();
    expect(useRightDrawerStore.getState().open).toBe(false);
    expect(useRightDrawerStore.getState().activityAutoOpenSuppressed).toBe(true);

    addRightDrawerSection('activity', { fromAuto: true });
    expect(useRightDrawerStore.getState().open).toBe(false);
    expect(useRightDrawerStore.getState().sections).toEqual([]);
  });

  it('allows manual Activity open after dismiss', () => {
    addRightDrawerSection('activity', { fromAuto: true });
    closeRightDrawerSection('activity');
    expect(useRightDrawerStore.getState().activityAutoOpenSuppressed).toBe(true);

    addRightDrawerSection('activity');
    const state = useRightDrawerStore.getState();
    expect(state.open).toBe(true);
    expect(state.sections).toEqual(['activity']);
    expect(state.activityAutoOpenSuppressed).toBe(false);
  });

  it('system close of Activity does not suppress the next auto-open', () => {
    addRightDrawerSection('activity', { fromAuto: true });
    closeRightDrawerSection('activity', { fromAuto: true });
    clearActivityAutoOpenSuppression();

    addRightDrawerSection('activity', { fromAuto: true });
    expect(useRightDrawerStore.getState().open).toBe(true);
    expect(useRightDrawerStore.getState().sections).toEqual(['activity']);
  });
});
