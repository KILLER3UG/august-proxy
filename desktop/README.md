# August Desktop (Tauri 2)

Native desktop shell for August Proxy. Self-hosts the Node backend and serves
the SPA in a Tauri webview.

## Folder map

```
apps/desktop/
├── main/        ← Rust shell: window, tray, backend supervisor
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── src/
│   │   ├── main.rs        (entry — calls lib::run)
│   │   ├── lib.rs         (Tauri builder, window-event hooks)
│   │   ├── backend.rs     (Node process supervisor + IPC commands)
│   │   └── tray.rs        (system tray: Show / Hide / Quit)
│   └── icons/             (placeholder; replace before release)
├── ui/          ← Webview content (synced from proxy/src/web-dist)
│   └── README.md
├── scripts/
│   └── sync-ui.sh         (populate ui/ from the proxy build)
└── README.md   ← you are here
```

## What lives where

| Concern | Folder | Why |
|---|---|---|
| Rust shell, Tauri config, native build | `main/` | Tauri 2 expects the Rust crate as the build entry. Lives here so `cargo tauri build` and `cargo tauri dev` work with paths relative to the crate root. |
| Webview assets (HTML/JS/CSS) | `ui/` | Stays separate from the Rust crate so a web-only release can ship `ui/` alone. Populated by `scripts/sync-ui.sh`. |
| Sync script | `scripts/` | Pure shell — no Rust or JS code lives next to the binary. Easy to call from CI. |

## First-time setup

```bash
# 1) Build the SPA (one time, or whenever UI changes)
cd ../proxy && npm install && npm run build:web

# 2) Sync the SPA into the desktop webview dir
cd ../../desktop
bash scripts/sync-ui.sh link   # dev: symlink for hot updates
                               # release: just `bash scripts/sync-ui.sh`

# 3) Run the desktop shell
cd main
cargo tauri dev
# or, if tauri-cli isn't installed globally:
cargo run
```

The shell auto-starts the Node backend (or reuses it if already running on
:8085) and hides to the system tray on close.

## IPC commands exposed to the webview

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `proxy_status` | — | `"ok:8085"` / `"down"` | Health check for the status pill |
| `restart_proxy` | — | `"restarted"` | Kill+respawn the Node backend |

Call from the webview via:
```ts
import { invoke } from '@tauri-apps/api/core';
const status = await invoke<string>('proxy_status');
```
