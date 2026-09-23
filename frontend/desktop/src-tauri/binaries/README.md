# Bundled Node binaries

This directory is populated by:

```bash
node scripts/download-node-binaries.mjs
```

The Tauri desktop build expects a per-target `node-${triple}[.exe]` directly
inside this directory. Pass `--version=<version>` to upgrade the bundled Node;
the version must have a pinned SHA-256 in this script.
