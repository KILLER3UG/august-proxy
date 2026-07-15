import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SERVICE_LINKS } from "@/lib/service-links";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { HelpLink } from "./HelpLink";
import {
  envValue,
  formatTime,
  getServiceIcon,
  getServiceStatusMeta,
  linesToObject,
  objectToLines,
  scopeLabel,
} from "./serviceHelpers";
import type { ServiceConnection } from "./types";

/**
 * Expandable card for Google / GitHub / Slack: shows connection status,
 * OAuth or token fields, and actions to connect, save env, or disconnect.
 */
export function ServiceConnectionCard({
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
  const [_error, _setError] = useState<string | null>(null);

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
    _setError(null);
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
                      href={
                        isSlack
                          ? SERVICE_LINKS.slack.botToken
                          : SERVICE_LINKS.github.token
                      }
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
