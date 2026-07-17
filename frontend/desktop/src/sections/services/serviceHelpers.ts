/**
 * Normalizes API payloads and formats display values for the Services dashboard
 * (MCP server rows, OAuth scope labels, env KEY=VALUE editors, status badges).
 */
import {
  AlertCircle,
  CheckCircle2,
  Github,
  Link,
  Loader2,
  Mail,
  MessageCircle,
  PauseCircle,
  PlayCircle,
} from "lucide-react";
import type {
  McpServer,
  ServiceConnection,
  ServiceName,
  ServiceStatus,
} from "./types";

/** Placeholder account cards when the connections API has not returned yet. */
export const FALLBACK_SERVICES: ServiceConnection[] = [
  {
    name: "google",
    label: "Google Workspace",
    description:
      "Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts",
    services: [
      "Gmail read",
      "Gmail send",
      "Calendar",
      "Drive",
      "Docs",
      "Sheets",
      "Slides",
      "Tasks",
      "Contacts",
    ],
    scopes: [
      "gmail.read",
      "gmail.send",
      "calendar",
      "drive",
      "docs",
      "sheets",
      "slides",
      "tasks",
      "contacts",
    ],
    status: "connected",
    connected: true,
    account: "robertacepayales69@gmail.com",
  },
  {
    name: "github",
    label: "GitHub",
    description: "Repository access, PRs, issues, releases",
    services: ["Repositories", "Pull requests", "Issues", "Gists"],
    scopes: ["repo", "read:user", "workflow", "gist"],
    status: "connected",
    connected: true,
    account: "rober-cepayales",
  },
  {
    name: "slack",
    label: "Slack",
    description: "Messaging, channels, workspace tools",
    services: ["Channels", "Messages", "Files", "Workspace"],
    scopes: [],
    status: "disconnected",
    connected: false,
  },
];

/** Safely stringify an unknown value, avoiding the default `[object Object]`
 *  coercion for non-primitive values. */
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

/** Normalize Python /api/mcp/servers rows for the UI. */
export function normalizeMcpServer(raw: Record<string, unknown>): McpServer {
  const statusRaw = asString(raw.status, "stopped");
  const status = (
    [
      "running",
      "stopped",
      "disabled",
      "not_started",
      "error",
      "starting",
      "registered",
    ] as const
  ).includes(statusRaw as McpServer["status"])
    ? (statusRaw as McpServer["status"])
    : "stopped";
  const toolsRaw = raw.tools;
  const tools = Array.isArray(toolsRaw)
    ? toolsRaw
        .map((t) =>
          typeof t === "string"
            ? t
            : String((t as { name?: string })?.name ?? ""),
        )
        .filter(Boolean)
    : undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    name: asString(raw.name, asString(raw.id, "unnamed")),
    status: status === "registered" ? "not_started" : status,
    toolCount:
      typeof raw.toolCount === "number"
        ? raw.toolCount
        : (tools?.length ?? 0),
    enabled: raw.enabled !== false && status !== "disabled",
    command: typeof raw.command === "string" ? raw.command : undefined,
    url: typeof raw.url === "string" ? raw.url : undefined,
    args: Array.isArray(raw.args)
      ? raw.args.map((a) => String(a))
      : undefined,
    env:
      raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
        ? (raw.env as Record<string, string>)
        : undefined,
    error:
      typeof raw.error === "string"
        ? raw.error
        : raw.error == null
          ? null
          : asString(raw.error, "error"),
    tools,
  };
}

/** Maps MCP process status to badge label, tone, and icon. */
export function getStatusMeta(status: string) {
  switch (status) {
    case "running":
      return { label: "Running", tone: "good" as const, icon: CheckCircle2 };
    case "error":
      return { label: "Error", tone: "bad" as const, icon: AlertCircle };
    case "starting":
      return { label: "Starting", tone: "warn" as const, icon: Loader2 };
    case "disabled":
      return { label: "Disabled", tone: "muted" as const, icon: PauseCircle };
    default:
      return { label: "Stopped", tone: "muted" as const, icon: PlayCircle };
  }
}

/** Icon and gradient for Google / GitHub / Slack account cards. */
export function getServiceIcon(name: ServiceName) {
  switch (name) {
    case "google":
      return { icon: Mail, color: "from-red-500 to-orange-500" };
    case "github":
      return {
        icon: Github,
        color:
          "from-slate-800 to-slate-950 dark:from-slate-100 dark:to-slate-300 dark:text-slate-950",
      };
    case "slack":
      return { icon: MessageCircle, color: "from-purple-500 to-pink-500" };
  }
}

/** Maps account connection status to badge label, tone, and icon. */
export function getServiceStatusMeta(status: ServiceStatus) {
  switch (status) {
    case "connected":
      return { label: "Connected", tone: "good" as const, icon: CheckCircle2 };
    case "needs_config":
      return {
        label: "Needs config",
        tone: "warn" as const,
        icon: AlertCircle,
      };
    default:
      return { label: "Disconnected", tone: "muted" as const, icon: Link };
  }
}

/** Formats an ISO timestamp as local clock time for “Updated …” labels. */
export function formatTime(value?: string) {
  if (!value) return undefined;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  } catch {
    return undefined;
  }
}

/** Human-readable OAuth scope chip text for Google and other providers. */
export function scopeLabel(scope: string) {
  const labels: Record<string, string> = {
    openid: "OpenID",
    email: "Email",
    profile: "Profile",
    "https://www.googleapis.com/auth/gmail.readonly": "Gmail read",
    "https://www.googleapis.com/auth/gmail.send": "Gmail send",
    "https://www.googleapis.com/auth/calendar": "Calendar",
    "https://www.googleapis.com/auth/drive": "Drive",
    "https://www.googleapis.com/auth/documents": "Documents",
    "https://www.googleapis.com/auth/spreadsheets": "Spreadsheets",
    "https://www.googleapis.com/auth/presentations": "Slides",
    "https://www.googleapis.com/auth/tasks": "Tasks",
    "https://www.googleapis.com/auth/contacts": "Contacts",
  };

  return (
    labels[scope] ||
    scope
      .replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
      .replaceAll(".", " ")
      .replaceAll(/[_-]+/g, " ")
  );
}

/** Splits a multiline editor value into non-empty trimmed lines. */
export function linesToArray(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Parses KEY=VALUE lines into a string map for env and header editors. */
export function linesToObject(value: string) {
  return Object.fromEntries(
    linesToArray(value)
      .map((line) => {
        const idx = line.indexOf("=");
        if (idx === -1) return [line, ""];
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
      .filter(([key]) => key),
  );
}

/** Reads one env key with a default when missing. */
export function envValue(
  env: Record<string, string>,
  key: string,
  fallback = "",
) {
  return env[key] || fallback;
}

/** Serializes a string map back into KEY=VALUE lines for textareas. */
export function objectToLines(value: Record<string, string> = {}) {
  return Object.entries(value)
    .map(([key, child]) => `${key}=${child}`)
    .join("\n");
}
