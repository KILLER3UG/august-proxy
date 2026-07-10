/**
 * CalendarCard — Inline week-view calendar for voice commands.
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 * Uses VoiceCommandCardProps so it plugs into the registry.
 *
 * Data sources:
 * - August internal events via GET /api/calendar/internal
 * - External events via useMcpTools (filters tools matching calendar.* patterns)
 * - If no MCP calendar server configured, shows only internal events with a hint
 */

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, X } from 'lucide-react';
import { useMcpTools, type McpTool } from '@/hooks/useMcpTools';
import type { VoiceCommandCardProps } from '@/api/voice/registry';

// ── Types ──────────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  title: string;
  date: string; // ISO date YYYY-MM-DD
  kind: 'task' | 'reminder' | 'scheduled_chat' | 'external';
  source: 'internal' | 'mcp';
}

// ── Date helpers ───────────────────────────────────────────────────────────

function getWeekDates(weekOffset: number): Date[] {
  const now = new Date();
  const dayOfWeek = now.getDay();
  // Monday-based week (Mon=1, Tue=2, ..., Sun=0 via JS getDay)
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset + weekOffset * 7);
  monday.setHours(0, 0, 0, 0);

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isToday(d: Date): boolean {
  return dateKey(d) === dateKey(new Date());
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── Card component ─────────────────────────────────────────────────────────

export function CalendarCard({ onDismiss }: VoiceCommandCardProps) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { tools } = useMcpTools();

  const hasCalendarMcp = tools.some(
    (t: McpTool) =>
      t.name.includes('calendar') ||
      t.name.includes('gcal') ||
      t.name.includes('events'),
  );

  // Fetch internal events on mount.
  useEffect(() => {
    fetch('/api/calendar/internal')
      .then(r => r.json())
      .then(data => {
        setEvents(data.events ?? []);
        setLoading(false);
      })
      .catch((_err) => {
        setError('Failed to load events');
        setLoading(false);
      });
  }, []);

  const weekDates = getWeekDates(weekOffset);
  const weekStart = formatDate(weekDates[0]);
  const weekEnd = formatDate(weekDates[6]);

  const eventsByDay = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = ev.date;
    if (!eventsByDay.has(key)) eventsByDay.set(key, []);
    eventsByDay.get(key)!.push(ev);
  }

  const _todayKey = dateKey(new Date());

  return (
    <div
      data-slot="calendar-card"
      className="rounded-lg border border-border bg-card p-4 space-y-3 max-w-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">
            {weekStart} — {weekEnd}
          </span>
        </div>
        <button
          onClick={onDismiss}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
          aria-label="Close calendar"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="text-xs text-muted-foreground py-4 text-center">
          Loading events…
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="text-xs text-red-500 py-2 text-center">{error}</div>
      )}

      {/* Week grid */}
      {!loading && !error && (
        <div className="grid grid-cols-7 gap-1">
          {DAY_NAMES.map(name => (
            <div
              key={name}
              className="text-[10px] uppercase text-muted-foreground text-center font-semibold py-1"
            >
              {name}
            </div>
          ))}
          {weekDates.map(d => {
            const key = dateKey(d);
            const dayEvents = eventsByDay.get(key) ?? [];
            const today = isToday(d);

            return (
              <div
                key={key}
                className={`rounded p-1.5 min-h-[60px] border text-xs ${
                  today
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background'
                }`}
              >
                <div
                  className={`text-[11px] font-medium mb-1 ${
                    today ? 'text-primary' : 'text-foreground'
                  }`}
                >
                  {d.getDate()}
                </div>
                {dayEvents.slice(0, 3).map(ev => (
                  <div
                    key={ev.id}
                    className={`text-[10px] leading-tight truncate rounded px-0.5 mb-0.5 ${
                      ev.source === 'internal'
                        ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                        : 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                    }`}
                    title={ev.title}
                  >
                    {ev.title}
                  </div>
                ))}
                {dayEvents.length > 3 && (
                  <div className="text-[9px] text-muted-foreground">
                    +{dayEvents.length - 3} more
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Week navigation */}
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={() => setWeekOffset(o => o - 1)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3" />
          <span>Prev week</span>
        </button>

        <button
          type="button"
          onClick={() => setWeekOffset(0)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Today
        </button>

        <button
          type="button"
          onClick={() => setWeekOffset(o => o + 1)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <span>Next week</span>
          <ChevronRight className="size-3" />
        </button>
      </div>

      {/* No MCP calendar hint */}
      {!loading && !error && !hasCalendarMcp && (
        <div className="text-[11px] text-muted-foreground text-center border-t border-border pt-2 mt-1">
          No internal events. Connect a calendar MCP server to see external events.
        </div>
      )}
    </div>
  );
}
