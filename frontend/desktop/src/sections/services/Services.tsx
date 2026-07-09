import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Github,
  KeyRound,
  Link,
  Loader2,
  Mail,
  MessageCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  RotateCcw,
  Save,
  Server,
  Trash2,
  Wrench,
} from "lucide-react";
import { SERVICE_LINKS } from "@/lib/service-links";

interface McpServer {
  name: string;
  status:
    | "running"
    | "stopped"
    | "disabled"
    | "not_started"
    | "error"
    | "starting";
  toolCount: number;
  enabled: boolean;
  command?: string;
  url?: string;
  args?: string[];
  argsText?: string;
  env?: Record<string, string>;
  envText?: string;
  headers?: Record<string, string>;
  headersText?: string;
  cwd?: string;
  timeoutMs?: number;
  source?: string;
  error?: string | null;
  tools?: string[];
}

interface McpGlobalEnvVar {
  key: string;
  value: string;
  set: boolean;
  sensitive: boolean;
  masked?: boolean;
}

interface Skill {
  name: string;
  description: string;
  enabled: boolean;
  category?: string;
  trigger?: string;
}

interface ImportLinkResult {
  sourceUrl?: string;
  resolvedUrl?: string;
  mcpServers?: Array<{ name?: string; command?: string; enabled?: boolean }>;
  skills?: Array<{ name?: string; enabled?: boolean }>;
  plugins?: Array<{
    name?: string;
    enabled?: boolean;
    mcpServerCount?: number;
    skillCount?: number;
  }>;
  enabledMcpServers?: string[];
}

type ServiceName = "google" | "github" | "slack";
type McpSkillsFilter = "all" | "mcp" | "skills";
type ServiceStatus = "connected" | "disconnected" | "needs_config";

interface ServiceConnection {
  name: ServiceName;
  label: string;
  description: string;
  services: string[];
  scopes: string[];
  status: ServiceStatus;
  connected: boolean;
  account?: string;
  maskedToken?: string;
  teamId?: string;
  missingConfig?: boolean;
  updatedAt?: string;
}

interface ServiceConnectionsResponse {
  connections: Partial<Record<ServiceName, ServiceConnection>>;
}

