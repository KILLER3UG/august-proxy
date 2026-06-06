# august Proxy — Setup Guide

## Quick Answer: Use Docker (Recommended)

This project is **already fully containerized**. The best way to share it is via Docker — anyone can run it with two commands. Building from scratch is only needed if you want to modify the code.

---

## Option 1: Run with Docker (2 minutes)

This is the exact setup running on the author's machine.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, Mac, or Linux)
- PowerShell (Windows) or Terminal (Mac/Linux)

### Step 1: Get the Files

Copy the `august-proxy` folder to your machine. You need these files:

```
august-proxy/
├── bridge.js
├── launch.js
├── ui.html
├── Dockerfile
├── docker-compose.yml
├── adapters/
│   ├── anthropic.js
│   └── openai.js
└── utils/
    ├── config.js
    ├── logger.js
    ├── models.js
    ├── tokens.js
    └── selfheal.js
```

Optional but recommended:
- `claude-local.bat` / `codex-local.bat` — launch scripts
- `install-global.bat` / `install-global.ps1` — add to PATH
- `mock-upstream.js` — local test server
- `test-tool-flow.js` / `test-parallel.js` — integration tests

### Step 2: Create `config.json`

Create this file in the `august-proxy` folder:

```json
{
  "claude": {
    "currentModel": "minimax-m2.5-free",
    "targetUrl": "https://opencode.ai/zen/v1/chat/completions",
    "apiKey": "YOUR_OPENCODE_KEY_HERE",
    "contextWindow": 256000,
    "contextModelId": "minimax-m2.5-free"
  },
  "codex": {
    "currentModel": "inclusionai/ling-2.6-1t:free",
    "targetUrl": "https://api.kilo.ai/api/gateway/chat/completions",
    "apiKey": "YOUR_KILOCODE_KEY_HERE",
    "contextWindow": 256000,
    "contextModelId": "inclusionai/ling-2.6-1t:free"
  }
}
```

### Step 3: Create `.env`

Create this file in the same folder:

```env
KILOCODE_API_KEY=your_kilocode_key_here
OPENCODE_API_KEY=your_opencode_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
CLINE_API_KEY=your_cline_key_here
```

