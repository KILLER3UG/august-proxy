# ui/

This directory is populated by `../scripts/sync-ui.sh`.

Tauri's `build.frontendDist` in `../main/tauri.conf.json` points here, so the
desktop webview loads whatever is in this folder.

**Do not edit files in here directly** — they get overwritten on every sync.

## Populate it

```bash
# from apps/desktop/
bash scripts/sync-ui.sh           # copy proxy/src/web-dist → ui/
bash scripts/sync-ui.sh link      # dev mode: symlink (instant updates on rebuild)
```

The copy step requires the SPA to be built first:
```bash
cd ../../proxy && npm run build:web
```
