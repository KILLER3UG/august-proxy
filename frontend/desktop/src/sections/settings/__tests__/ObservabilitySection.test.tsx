/* ── ObservabilitySection test (RTL + jsdom) ─────────────────────────── */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

let overviewMock: { data: unknown; isLoading: boolean } = { data: mockOverviewData, isLoading: false };
let usageMock: { data: unknown; isLoading: boolean } = { data: mockUsage, isLoading: false };
let byDayMock: { data: unknown; isLoading: boolean } = { data: mockByDay, isLoading: false };
let byModelMock: { data: unknown; isLoading: boolean } = { data: mockByModel, isLoading: false };

vi.mock('@tanstack/react-query', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@tanstack/react-query')>();
    return {
        ...actual,
        useQuery: (opts: { queryKey?: unknown }) => {
            const key = JSON.stringify(opts.queryKey);
            if (key.includes('observability')) return overviewMock;
            if (key.includes('usage') && key.includes('stats')) return usageMock;
            if (key.includes('byDay')) return byDayMock;
            if (key.includes('byModel')) return byModelMock;
            return { data: null, isLoading: false };
        }
    };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ObservabilitySection } from '../ObservabilitySection';

beforeEach(() => {
    overviewMock = { data: mockOverviewData, isLoading: false };
    usageMock = { data: mockUsage, isLoading: false };
    byDayMock = { data: mockByDay, isLoading: false };
    byModelMock = { data: mockByModel, isLoading: false };
});

function tab(name: string) {
    // Vertical SettingsTabs include description text in the accessible name.
    return screen.getByRole('tab', { name: new RegExp(`^${name}\\b`, 'i') });
}

describe('ObservabilitySection', () => {
    it('renders the page header and default Overview subtab', () => {
        render(<ObservabilitySection />);
        expect(screen.getByRole('heading', { name: /observability/i, level: 1 })).toBeInTheDocument();
        expect(screen.getByRole('tablist')).toBeInTheDocument();
        for (const label of ['Overview', 'Audit', 'Rollback', 'Observations']) {
            expect(tab(label)).toBeInTheDocument();
        }
        expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    });

    it('switches to the Audit subtab when clicked', async () => {
        render(<ObservabilitySection />);
        fireEvent.click(tab('Audit'));
        await waitFor(() => {
            expect(tab('Audit')).toHaveAttribute('aria-selected', 'true');
        });
        expect(screen.getByLabelText(/category filter/i)).toBeInTheDocument();
    });

    it('shows an empty state on Overview when data fails to load', () => {
        overviewMock = { data: undefined, isLoading: false };
        render(<ObservabilitySection />);
        expect(screen.getByText(/could not load observability overview/i)).toBeInTheDocument();
    });

    it('renders the status pill with the right variant for host-agent disconnected', () => {
        render(<ObservabilitySection />);
        expect(screen.getAllByText(/disconnected/i).length).toBeGreaterThan(0);
    });

    it('renders all 6 subtabs in the tablist', () => {
        render(<ObservabilitySection />);
        for (const label of ['Overview', 'Audit', 'Rollback', 'Observations', 'Traffic', 'Logs']) {
            expect(tab(label)).toBeInTheDocument();
        }
    });

    it('switches to the Traffic subtab and shows the period filter chips', async () => {
        render(<ObservabilitySection />);
        fireEvent.click(tab('Traffic'));
        await waitFor(() => {
            expect(tab('Traffic')).toHaveAttribute('aria-selected', 'true');
        });
        expect(screen.getByText(/^Period$/i)).toBeInTheDocument();
    });

    it('switches to the Logs subtab and shows the level filter chips', async () => {
        render(<ObservabilitySection />);
        fireEvent.click(tab('Logs'));
        await waitFor(() => {
            expect(tab('Logs')).toHaveAttribute('aria-selected', 'true');
        });
        const buttons = screen.getAllByRole('button');
        const labels = buttons.map((b) => b.textContent?.trim());
        expect(labels).toEqual(expect.arrayContaining(['All', 'Info', 'Warn', 'Error']));
    });
});
