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

Phase 2 adds isolated pre-request and post-response JavaScript, friendly
assertions, nested collection runs, JSON/JUnit reports, and a workspace CLI
runner. Scripts are disabled by default, including imported Postman scripts.

Workspace data is stored in the operating system's local application-data
folder. When `portable.flag` exists beside the application, all workspace data
is stored in a `workspace` folder beside the portable release instead.

## Current Release

API Lantern `v0.2.0` adds isolated pre-request and post-response JavaScript,
friendly assertions, nested collection runs, JSON/JUnit reports, and a
workspace CLI runner. It also includes substantial interface hardening and a
more maintainable frontend and Rust architecture.

Portable Windows x64 and universal macOS packages are built automatically for
the release:

- [Download API Lantern v0.2.0](https://github.com/AndroBubica/PostmanAlternative/releases/tag/v0.2.0)

Release verification remains open for:

- Independent download and checksum verification of the published packages.
- Physical USB-media portable-mode testing on Windows and macOS.
- Hands-on keyboard, VoiceOver/NVDA, contrast, and zoom accessibility testing.

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

Run saved workspace requests from a terminal or CI:

```sh
cd src-tauri
cargo run --bin api-lantern-cli -- \
  --workspace /path/to/workspace \
  --collection collection-id \
  --environment environment-id \
  --report junit \
  --output report.xml
```

The CLI exits with `1` when a request or assertion fails and `2` for invalid
usage or report-write errors. It reads the same plain-text workspace files as
the desktop app. Desktop JavaScript sandbox scripts are reported as unsupported
by the CLI; use friendly assertions for CI runs.

See [PRODUCT_PLAN.md](PRODUCT_PLAN.md) for the complete product direction and
roadmap and [RELEASE_NOTES.md](RELEASE_NOTES.md) for the current release
description. See [WORKSPACE_FORMAT.md](WORKSPACE_FORMAT.md) for the standalone
workspace contract. Release-device and accessibility verification procedures
are documented in [PORTABLE_TEST_PLAN.md](PORTABLE_TEST_PLAN.md) and
[ACCESSIBILITY_VERIFICATION.md](ACCESSIBILITY_VERIFICATION.md).
Maintainers should also read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[ARCHITECTURE_IMPROVEMENTS_PLAN.md](ARCHITECTURE_IMPROVEMENTS_PLAN.md).

## Portable Release Layout

Build the Windows and macOS Tauri bundles on their respective platforms, then
create the shared USB structure:

```sh
corepack pnpm portable:layout
```

Place `api-lantern.exe` in `release/API-Lantern/Windows-x64/` and `API
Lantern.app` in `release/API-Lantern/macOS/`. The supplied launchers create
portable mode and both applications use the shared `workspace/` folder.
The `Portable desktop packages` GitHub Actions workflow builds and verifies
Windows x64 and universal Intel/Apple Silicon macOS artifacts for tags and
manual runs. The macOS package is published; Windows publication is deferred.
