# Architecture

API Lantern is a React frontend hosted by Tauri. React owns editing and view
state. Tauri commands provide native HTTP, filesystem, workspace, vault, and
portable export capabilities. Workspace JSON files remain the source of truth.

## Frontend

- `domain/` defines request, response, workspace, runner, and tab contracts.
- `lib/` contains pure request building, variable resolution, assertions, cURL
  parsing/generation, and report formatting.
- `services/tauri.ts` is the typed native boundary. UI code should add native
  operations there instead of calling `invoke` directly.
- `components/` contains reusable controls and response-formatting views.
- `App.tsx` is the application composition root and coordinates feature state.

Pure modules must not depend on React or Tauri. Components may depend on domain
types and pure modules. Tauri payload field names are compatibility-sensitive.

## Native Backend

- `commands/` contains thin Tauri adapters and command registration.
- `http.rs` owns native request transport and cancellation.
- `workspace/` owns workspace models, persistence, imports, portable exports,
  and bounded logs.
- `runner/` owns shared assertion and report contracts used by the CLI.
- `vault.rs` owns encrypted secret file encoding.

The backend keeps `lib.rs` as a composition root. New filesystem behavior
belongs under `workspace/`; new Tauri commands belong under `commands/`.

## Compatibility Rules

- Do not rename existing Tauri commands without a frontend compatibility
  migration.
- Keep workspace version 1 field names and defaults readable.
- Preserve unknown workspace data where practical.
- Keep writes atomic and portable exports secret-free.
- Keep CLI flags and exit codes stable.

## Adding Features

Define or extend the domain contract first. Put deterministic behavior in a
pure frontend or Rust library module, add tests there, then expose the smallest
possible UI or command adapter.
