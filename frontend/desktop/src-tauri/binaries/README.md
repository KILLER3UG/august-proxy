# Bundled Node binaries

This directory is populated by:

```bash
node scripts/download-node-binaries.mjs
```

The Tauri desktop build expects a per-target `node-${triple}/node[.exe]` inside
this directory. Update the `version` field at the top of
`scripts/download-node-binaries.mjs` to upgrade the bundled Node.
