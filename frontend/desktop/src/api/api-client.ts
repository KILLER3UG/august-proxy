/* ── Backend API helpers ───────────────────────────────────────────── */
/* Typed wrappers for Python FastAPI routes under /api/* (and /v1/* via
 * other modules). Secrets are redacted server-side; we never display raw keys.
 * Do not use legacy Node /ui/* paths — they are not served.
 * Public import path `@/api/api-client` resolves here. */

export * from './api-client/traffic';
export * from './api-client/automations';
export * from './api-client/preview';
export * from './api-client/terminal';
export * from './api-client/models';
export * from './api-client/live';
export * from './api-client/brain';
export * from './api-client/manage';
export * from './api-client/audit';
export * from './api-client/host-agent';
export * from './api-client/security';
export * from './api-client/observability';
export * from './api-client/external-access';
export * from './api-client/feature-flow';
