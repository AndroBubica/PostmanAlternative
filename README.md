# API Lantern

API Lantern is a free, open-source, local-first API client. It has no accounts,
subscriptions, cloud dependency, or telemetry.

The current codebase is a Phase 1 MVP, built with Tauri 2, React, TypeScript,
Rust, and Oxlint. It includes the everyday request workflow, atomic local
workspace persistence, collections, environments and variable resolution,
request history, Postman/OpenAPI/cURL imports, and secret-free portable
workspace ZIP exports.

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
roadmap.
