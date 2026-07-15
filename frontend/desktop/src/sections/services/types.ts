/** Shared types for the Services dashboard (accounts, MCP servers, skills). */

export interface McpServer {
  id?: string;
  name: string;
  status:
    | "running"
    | "stopped"
    | "disabled"
    | "not_started"
    | "error"
    | "starting"
    | "registered";
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

export interface McpGlobalEnvVar {
  key: string;
  value: string;
  set: boolean;
  sensitive: boolean;
  masked?: boolean;
}

export interface Skill {
  name: string;
  description: string;
  enabled: boolean;
  category?: string;
  trigger?: string;
}

export type ServiceName = "google" | "github" | "slack";
export type McpSkillsFilter = "all" | "mcp" | "skills";
export type ServiceStatus = "connected" | "disconnected" | "needs_config";

export interface ServiceConnection {
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

export interface ServiceConnectionsResponse {
  connections: Partial<Record<ServiceName, ServiceConnection>>;
}
