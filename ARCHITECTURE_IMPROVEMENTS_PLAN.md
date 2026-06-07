# Architecture Improvements Plan

This document tracks the behavior-preserving architecture cleanup for API
Lantern. The workspace format, Tauri command names, CLI flags, report formats,
and user-visible workflows are compatibility boundaries.

## Goals

- Keep composition roots small and move behavior into focused modules.
- Give domain concepts one shared type definition.
- Keep native calls behind a typed frontend service.
- Separate workspace models, persistence, import/export, and command adapters.
- Reuse request-runner behavior between the desktop backend and CLI where
  practical.
- Keep every extraction covered by the existing frontend and Rust checks.

## Target Boundaries

```text
src/
  components/       reusable visual components
  domain/           application and workspace types
  features/         feature-specific UI
  lib/              pure request/assertion/report logic
  services/         Tauri and browser integration

src-tauri/src/
  commands/         thin Tauri command adapters
  runner/           CLI-compatible request execution and reports
  workspace/        models, persistence, imports, exports, and logs
```

Dependencies flow from UI and command adapters toward domain and pure logic.
Domain and pure logic must not import React, Tauri, dialogs, or filesystem
state.

## Phases

- [x] Record compatibility boundaries and target architecture.
- [x] Extract frontend domain types, pure modules, reusable components, and
  typed Tauri service calls.
- [x] Split native commands and workspace responsibilities into named modules.
- [x] Extract shared Rust runner assertions and report models.
- [x] Update maintainer documentation and verification instructions.
- [x] Run frontend lint/tests/build and Rust tests.

## Verification

```sh
corepack pnpm check
cd src-tauri && cargo test
```

Manual packaged-app verification remains required for platform dialogs,
portable-mode path detection, request cancellation, and real network traffic.
