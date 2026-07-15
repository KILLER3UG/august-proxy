import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RotateCcw } from "lucide-react";
import { McpServerCard } from "./McpServerCard";
import { ServiceConnectionCard } from "./ServiceConnectionCard";
import { SkillsSection } from "./SkillsSection";
import {
  FALLBACK_SERVICES,
  linesToObject,
  normalizeMcpServer,
} from "./serviceHelpers";
import type {
  McpGlobalEnvVar,
  McpServer,
  McpSkillsFilter,
  ServiceConnectionsResponse,
  ServiceName,
  Skill,
} from "./types";

/**
 * Services dashboard: loads account connections, MCP server health, and skills;
 * filters All / MCP / Skills; wires connect, save, and restart mutations.
 */
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
      const res = await api.get<{ servers: Record<string, unknown>[] }>(
        "/api/mcp/servers",
      );
      return (res.servers ?? []).map(normalizeMcpServer);
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
      // Python API has create + start/stop, not upsert — replace by id when present.
      if (server.id) {
        try {
          await api.delete(`/api/mcp/servers/${encodeURIComponent(server.id)}`);
        } catch {
          /* best-effort: create still proceeds */
        }
      }
      const created = await api.post<{ id: string }>("/api/mcp/servers", {
        name: server.name,
        command: server.command ?? "",
        args: server.args ?? [],
        env: server.env ?? {},
        url: server.url ?? "",
        transport: server.url ? "sse" : "stdio",
      });
      if (server.enabled !== false && created?.id) {
        await api.post(
          `/api/mcp/servers/${encodeURIComponent(created.id)}/start`,
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-global-env"] });
    },
  });

  const restartMcpServers = useMutation({
    mutationFn: async () => {
      const res = await api.get<{ servers: Array<{ id?: string }> }>(
        "/api/mcp/servers",
      );
      for (const s of res.servers ?? []) {
        if (!s.id) continue;
        const id = encodeURIComponent(s.id);
        try {
          await api.post(`/api/mcp/servers/${id}/stop`);
        } catch {
          /* ignore stop failures */
        }
        try {
          await api.post(`/api/mcp/servers/${id}/start`);
        } catch {
          /* ignore start failures per-server */
        }
      }
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
                <McpServerCard
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

      {showSkills && <SkillsSection skills={skills} />}
    </div>
  );
}
