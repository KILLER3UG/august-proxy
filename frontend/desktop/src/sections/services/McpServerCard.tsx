import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Save,
  Wrench,
} from "lucide-react";
import {
  getStatusMeta,
  linesToArray,
  linesToObject,
  objectToLines,
} from "./serviceHelpers";
import type { McpServer } from "./types";

/**
 * Expandable MCP server card: runtime status, tool chips, and form fields
 * for command/URL transport, env, headers, cwd, and enable toggle.
 */
export function McpServerCard({
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
