# API Lantern

API Lantern is a free, open-source, local-first API client. It has no accounts,
subscriptions, cloud dependency, or telemetry.

The current codebase is a Phase 1 MVP, built with Tauri 2, React, TypeScript,
Rust, and Oxlint. It includes the everyday request workflow, atomic local
workspace persistence, collections, environments and variable resolution,
request history, nested collection folders and organization actions,
Postman/OpenAPI/cURL imports, and secret-free portable workspace ZIP exports.
It also includes encrypted secrets, multi-request tabs, autosave, scoped
variables, cURL generation, JSON tree/syntax views, configurable limits,
shortcuts, undo, and accessible focus/labels.

Workspace data is stored in the operating system's local application-data
folder. When `portable.flag` exists beside the application, all workspace data
is stored in a `workspace` folder beside the portable release instead.

## Development

Prerequisites:

- Node.js
- pnpm through Corepack
- Rust through rustup
- macOS Command Line Tools when developing on macOS

```sh
corepack pnpm install
corepack pnpm lint
corepack pnpm build
corepack pnpm tauri dev
```

Check the Rust backend:

```sh
source "$HOME/.cargo/env"
cd src-tauri
cargo check
```

See [PRODUCT_PLAN.md](PRODUCT_PLAN.md) for the complete product direction and
roadmap. See [WORKSPACE_FORMAT.md](WORKSPACE_FORMAT.md) for the standalone
workspace contract.

## Portable Release Layout

Build the Windows and macOS Tauri bundles on their respective platforms, then
create the shared USB structure:

```sh
corepack pnpm portable:layout
```

Place `api-lantern.exe` in `release/API-Lantern/Windows-x64/` and `API
Lantern.app` in `release/API-Lantern/macOS/`. The supplied launchers create
portable mode and both applications use the shared `workspace/` folder.
The `Portable desktop packages` GitHub Actions workflow builds Windows x64 and
universal Intel/Apple Silicon macOS artifacts for tags and manual runs.
