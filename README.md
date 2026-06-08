# August Proxy

August Proxy is an AI API proxy with managed tools, memory governance, and an interactive dashboard.

## Directory Structure

This project is structured as a monorepo using npm workspaces:

```text
august-proxy/
├── backend/            # Node.js backend server code
│   ├── index.js        # Server entrypoint
│   ├── host-agent/     # Host control daemon
│   ├── voice-assistant/# Voice assistant logic
│   ├── providers/      # Registered AI provider modules and profiles
│   └── ...
├── web/                # React SPA frontend source code (Vite + TS)
│   ├── src/            # React UI components and routing
│   └── package.json    # Frontend dependencies
├── desktop/            # Tauri desktop app
├── mobile/             # React Native mobile app
├── data/               # Persistent database, config, and runtime state
└── web-dist/           # Compiled frontend SPA build output
```

## Running the Application

### Local Development

1. Install root dependencies and workspaces:
   ```bash
   npm install
   ```

2. Start the backend:
   ```bash
   npm run start
   ```

3. Run Vite dev server for React frontend:
   ```bash
   npm run dev:web
   ```

### Docker Deployment

To build and run the services in a Docker container:

```bash
docker compose build
docker compose up -d
```

The React frontend SPA will be served on port `8085` at `http://localhost:8085/`.
