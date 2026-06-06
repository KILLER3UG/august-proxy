# Design: Service Connections UI & API

## Context

The proxy has multiple MCP servers requiring API tokens or OAuth authentication (Google, GitHub, Slack). Currently, tokens must be manually edited in `.env` or `config.json` via command line. This spec adds a visual connection management panel to the proxy UI and backing API endpoints.

## Architecture

Two layers:
1. **REST API** (`/api/service-connections/*`) — CRUD for connection credentials
2. **UI section** ("Services" tab) — card-based connection management

The API stores credentials directly into `config.json` under a new `serviceConnections` key, and exports them to MCP server configs via `${env:VAR}` references. Google OAuth is handled inline via workspace-mcp's existing `start_google_auth` tool.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/service-connections` | List all connections and status |
| `POST` | `/api/service-connections/google` | Returns OAuth URL for workspace-mcp |
| `POST` | `/api/service-connections/github` | Save GitHub token |
| `POST` | `/api/service-connections/slack` | Save Slack bot token + team ID |
| `DELETE` | `/api/service-connections/:name` | Remove stored credentials |

### Response format (GET)
```json
{
  "connections": {
    "google": { "status": "connected", "email": "user@gmail.com" },
    "github": { "status": "disconnected" },
    "slack": { "status": "disconnected" }
  }
}
```

## UI

### New "Services" sidebar entry
- Positioned between "Health" (02) and "AI Workbench" (03)
- Numbered "03" → existing workbench moves to "04"
- Icon: plug/connection SVG

### Section layout
Card-based design matching existing UI patterns:
- **Google Workspace** card — shows connected email, "Re-authenticate" button, "Disconnect" button, status badge
- **GitHub** card — token input field (password-masked), "Connect" / "Disconnect" button, status badge
- **Slack** card — bot token + team ID fields, "Connect" / "Disconnect" button, status badge
- Future: placeholder card for adding more services

Each card follows the same pattern as existing MCP server cards.

## Files changed

| File | Change |
|------|--------|
| `ui/partials/sections/connections.html` | **New** — Service Connections section HTML |
| `ui/js/connections.js` | **New** — JS for connection management, OAuth trigger |
| `ui/partials/sidebar.html` | Add "Services" nav item |
| `ui/pages/ui.html` | Add `@include` for connections section |
| `ui/partials/scripts.html` | Add `<script src>` for connections.js |
| `ui/partials/sections/mcp.html` | Add subtab for service config in MCP servers form |
| `apps/proxy/src/index.js` | Add 5 route handlers for service-connections API |
| `apps/proxy/src/data/config.json` | Will receive `serviceConnections` key on save |

## Data storage

Credentials stored in `config.json` under a `serviceConnections` key:
```json
{
  "serviceConnections": {
    "google": {
      "email": "user@gmail.com",
      "status": "connected"
    },
    "github": {
      "token": "ghp_...",
      "status": "connected"
    },
    "slack": {
      "botToken": "xoxb-...",
      "teamId": "T...",
      "status": "connected"
    }
  }
}
```

## Verification

1. Open `http://localhost:8085/` — new "Services" tab visible in sidebar
2. Click "Services" — shows Google, GitHub, Slack cards
3. Google card shows "Connected (user@gmail.com)" with "Disconnect" button
4. Click "Re-authenticate" — triggers workspace-mcp OAuth URL
5. Verify `GET /api/service-connections` returns valid JSON
6. Verify `POST /api/service-connections/github` with token saves correctly
7. Restart proxy — connections persist
