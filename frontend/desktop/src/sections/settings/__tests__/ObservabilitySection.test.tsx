/* ── ObservabilitySection test (RTL + jsdom) ─────────────────────────── */
/* This is the first RTL render in the codebase. It establishes the pattern:
 *   1. Mock all data hooks with vi.mock at the top.
 *   2. Render the section with <ObservabilitySection />.
 *   3. Use screen.findBy* / getByRole to assert.
 *
 * The test exercises the orchestrator's subtab switching, the
 * SettingsTabs aria-role, and the Overview tab's empty-state when data
 * fails to load.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock react-query's data hooks. We use a controllable data shape per test.
const mockOverviewData = {
    range: '30d' as const,
    audit: { count: 0, byCategory: {}, byResult: {}, byActor: {}, byCritical: { true: 0, false: 0, null: 0 }, at: new Date().toISOString() },
    rollback: { available: 0, undone: 0, failed: 0, total: 0, byType: {}, at: new Date().toISOString() },
    appPolicy: { policies: {}, counts: { allow: 0, ask: 0, deny: 0 }, defaultPolicy: 'ask' as const },
    hostAgent: { status: 'disconnected' as const, lastComputerActionAt: null, lastComputerAction: null, lastComputerTarget: null, lastObservationAt: null, lastObservedApp: null, postObservationCount: 0, at: new Date().toISOString() },
    at: new Date().toISOString()
};

const mockUsage = {
    range: '30d',
    totalTokens: 0,
    sessions: 0,
    messages: 0,
    activeDays: 0,
    currentStreak: 0,
    favoriteModel: 'MiniMax-M3',
    favoriteModelShare: 0.42,
    at: new Date().toISOString()
};

const mockByDay = { results: [] as Array<{ date: string; tokens: number }> };
const mockByModel = { results: [] as Array<{ model: string; tokens: number; percent: number }> };

let overviewMock: any = { data: mockOverviewData, isLoading: false };
let usageMock: any = { data: mockUsage, isLoading: false };
let byDayMock: any = { data: mockByDay, isLoading: false };
let byModelMock: any = { data: mockByModel, isLoading: false };

vi.mock('@tanstack/react-query', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@tanstack/react-query')>();
    return {
        ...actual,
        useQuery: (opts: any) => {
            const key = JSON.stringify(opts.queryKey);
            if (key.includes('observability')) return overviewMock;
            if (key.includes('usage') && key.includes('stats')) return usageMock;
            if (key.includes('byDay')) return byDayMock;
            if (key.includes('byModel')) return byModelMock;
            return { data: null, isLoading: false };
        }
    };
});

// Mock toast (sonner) to no-op so we don't have to deal with portals.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ObservabilitySection } from '../ObservabilitySection';

beforeEach(() => {
    overviewMock = { data: mockOverviewData, isLoading: false };
    usageMock = { data: mockUsage, isLoading: false };
    byDayMock = { data: mockByDay, isLoading: false };
    byModelMock = { data: mockByModel, isLoading: false };
});

describe('ObservabilitySection', () => {
    it('renders the page header and default Overview subtab', async () => {
        render(<ObservabilitySection />);
        expect(screen.getByRole('heading', { name: /observability/i, level: 1 })).toBeInTheDocument();
        // SettingsTabs renders a tablist
        const tablist = screen.getByRole('tablist');
        expect(tablist).toBeInTheDocument();
        // The four subtab buttons exist
        for (const label of ['Overview', 'Audit', 'Rollback', 'Observations']) {
            expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
        }
        // Default selected is Overview
        expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    });

    it('switches to the Audit subtab when clicked', async () => {
        render(<ObservabilitySection />);
        fireEvent.click(screen.getByRole('tab', { name: 'Audit' }));
        await waitFor(() => {
            expect(screen.getByRole('tab', { name: 'Audit' })).toHaveAttribute('aria-selected', 'true');
        });
        // The filter bar should be present
        expect(screen.getByLabelText(/category filter/i)).toBeInTheDocument();
    });

    it('shows an empty state on Overview when data fails to load', () => {
        overviewMock = { data: undefined, isLoading: false };
        render(<ObservabilitySection />);
        expect(screen.getByText(/could not load observability overview/i)).toBeInTheDocument();
    });

    it('renders the status pill with the right variant for host-agent disconnected', () => {
        render(<ObservabilitySection />);
        // The host-agent status text should be 'disconnected' (lowercased)
        expect(screen.getAllByText(/disconnected/i).length).toBeGreaterThan(0);
    });
});
