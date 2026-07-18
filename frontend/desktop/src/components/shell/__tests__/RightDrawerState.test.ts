import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRightDrawerSection,
  closeRightDrawer,
  closeRightDrawerSection,
  toggleRightDrawerSection,
  useRightDrawerStore,
} from '../RightDrawerState';

describe('RightDrawerState', () => {
  beforeEach(() => {
    closeRightDrawer();
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
});
