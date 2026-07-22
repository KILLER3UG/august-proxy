/* ── Calendar events (React Query) ────────────────────────────────────── */
/* Fetches internal calendar events from /api/calendar/internal */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface CalendarEvent {
  id: string;
  title: string;
  date: string; // ISO date YYYY-MM-DD
  kind: 'task' | 'reminder' | 'scheduled_chat' | 'external';
  source: 'internal' | 'mcp';
}

export interface CalendarResponse {
  events: CalendarEvent[];
  status?: string;
  hint?: string;
}

export function useCalendarEvents() {
  return useQuery<CalendarResponse>({
    queryKey: ['calendar-events'],
    queryFn: async () => {
      return api.get<CalendarResponse>('/api/calendar/internal');
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