const FALLBACK_SERVICES: ServiceConnection[] = [
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

function getStatusMeta(status: string) {
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

function getServiceIcon(name: ServiceName) {
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

function getServiceStatusMeta(status: ServiceStatus) {
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

function formatTime(value?: string) {
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

function scopeLabel(scope: string) {
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

function linesToArray(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function linesToObject(value: string) {
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

function envValue(env: Record<string, string>, key: string, fallback = "") {
  return env[key] || fallback;
}

function objectToLines(value: Record<string, string> = {}) {
  return Object.entries(value)
    .map(([key, child]) => `${key}=${child}`)
    .join("\n");
}

export function MergedMcpSkills() {
  const queryClient = useQueryClient();

  const { data: serviceData, isLoading: servicesLoading } = useQuery({
    queryKey: ["service-connections"],
    queryFn: async () => {
      const res = await api.get<ServiceConnectionsResponse>(
        "/api/service-connections",
      );
      return Object.values(res.connections || {});
    },
    refetchInterval: 15_000,
  });

  const { data: mcpData, isLoading: mcpLoading } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: async () => {
      const res = await api.get<{ status: McpServer[] }>("/ui/mcp");
      return res.status ?? [];
    },
    refetchInterval: 15_000,
  });

  const { data: skillsData } = useQuery({
    queryKey: ["skills"],
    queryFn: async () => {
      const res = await api.get<{ skills: Skill[] }>("/api/skills");
      return (res.skills ?? []).map((skill) => ({
        ...skill,
        category: skill.category || (skill.trigger ? "automation" : "general"),
      }));
    },
    refetchInterval: 15_000,
  });

  const { data: globalEnvData } = useQuery({
    queryKey: ["mcp-global-env"],
    queryFn: async () => {
      const res = await api.get<{ env: McpGlobalEnvVar[] }>("/api/mcp-env");
      return res.env ?? [];
    },
  });

  const googleAuth = useMutation({
    mutationFn: async (email?: string) => {
      const res = await api.post<{ authUrl: string }>(
        "/api/service-connections/google/auth",
        { email },
      );
      return res.authUrl;
    },
    onSuccess: (authUrl) => {
      const popup = window.open(authUrl, "_blank", "width=520,height=760");
      if (!popup) {
        void queryClient.invalidateQueries({ queryKey: ["service-connections"] });
      }
    },
  });

  const disconnect = useMutation({
    mutationFn: async (name: ServiceName) => {
      await api.delete(`/api/service-connections/${name}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["service-connections"] });
    },
  });

  const connectGithub = useMutation({
    mutationFn: async ({ token }: { token: string }) => {
      await api.post("/api/service-connections/github", { token });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["service-connections"] });
    },
  });

  const connectSlack = useMutation({
    mutationFn: async ({
      botToken,
      teamId,
    }: {
      botToken: string;
      teamId: string;
    }) => {
      await api.post("/api/service-connections/slack", { botToken, teamId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["service-connections"] });
    },
  });

  const saveMcpServer = useMutation({
    mutationFn: async (server: McpServer) => {
      await api.post("/ui/mcp", server);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-global-env"] });
    },
  });

  const restartMcpServers = useMutation({
    mutationFn: async () => {
      await api.post("/ui/mcp/restart");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });

  const saveGlobalMcpEnv = useMutation({
    mutationFn: async (envText: string) => {
      const env = Object.entries(linesToObject(envText)).map(
        ([key, value]) => ({ key, value }),
      );
      await api.post("/api/mcp-env", { env });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-global-env"] });
      restartMcpServers.mutate();
    },
  });

  const [globalEnvText, setGlobalEnvText] = useState("");

  useEffect(() => {
    if (!globalEnvData) return;
    setGlobalEnvText(
      globalEnvData.map((item) => `${item.key}=${item.value}`).join("\n"),
    );
  }, [globalEnvData]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "august-service-connection") {
        void queryClient.invalidateQueries({ queryKey: ["service-connections"] });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [queryClient]);

  const services =
    serviceData && serviceData.length > 0 ? serviceData : FALLBACK_SERVICES;
  const servers = mcpData ?? [];
  const skills = skillsData ?? [];
  const [filter, setFilter] = useState<McpSkillsFilter>("all");
  const showImport = filter !== "skills";
  const showAccounts = filter === "all";
  const showServers = filter === "all" || filter === "mcp";
  const showSkills = filter === "all" || filter === "skills";
  const connectedServices = services.filter((s) => s.connected).length;
  const runningServerCount = servers.filter(
    (s) => s.status === "running",
  ).length;

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="MCP & Skills"
        subtitle={`${connectedServices} connected · ${runningServerCount} MCP servers running · ${servers.length} total MCP servers`}
        actions={
          <div className="flex items-center gap-1 rounded-full border bg-muted/30 p-1">
            {(
              [
                ["all", "All"],
                ["mcp", "MCP"],
                ["skills", "Skills"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium transition",
                  filter === key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      {showImport && <LinkImportPanel />}

      {showAccounts && (
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-1">
                Accounts & logins
              </h3>
              <p className="px-1 text-xs text-muted-foreground">
                Connect the accounts August can use through tools and MCP
                servers.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            {(servicesLoading || mcpLoading) && services.length === 0
              ? Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-20 rounded-2xl border bg-muted/30 animate-pulse"
                  />
                ))
              : services.map((service) => (
                  <ServiceConnectionCard
                    key={service.name}
                    service={service}
                    onAuth={() =>
                      googleAuth.mutate(
                        service.name === "google" ? service.account : undefined,
                      )
                    }
                    onDisconnect={() => disconnect.mutate(service.name)}
                    onConnectGithub={(token) => connectGithub.mutate({ token })}
                    onConnectSlack={(botToken, teamId) =>
                      connectSlack.mutate({ botToken, teamId })
                    }
                    envText={globalEnvText}
                    onEnvTextChange={setGlobalEnvText}
                    onSaveGoogleEnv={() =>
                      saveGlobalMcpEnv.mutate(globalEnvText)
                    }
                    onRestartGoogleEnv={() => restartMcpServers.mutate()}
                    isGoogleEnvBusy={
                      saveGlobalMcpEnv.isPending || restartMcpServers.isPending
                    }
                    isBusy={
                      googleAuth.isPending ||
                      disconnect.isPending ||
                      connectGithub.isPending ||
                      connectSlack.isPending
                    }
                  />
                ))}
          </div>
        </div>
      )}

      {showServers && (
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-1">
                MCP tools
              </h3>
              <p className="px-1 text-xs text-muted-foreground">
                Servers that expose Gmail, Drive, search, browser, Blender, and
                other tools.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => restartMcpServers.mutate()}
              disabled={restartMcpServers.isPending || saveMcpServer.isPending}
            >
              <RotateCcw
                className={cn(
                  "size-3.5",
                  restartMcpServers.isPending && "animate-spin",
                )}
              />
              Restart all
            </Button>
          </div>
          {servers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No MCP servers configured.
            </p>
          ) : (
            <div className="space-y-3">
              {servers.map((s) => (
                <ServerCard
                  key={s.name}
                  server={s}
                  onSave={(server) => saveMcpServer.mutate(server)}
                  isBusy={saveMcpServer.isPending}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {showSkills && (
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-1">
                Skills
              </h3>
              <p className="px-1 text-xs text-muted-foreground">
                Curated skills that can be enabled for August.
              </p>
            </div>
          </div>
          {skills.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No skills loaded.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {skills.map((skill) => (
                <Card key={skill.name} className="overflow-hidden rounded-2xl">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold font-mono truncate">
                            {skill.name}
                          </h3>
                          {skill.category && (
                            <span className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] text-muted-foreground">
                              {skill.category}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {skill.description}
                        </p>
                        {skill.trigger && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                            trigger: {skill.trigger}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label={
                          skill.enabled ? "Disable skill" : "Enable skill"
                        }
                        className={`relative w-9 h-5 rounded-full transition ${skill.enabled ? "bg-primary" : "bg-muted"}`}
                      >
                        <span
                          className={`absolute top-0.5 size-4 rounded-full bg-white transition ${skill.enabled ? "left-[18px]" : "left-0.5"}`}
                        />
                      </button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Services() {
  return <MergedMcpSkills />;
}

/* ── "Where do I get this?" inline link ────────────────────────────── */
/* Always-visible helper anchor that opens the relevant docs / console
 * in a new tab. Used next to OAuth/API credential fields so users
 * don't have to leave the app to Google the answer. */
function HelpLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground hover:underline transition mt-0.5"
    >
      {children}
      <ExternalLink className="size-2.5" />
    </a>
  );
}

function ServiceConnectionCard({
  service,
  onAuth,
  onDisconnect,
  onConnectGithub,
  onConnectSlack,
  envText,
  onEnvTextChange,
  onSaveGoogleEnv,
  onRestartGoogleEnv,
  isGoogleEnvBusy,
  isBusy,
}: {
  service: ServiceConnection;
  onAuth: () => void;
  onDisconnect: () => void;
  onConnectGithub: (token: string) => void;
  onConnectSlack: (botToken: string, teamId: string) => void;
  envText: string;
  onEnvTextChange: (value: string) => void;
  onSaveGoogleEnv: () => void;
  onRestartGoogleEnv: () => void;
  isGoogleEnvBusy: boolean;
  isBusy: boolean;
}) {
  const meta = getServiceStatusMeta(service.status);
  const Icon = getServiceIcon(service.name);
  const StatusIcon = meta.icon;
  const [expanded, setExpanded] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [slackToken, setSlackToken] = useState("");
  const [slackTeamId, setSlackTeamId] = useState(service.teamId || "");
  const [showToken, setShowToken] = useState(false);
  const [showTokenField, setShowTokenField] = useState(!service.connected);
  const [error, setError] = useState<string | null>(null);

  const env = linesToObject(envText);
  const googleClientId = envValue(env, "GOOGLE_OAUTH_CLIENT_ID");
  const googleClientSecret = envValue(env, "GOOGLE_OAUTH_CLIENT_SECRET");
  const googleRedirectUri = envValue(env, "GOOGLE_OAUTH_REDIRECT_URI");

  function updateGoogleEnv(key: string, value: string) {
    const next = { ...env, [key]: value };
    onEnvTextChange(objectToLines(next));
  }

  const isGoogle = service.name === "google";
  const isSlack = service.name === "slack";
  const token = isSlack ? slackToken : githubToken;
  const setToken = isSlack ? setSlackToken : setGithubToken;
  const teamId = isSlack ? slackTeamId : "";
  const tokenLabel = isSlack ? "Slack bot token" : "GitHub token";
  const tokenPlaceholder = isSlack ? "xoxb-..." : "ghp_...";
  const hasRequiredInputs = isGoogle
    ? true
    : isSlack
      ? Boolean(token.trim() && teamId.trim())
      : Boolean(token.trim());
  const showTokenInput = showTokenField || !service.connected;
  const authBadge = service.connected
    ? { label: "configured", tone: "good" as const }
    : service.status === "needs_config"
      ? { label: "needs config", tone: "warn" as const }
      : { label: "needs auth", tone: "muted" as const };

  function handleConnect() {
    setError(null);
    if (isSlack) {
      onConnectSlack(token, teamId);
    } else {
      onConnectGithub(token);
    }
  }

  return (
    <Card
      className={cn(
        "overflow-hidden rounded-2xl transition-all hover:border-primary/30 hover:bg-card",
        expanded && "border-primary/40 shadow-lg shadow-primary/5",
      )}
    >
      <button
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        type="button"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={cn(
              "inline-block size-2.5 rounded-full shrink-0",
              meta.tone === "good" &&
                "bg-success shadow-[0_0_16px_rgba(16,185,129,.45)]",
              meta.tone === "warn" && "bg-warning",
              meta.tone === "muted" && "bg-muted-foreground/30",
            )}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {service.label}
              </span>
              {service.connected && (
                <span className="inline-flex items-center gap-1 text-[9px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
                  <CheckCircle2 className="size-2.5" />
                  connected
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
              <Icon.icon className="size-3" />
              <span className="truncate">{service.description}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
              authBadge.tone === "good" &&
                "border-success/20 bg-success/10 text-success",
              authBadge.tone === "warn" &&
                "border-warning/20 bg-warning/10 text-warning",
              authBadge.tone === "muted" &&
                "border-border bg-muted/40 text-muted-foreground",
            )}
          >
            <StatusIcon className="size-3" />
            {authBadge.label}
          </span>
          {expanded ? (
            <ChevronDown className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t bg-muted/[0.025] px-4 py-3">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {service.scopes.slice(0, 9).map((scope) => (
                <span
                  key={scope}
                  className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[9px] font-medium text-secondary-foreground"
                >
                  {scopeLabel(scope)}
                </span>
              ))}
              {service.scopes.length > 9 && (
                <span className="text-[9px] text-muted-foreground">
                  +{service.scopes.length - 9}
                </span>
              )}
            </div>

            {service.account && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
                  Account
                </p>
                <p
                  className="mt-1 text-xs font-mono truncate"
                  title={service.account}
                >
                  {service.account}
                </p>
              </div>
            )}

            {!showTokenInput && service.maskedToken && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
                  Stored login
                </p>
                <p
                  className="mt-1 text-xs font-mono truncate"
                  title={service.maskedToken}
                >
                  {service.maskedToken}
                </p>
              </div>
            )}

            {!showTokenInput && service.teamId && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
                  Team
                </p>
                <p className="mt-1 text-xs font-mono">{service.teamId}</p>
              </div>
            )}

            {service.missingConfig && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                Google login is not available yet. Add the Google OAuth secret
                in Google login setup, save, restart August, then connect here.
              </div>
            )}

            {!isGoogle && (
              <div className="space-y-2">
                {!showTokenInput ? (
                  <div className="rounded-xl border bg-background p-3 text-xs text-muted-foreground">
                    {tokenLabel} is already configured. Open it only if you need
                    to override it.
                    <div className="mt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowTokenField(true)}
                      >
                        <KeyRound className="size-3 mr-1" />
                        Change token
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-[10px] text-muted-foreground mb-1 font-medium">
                      {tokenLabel}
                    </label>
                    <HelpLink
                      href={isSlack ? SERVICE_LINKS.slack.botToken : SERVICE_LINKS.github.token}
                    >
                      Where do I get this?
                    </HelpLink>
                    <div className="relative mt-1">
                      <Input
                        type={showToken ? "text" : "password"}
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder={
                          service.connected
                            ? `Override existing ${tokenLabel}…`
                            : tokenPlaceholder
                        }
                        className="w-full rounded-md border border-border bg-background px-3 py-2 pr-9 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                      />
                      <button
                        onClick={() => setShowToken((value) => !value)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        type="button"
                      >
                        {showToken ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {isSlack && (
                  <div>
                    <label className="block text-[10px] text-muted-foreground mb-1 font-medium">
                      Slack team ID
                    </label>
                    <HelpLink href={SERVICE_LINKS.slack.teamId}>
                      Where do I find this?
                    </HelpLink>
                    <Input
                      value={teamId}
                      onChange={(e) => setSlackTeamId(e.target.value)}
                      placeholder="T0000000000"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                    />
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">
                    Use an API key, personal token, or bot token. Stored secrets
                    stay saved when left unchanged.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleConnect}
                    disabled={isBusy || !hasRequiredInputs}
                  >
                    <Save className="size-3 mr-1" />
                    {service.connected ? "Save token" : "Connect"}
                  </Button>
                </div>
              </div>
            )}

            {isGoogle && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <div>
                    <label className="block text-[10px] text-muted-foreground mb-1 font-medium">
                      Google client ID
                    </label>
                    <HelpLink href={SERVICE_LINKS.google.clientIdAndSecret}>
                      Where do I get this?
                    </HelpLink>
                    <Input
                      value={googleClientId}
                      onChange={(e) =>
                        updateGoogleEnv(
                          "GOOGLE_OAUTH_CLIENT_ID",
                          e.target.value,
                        )
                      }
                      placeholder="Google OAuth client ID"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-muted-foreground mb-1 font-medium">
                      Google client secret
                    </label>
                    <HelpLink href={SERVICE_LINKS.google.clientIdAndSecret}>
                      Where do I get this?
                    </HelpLink>
                    <Input
                      type="password"
                      value={googleClientSecret}
                      onChange={(e) =>
                        updateGoogleEnv(
                          "GOOGLE_OAUTH_CLIENT_SECRET",
                          e.target.value,
                        )
                      }
                      placeholder="Google OAuth client secret"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-muted-foreground mb-1 font-medium">
                      Redirect URI
                    </label>
                    <HelpLink href={SERVICE_LINKS.google.redirectUriDocs}>
                      How do I set this in Google?
                    </HelpLink>
                    <Input
                      value={googleRedirectUri}
                      onChange={(e) =>
                        updateGoogleEnv(
                          "GOOGLE_OAUTH_REDIRECT_URI",
                          e.target.value,
                        )
                      }
                      placeholder="https://your-domain/oauth/callback"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                    />
                  </div>
                </div>

                {service.missingConfig && (
                  <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                    Google login is not available yet. Add the Google OAuth
                    secret above, save, restart August, then connect here.
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">
                    Save these, restart August, then sign in with the Workspace
                    account August should use.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onRestartGoogleEnv}
                      disabled={isGoogleEnvBusy}
                    >
                      <RotateCcw
                        className={cn(
                          "size-3.5",
                          isGoogleEnvBusy && "animate-spin",
                        )}
                      />
                      Restart
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={onSaveGoogleEnv}
                      disabled={isGoogleEnvBusy}
                    >
                      <Save className="size-3 mr-1" />
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onAuth}
                      disabled={isBusy || service.missingConfig}
                    >
                      <ExternalLink className="size-3.5" />
                      {service.connected ? "Re-auth" : "Connect"}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={onDisconnect}
                      disabled={isBusy || !service.connected}
                    >
                      <Trash2 className="size-3.5" />
                      Disconnect
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {service.updatedAt && (
              <p className="text-[10px] text-muted-foreground">
                Updated {formatTime(service.updatedAt)}
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function LinkImportPanel() {
  const queryClient = useQueryClient();
  const [link, setLink] = useState("");
  const [enableMcp, setEnableMcp] = useState(true);
  const [result, setResult] = useState<ImportLinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importLink = useMutation({
    mutationFn: async (url: string) => {
      const res = await api.post("/ui/import-link", { url, enableMcp });
      return res as ImportLinkResult;
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div>
          <CardTitle>Paste a GitHub or MCP link</CardTitle>
          <CardDescription>
            Paste a repo, raw file, or capability link. August will look for
            skills, plugins, or MCP server metadata.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            className="h-10 text-xs font-mono"
            placeholder="https://github.com/owner/repo"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => importLink.mutate(link.trim())}
            disabled={importLink.isPending || !link.trim()}
          >
            <Link className="size-3.5" />
            Import
          </Button>
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="rounded border-border bg-background"
            checked={enableMcp}
            onChange={(e) => setEnableMcp(e.target.checked)}
            disabled={importLink.isPending}
          />
          enable MCP servers found in the link
        </label>

        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger/90">
            {error}
          </p>
        )}
        {result && (
          <div className="rounded-xl border bg-success/10 p-3 text-xs text-success space-y-2">
            <p className="font-medium">Imported successfully</p>
            {result.resolvedUrl && (
              <p className="truncate">Source: {result.resolvedUrl}</p>
            )}
            {result.enabledMcpServers?.length ? (
              <p>MCP servers: {result.enabledMcpServers.join(", ")}</p>
            ) : (
              <p>No MCP server was imported from this link.</p>
            )}
            {result.skills?.length ? (
              <p>
                Skills:{" "}
                {result.skills
                  .map((s) => s.name)
                  .filter(Boolean)
                  .join(", ")}
              </p>
            ) : null}
            {result.plugins?.length ? (
              <p>
                Plugins:{" "}
                {result.plugins
                  .map((p) => p.name)
                  .filter(Boolean)
                  .join(", ")}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ServerCard({
  server,
  onSave,
  isBusy,
}: {
  server: McpServer;
  onSave: (server: McpServer) => void;
  isBusy: boolean;
}) {
  const meta = getStatusMeta(server.status);
  const StatusIcon = meta.icon;
  const [enabled, setEnabled] = useState(server.enabled);
  const [command, setCommand] = useState(server.command || "");
  const [url, setUrl] = useState(server.url || "");
  const [argsText, setArgsText] = useState(
    server.argsText ?? (server.args || []).join("\n"),
  );
  const [envText, setEnvText] = useState(
    server.envText ?? objectToLines(server.env),
  );
  const [headersText, setHeadersText] = useState(
    server.headersText ?? objectToLines(server.headers),
  );
  const [cwd, setCwd] = useState(server.cwd || "");
  const [timeoutMs, setTimeoutMs] = useState(String(server.timeoutMs || 15000));
  const [advanced, setAdvanced] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isUrlServer = url.trim().length > 0;
  const isStdioServer = !isUrlServer;
  const hasOptionalInputs =
    envText.trim() || headersText.trim() || argsText.trim() || cwd.trim();
  const showAdvanced = advanced || Boolean(hasOptionalInputs);
  const showUrlInput =
    isUrlServer || !command || advanced || !hasOptionalInputs;
  const showCommandInput =
    !isUrlServer || !url || advanced || !hasOptionalInputs;
  const showArgs = isStdioServer || showAdvanced;
  const showEnv = isStdioServer || showAdvanced;
  const showHeaders = isUrlServer || showAdvanced;
  const showCwd = isStdioServer || showAdvanced;

  const setupHint = !enabled
    ? "Turned off. Toggle on if you want August to start this MCP server."
    : server.status === "running"
      ? "Ready. August can call tools from this server."
      : "Needs setup. Check the command, URL, env, or headers, then save to restart it.";

  function buildServerPayload(): McpServer {
    return {
      ...server,
      enabled,
      command,
      url,
      args: linesToArray(argsText),
      env: linesToObject(envText),
      headers: linesToObject(headersText),
      cwd: cwd.trim() || undefined,
      timeoutMs: Math.max(1000, Number(timeoutMs) || 15000),
    };
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    try {
      onSave(buildServerPayload());
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card
      className={cn(
        "overflow-hidden rounded-2xl transition-all hover:border-primary/30 hover:bg-card",
        expanded && "border-primary/40 shadow-lg shadow-primary/5",
      )}
    >
      <button
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        type="button"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold font-mono truncate">
              {server.name}
            </h3>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full",
                meta.tone === "good" && "bg-success/10 text-success",
                meta.tone === "bad" && "bg-danger/10 text-danger",
                meta.tone === "warn" && "bg-warning/10 text-warning",
                meta.tone === "muted" && "bg-muted text-muted-foreground",
              )}
            >
              <StatusIcon
                className={cn(
                  "size-2.5",
                  meta.tone === "warn" && "animate-spin",
                )}
              />
              {meta.label}
            </span>
          </div>

          {server.toolCount > 0 && (
            <p className="text-[10px] text-muted-foreground mt-1 font-mono flex items-center gap-1">
              <Wrench className="size-2.5" /> {server.toolCount} tools
            </p>
          )}

          {server.error && (
            <p
              className="text-[10px] text-danger/80 mt-1 truncate"
              title={server.error}
            >
              {server.error}
            </p>
          )}

          {server.tools && server.tools.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {server.tools.slice(0, 3).map((tool) => (
                <span
                  key={tool}
                  className="inline-flex items-center rounded bg-secondary text-secondary-foreground px-1.5 py-0.5 text-[9px] font-mono truncate max-w-[120px]"
                >
                  {tool}
                </span>
              ))}
              {server.tools.length > 3 && (
                <span className="text-[9px] text-muted-foreground">
                  +{server.tools.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <CardContent className="p-4">
          <div className="mt-4 rounded-xl border bg-muted/20 p-3">
            <div className="flex items-start gap-2">
              <div
                className={cn(
                  "mt-0.5 size-2 rounded-full shrink-0",
                  server.status === "running"
                    ? "bg-success"
                    : server.status === "error"
                      ? "bg-danger"
                      : "bg-warning",
                )}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {setupHint}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-lg border bg-muted/20 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
                  Server setup
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {isUrlServer
                    ? "URL transport. Headers are only needed when the remote MCP asks for auth."
                    : "Command transport. Env/args are only needed when this server needs them."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {!showAdvanced && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setAdvanced(true)}
                    disabled={isBusy}
                  >
                    <Plus className="size-3.5" />
                    Optional setup
                  </Button>
                )}
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="rounded border-border bg-background"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    disabled={isBusy}
                  />
                  enabled
                </label>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {showUrlInput && (
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="https://host/mcp"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={isBusy}
                />
              )}
              {showCommandInput && (
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder={
                    isUrlServer
                      ? "leave empty for URL MCP"
                      : "node / uvx / npx command"
                  }
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  disabled={isBusy}
                />
              )}
            </div>

            {showArgs && (
              <textarea
                className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
                placeholder="args, one per line"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                disabled={isBusy}
              />
            )}

            {showEnv && (
              <textarea
                className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
                placeholder="KEY=VALUE env vars, one per line"
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                disabled={isBusy}
              />
            )}

            {showHeaders && (
              <textarea
                className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
                placeholder="Authorization=Bearer ... headers, one per line"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                disabled={isBusy}
              />
            )}

            {showCwd && (
              <Input
                className="h-8 text-xs font-mono"
                placeholder="cwd"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                disabled={isBusy}
              />
            )}

            <Input
              className="h-8 text-xs font-mono"
              type="number"
              min="1000"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              disabled={isBusy}
            />

            {showAdvanced && (
              <p className="rounded-md bg-muted/50 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
                Env key-value means process variables like{" "}
                <span className="font-mono">BRAVE_API_KEY=abc123</span>. Header
                key-value means HTTP headers like{" "}
                <span className="font-mono">Authorization=Bearer abc123</span>.
                Use one per line.
              </p>
            )}

            {error && <p className="text-[10px] text-danger/80">{error}</p>}
            {saved && (
              <p className="text-[10px] text-success">
                Saved. Backend restarted MCP servers.
              </p>
            )}

            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] text-muted-foreground">
                Masked secrets stay saved when left unchanged.
              </p>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={isBusy}
              >
                <Save className="size-3.5" />
                Save inputs
              </Button>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
