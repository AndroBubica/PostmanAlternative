# API Lantern

API Lantern is a free, open-source, local-first API client. It has no accounts,
subscriptions, cloud dependency, or telemetry.

The current codebase is a Phase 1 MVP in progress, built with Tauri 2, React,
TypeScript, Rust, and Oxlint. The everyday single-request workflow is working;
local workspace persistence and collections are the next milestone.

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
