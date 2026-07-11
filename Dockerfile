# August Proxy — Python/FastAPI backend with Node.js for MCP servers
FROM python:3.12-slim

WORKDIR /app

# Install Node.js 22 (for MCP server processes), system deps, and uv
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    sqlite3 \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python dependency management
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="/usr/local/bin" sh

# Install Node.js MCP dependencies (used by Python backend when spawning MCP servers)
RUN npm install -g http-proxy @modelcontextprotocol/sdk officeparser

# Clone claudekit-blender-mcp (MCP server for Blender integration)
RUN git clone https://github.com/olbboy/claudekit-blender-mcp.git /app/claudekit-blender-mcp && \
    cd /app/claudekit-blender-mcp && \
    npm install && \
    npm run build

# Copy Python backend and install dependencies
COPY backend-py/ /app/backend-py/
WORKDIR /app/backend-py
RUN uv sync --no-dev

# Install Playwright browsers (optional, for browser automation)
RUN uv run playwright install chromium --with-deps || echo "Playwright install skipped (non-critical)"

# Copy frontend build output, data, skills, docs, scripts
# (host_files/ is dockerignored and live-mounted via docker-compose at runtime)
WORKDIR /app
COPY web-dist/ /app/web-dist/
COPY data/ /app/data/
COPY skills/ /app/skills/
COPY docs/ /app/docs/
COPY scripts/ /app/scripts/

EXPOSE 8085

# Run the FastAPI backend via uvicorn
CMD ["uv", "run", "--directory", "/app/backend-py", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8085"]