You only need keys for the providers you plan to use. See [Getting API Keys](#getting-api-keys) below.

### Step 4: Start the Container

```powershell
cd august-proxy
docker compose up --build -d
```

### Step 5: Verify

```powershell
docker ps
# Should show: august-proxy   Up X seconds   0.0.0.0:8085->8080/tcp
```

Open http://localhost:8085 in your browser.

### Step 6: Launch Claude or Codex

```powershell
# Claude
$env:ANTHROPIC_BASE_URL = "http://localhost:8085"
claude

# Codex
$env:OPENAI_API_KEY = "dummy"
$env:OPENAI_BASE_URL = "http://localhost:8085"
codex
```

Or use the batch files (see below).

---

## Option 2: Build from Scratch (For Developers)

If you want to understand every piece or modify the code, here's how to build it from an empty folder.

### Step 1: Create Project Folder

```powershell
mkdir august-proxy
cd august-proxy
npm init -y
```

### Step 2: Create `package.json`

```json
{
  "name": "august-proxy",
  "version": "1.0.0",
  "description": "HTTP bridge for Claude Code and OpenAI Codex",
  "main": "bridge.js",
  "scripts": {
    "start": "node bridge.js",
    "test": "node test-tool-flow.js",
    "mock": "node mock-upstream.js"
  }
}
```

### Step 3: Create Folder Structure

```powershell
mkdir adapters
mkdir utils
```

### Step 4: Create Core Files

You need to create each file. The complete source code is in this repository. Key files:

| File | Purpose |
|------|---------|
| `bridge.js` | HTTP server, routing, UI endpoints |
| `adapters/anthropic.js` | `/v1/messages` handler |
| `adapters/openai.js` | `/v1/chat/completions` & `/v1/responses` handler |
| `utils/config.js` | Config loader with mtime caching |
| `utils/logger.js` | Activity & request tracking |
| `utils/models.js` | Model registry & context window detection |
| `utils/tokens.js` | Token estimation |
| `utils/selfheal.js` | Error detection & fix hints |
| `ui.html` | Web dashboard |
| `launch.js` | Interactive CLI launcher |

### Step 5: Create `Dockerfile`

```dockerfile
FROM node:20-slim
WORKDIR /app
RUN npm install http-proxy
COPY bridge.js config.json ui.html ./
COPY adapters/ ./adapters/
COPY utils/ ./utils/
EXPOSE 8080
CMD ["node", "bridge.js"]
```

### Step 6: Create `docker-compose.yml`

```yaml
services:
  august-proxy:
    build: .
    container_name: august-proxy
    env_file:
      - .env
    volumes:
      - ./config.json:/app/config.json
    ports:
      - "8085:8080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: always
    tty: true
    stdin_open: true
```

### Step 7: Build and Run

```powershell
docker compose up --build -d
```

---

## Option 3: Run Without Docker (Node.js Directly)

If you don't want Docker, you can run the proxy directly with Node.js 20+.

### Prerequisites

- Node.js 20 or higher
- All files from the project

### Steps

```powershell
cd august-proxy

# Set environment variables
$env:KILOCODE_API_KEY = "your_key"
$env:OPENCODE_API_KEY = "your_key"
$env:OPENROUTER_API_KEY = "your_key"

# Create config.json (same as above)

# Start the server
node bridge.js
```

The proxy will listen on port 8080. Access it at http://localhost:8080.

**Note:** When running outside Docker, the proxy listens on port 8080 (not 8085). Update your client environment variables accordingly.

---

## Getting API Keys

### KiloCode
1. Go to https://kilo.ai
2. Sign up and go to Dashboard → API Keys
3. Copy the key (starts with `eyJ...`)

### Opencode
1. Go to https://opencode.ai
2. Sign up and go to Settings → API
3. Generate and copy the key

### OpenRouter
1. Go to https://openrouter.ai
2. Sign up and go to Keys → Create Key
3. Copy the key (starts with `sk-or-v1-...`)

### NVIDIA NIM (Free Models)
1. Go to https://build.nvidia.com
2. Sign up and generate an API key
3. Base URL: `https://integrate.api.nvidia.com/v1`

---

## Launch Scripts

### Quick PowerShell

```powershell
# Claude
$env:ANTHROPIC_BASE_URL = "http://localhost:8085"; claude

# Codex
$env:OPENAI_API_KEY = "dummy"
$env:OPENAI_BASE_URL = "http://localhost:8085"; codex
```

### Batch Files

Create `claude-local.bat`:
```bat
@echo off
node "%~dp0launch.js" claude %*
```

Create `codex-local.bat`:
```bat
@echo off
node "%~dp0launch.js" codex %*
```

### Add to PATH (Optional)

Run `install-global.bat` to add the folder to your user PATH, then run `claude-local` or `codex-local` from anywhere.

---

## Docker Commands Reference

```powershell
# Build and start
docker compose up --build -d

# Stop
docker compose down

# Restart
docker compose down && docker compose up --build -d

# View logs
docker logs august-proxy -f

# View last 50 lines
docker logs august-proxy --tail 50

# Restart container only
docker restart august-proxy

# Shell into container
docker exec -it august-proxy /bin/sh
```

---

## Troubleshooting

### "Docker Desktop not running"
```powershell
Stop-Process -Name "Docker Desktop" -Force
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
```

### "Port 8085 already in use"
Change the port in `docker-compose.yml`:
```yaml
ports:
  - "8086:8080"
```

### "No models found"
1. Check `.env` has correct API keys
2. Check Docker logs: `docker logs august-proxy --tail 20`
3. Try the Custom Provider section in the UI

### Container exits immediately
Make sure `tty: true` and `stdin_open: true` are in `docker-compose.yml`.

---

## Why Docker is Better for Sharing

| Aspect | Docker | From Scratch |
|--------|--------|-------------|
| Setup time | 2 minutes | 30+ minutes |
| Node.js version | Guaranteed 20-slim | Must install manually |
| Dependencies | Pre-installed | Must install manually |
| Portability | Works on any OS | OS-specific setup |
| Isolation | Won't conflict with other projects | May conflict |
| Sharing | Just share the folder | Must document every step |
| Updates | `docker compose up --build -d` | Manual file changes |

**Bottom line:** Docker is the intended deployment method. The from-scratch guide exists for educational purposes only.

---

## File Checklist

To verify you have everything, check for these files:

```powershell
# Required
Test-Path bridge.js         # $true
Test-Path adapters/anthropic.js   # $true
Test-Path adapters/openai.js      # $true
Test-Path utils/config.js   # $true
Test-Path utils/logger.js   # $true
Test-Path utils/models.js   # $true
Test-Path utils/tokens.js   # $true
Test-Path utils/selfheal.js # $true
Test-Path ui.html           # $true
Test-Path Dockerfile        # $true
Test-Path docker-compose.yml # $true

# Optional but recommended
Test-Path launch.js         # $true
Test-Path claude-local.bat  # $true
Test-Path codex-local.bat   # $true
Test-Path mock-upstream.js  # $true
Test-Path test-tool-flow.js # $true

# You must create these
Test-Path config.json       # YOU CREATE THIS
Test-Path .env              # YOU CREATE THIS
```

---

## Next Steps

1. Read [DOCUMENTATION.md](DOCUMENTATION.md) for full feature documentation
2. Open http://localhost:8085 to configure models via the Web UI
3. Run `claude-local.bat` or `codex-local.bat` to start coding
