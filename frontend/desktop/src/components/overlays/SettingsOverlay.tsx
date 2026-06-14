/* ── Settings overlay — replaces the old 12-section dashboard ─────── */
/* Pressed via Cmd+, or the Settings button in the titlebar.            */

import { useEffect, lazy, Suspense, type ComponentType } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  X,
  Heart,
  Users,
  Database,
  Plug,
  Bot,
  Archive as ArchiveIcon,
  Activity,
  Search,
  Brain,
  MessagesSquare,
  Network,
  Boxes,
  TerminalSquare,
  CalendarClock,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { Backdrop } from "@/components/overlays/Backdrop";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "@nanostores/react";
import { $gateway } from "@/store/gateway";
import { Health } from "@/sections/health/Health";
import { Providers } from "@/sections/providers/Providers";
import { Mcp } from "@/sections/mcp/Mcp";
import { Memory } from "@/sections/memory/Memory";
import { August } from "@/sections/august/August";
import { Archive } from "@/sections/archive/Archive";

/* Heavier / newer sections are code-split so they only load when opened. */
const Traffic = lazy(() => import("@/sections/traffic/Traffic").then((m) => ({ default: m.Traffic })));
const Inspector = lazy(() => import("@/sections/inspector/Inspector").then((m) => ({ default: m.Inspector })));
const Conversations = lazy(() => import("@/sections/conversations/Conversations").then((m) => ({ default: m.Conversations })));
const Thinking = lazy(() => import("@/sections/thinking/Thinking").then((m) => ({ default: m.Thinking })));
const Logs = lazy(() => import("@/sections/logs/Logs").then((m) => ({ default: m.Logs })));
const Connections = lazy(() => import("@/sections/connections/Connections").then((m) => ({ default: m.Connections })));
const Models = lazy(() => import("@/sections/models/Models").then((m) => ({ default: m.Models })));
const Agents = lazy(() => import("@/sections/agents/Agents").then((m) => ({ default: m.Agents })));
const Terminal = lazy(() => import("@/sections/terminal/Terminal").then((m) => ({ default: m.Terminal })));
const Automations = lazy(() => import("@/sections/automations/Automations").then((m) => ({ default: m.Automations })));

function SectionFallback() {
  return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
}

interface TabItem {
  key: string;
  label: string;
  Icon: LucideIcon;
  Component: ComponentType<any>;
  /** Group label this tab belongs under. */
  group: SettingGroup;
}

type SettingGroup = "Core" | "Observability" | "AI Workbench" | "MCP & Providers" | "Advanced";

const GROUP_ORDER: SettingGroup[] = [
  "Core",
  "Observability",
  "AI Workbench",
  "MCP & Providers",
  "Advanced",
];

const TABS: TabItem[] = [
  // Core
  { key: "health", label: "Health", Icon: Heart, Component: Health, group: "Core" },
  { key: "providers", label: "Providers", Icon: Users, Component: Providers, group: "MCP & Providers" },
  { key: "memory", label: "Memory", Icon: Database, Component: Memory, group: "Core" },
  { key: "archive", label: "Archive", Icon: ArchiveIcon, Component: Archive, group: "Core" },

  // Observability
  { key: "traffic", label: "Traffic", Icon: Activity, Component: Traffic, group: "Observability" },
  { key: "inspector", label: "Inspector", Icon: Search, Component: Inspector, group: "Observability" },
  { key: "conversations", label: "Conversations", Icon: MessagesSquare, Component: Conversations, group: "Observability" },
  { key: "thinking", label: "Thinking", Icon: Brain, Component: Thinking, group: "Observability" },
  { key: "logs", label: "Logs", Icon: ScrollText, Component: Logs, group: "Observability" },

  // AI Workbench
  { key: "agents", label: "Agents", Icon: Bot, Component: Agents, group: "AI Workbench" },
  { key: "models", label: "Models", Icon: Boxes, Component: Models, group: "AI Workbench" },
  { key: "terminal", label: "Terminal", Icon: TerminalSquare, Component: Terminal, group: "AI Workbench" },
  { key: "automations", label: "Automations", Icon: CalendarClock, Component: Automations, group: "AI Workbench" },
  { key: "connections", label: "Connections", Icon: Network, Component: Connections, group: "AI Workbench" },

  // MCP & Providers
  { key: "mcp", label: "MCP & Skills", Icon: Plug, Component: Mcp, group: "MCP & Providers" },

  // Advanced
  {
    key: "advanced",
    label: "August console",
    Icon: Bot,
    Component: August,
    group: "Advanced",
  },
];

export function SettingsOverlay() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // Back-compat: the old "services" tab maps to "mcp".
  const routeTab = params.get("tab");
  const activeTab = routeTab === "services" ? "mcp" : (routeTab ?? "health");
  const g = useStore($gateway);

  const close = () => {
    const preSettingsPath = sessionStorage.getItem("pre-settings-path") || "/";
    navigate(preSettingsPath);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  return (
    <Backdrop onClose={close}>
      <div className="w-[min(95vw,1100px)] h-[min(90vh,720px)] rounded-xl border border-border bg-card shadow-2xl flex overflow-hidden">
        <aside className="w-56 border-r border-border bg-sidebar text-sidebar-foreground p-3 flex flex-col overflow-hidden">
          <div className="px-2 py-2 mb-2 shrink-0">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <span className="size-6 rounded-md bg-primary text-primary-foreground grid place-items-center text-[10px]">
                A
              </span>
              Settings
            </h2>
            <p className="text-[10px] text-muted-foreground mt-1 font-mono">
              {g.status === "open" ? `running :${g.port || "?"}` : g.status}
            </p>
          </div>
          <nav className="flex-1 space-y-0.5 overflow-y-auto">
            {GROUP_ORDER.map((group) => {
              const groupTabs = TABS.filter(
                (t) => t.group === group && (!("advanced" in t && (t as any).advanced) || g.status === "open"),
              );
              if (groupTabs.length === 0) return null;
              return (
                <div key={group} className="mb-2">
                  <p className="px-2 pt-2 pb-1 text-[9px] uppercase tracking-widest text-muted-foreground/60 font-semibold">
                    {group}
                  </p>
                  {groupTabs.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setParams({ tab: t.key })}
                      className={cn(
                        "w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition",
                        activeTab === t.key
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50",
                      )}
                    >
                      <t.Icon className="size-3.5" />
                      {t.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="pt-2 border-t border-sidebar-border text-[10px] text-muted-foreground font-mono shrink-0">
            <kbd className="rounded border border-sidebar-border bg-muted px-1">
              esc
            </kbd>{" "}
            to close
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-12 border-b border-border px-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <active.Icon className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{active.label}</h3>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={close}
              aria-label="Close settings"
            >
              <X />
            </Button>
          </header>
          <div className="flex-1 overflow-auto">
            <Suspense fallback={<SectionFallback />}>
              <active.Component />
            </Suspense>
          </div>
        </div>
      </div>
    </Backdrop>
  );
}
