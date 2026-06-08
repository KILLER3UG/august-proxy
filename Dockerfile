FROM node:22-slim
WORKDIR /app
# Install uv/uvx plus Python for Python-based MCP servers such as MiniMax and fetch.
RUN apt-get update && apt-get install -y curl ca-certificates python3 git sqlite3 && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="/usr/local/bin" sh
RUN npm install http-proxy @modelcontextprotocol/sdk officeparser
RUN git clone https://github.com/olbboy/claudekit-blender-mcp.git /app/claudekit-blender-mcp
RUN cd /app/claudekit-blender-mcp && npm install && npm run build
COPY backend/ ./backend/
COPY docs/ ./docs/
COPY scripts/ ./scripts/
COPY data/ ./data/
COPY web-dist/ ./web-dist/
EXPOSE 8080
CMD ["node", "backend/index.js"]
