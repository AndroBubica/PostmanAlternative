# Portable, Free Postman Alternative

Working title: **API Lantern**

## Product Promise

API Lantern is a free, open-source, local-first API client.

- No registration or account.
- No subscriptions or paid feature gates.
- No cloud dependency.
- No telemetry by default.
- Works offline.
- Requests, collections, and environments remain on the user's disk.
- Portable mode stores all writable data beside the application, including on a USB drive.
- Standard formats prevent lock-in.

This should be a focused API tool, not a collaboration platform.

## What Existing Tools Teach Us

- Postman's most valuable everyday workflow is creating requests, organizing them into collections, using environment variables, inspecting responses, and running tests.
- Bruno demonstrates that local-first, offline, plain-text collections are practical and popular.
- Hoppscotch demonstrates the value of a lightweight, fast interface.
- Our useful difference should be first-class portability, simple UX, open formats, and a promise that core functionality will never be paywalled.

Before building, users who need an existing solution immediately should try Bruno. Building API Lantern makes sense if USB portability and a simpler interface are important enough to differentiate it.

## Recommended Technology

### Desktop shell

Use **Tauri 2**.

- The GUI can be written in JavaScript/TypeScript.
- It produces much smaller applications than bundling a full browser runtime.
- It supports Windows and macOS from one source codebase.
- Rust provides a capable native HTTP engine without browser CORS restrictions.

### GUI

- React + TypeScript + Vite
- Monaco Editor for JSON, XML, text, and scripts
- A small accessible component library, with our own compact visual theme
- Light and dark themes

### JavaScript and TypeScript quality

Use **Oxlint** as the project's primary and required JavaScript/TypeScript linter.

- Do not add ESLint unless a future requirement depends on behavior Oxlint cannot support.
- Enable Oxlint's React, TypeScript, import, and `jsx-a11y` rules.
- Use type-aware linting for checks such as floating promises.
- Enable multi-file analysis for project-wide import checks.
- Run linting locally and as a required CI check.

Initial package scripts:

```json
{
  "scripts": {
    "lint": "oxlint",
    "lint:fix": "oxlint --fix"
  }
}
```

Install it as a development dependency:

```sh
pnpm add -D oxlint
```

### Native core

- Rust
- `reqwest` for HTTP
- `tokio` for asynchronous requests
- `rustls` plus optional native certificate support
- A sandboxed JavaScript runtime for request scripts, added after the MVP

### Storage

Use human-readable files as the source of truth, not a required database.

```text
workspace/
  api-lantern.yaml
  environments/
    local.yaml
    staging.yaml
  collections/
    users/
      collection.yaml
      list-users.yaml
      create-user.yaml
  private/
    secrets.enc
```

- YAML or JSON files are easy to inspect, back up, diff, and version with Git.
- Secret values go into an encrypted local vault and are never exported by default.
- Writes must be atomic to reduce corruption risk if a USB drive is removed.
- Never store absolute paths when a relative path can work.

## Portable USB Design

One executable cannot run on both Windows and macOS. The USB drive should contain separate platform builds and one shared workspace:

```text
API-Lantern/
  Start-Windows.exe
  Windows-x64/
    api-lantern.exe
    runtime/
  macOS/
    API Lantern.app
  workspace/
  exports/
  README.txt
```

Portable mode is enabled when a `portable.flag` file exists beside the application. In portable mode:

- all settings, history, workspaces, logs, and secrets stay inside the USB folder;
- nothing is intentionally written to the user's profile;
- updates are manual and never replace workspace data;
- the app warns before exit if writes are still pending;
- logs and response history have configurable size limits.

### Important platform limitations

- Windows and macOS may warn about an unknown downloaded application.
- Windows WebView2 is normally present on modern Windows 10/11. For a fully offline USB build, bundle a fixed WebView2 runtime, which adds roughly 180 MB.
- macOS direct distribution should be code-signed and notarized for a clean launch experience.
- A universal macOS build should support Apple Silicon and Intel Macs.
- Corporate or school computers may block all unapproved USB applications. The app cannot bypass those policies.
- "No install" is achievable, but "no operating-system security prompt on every computer" is not achievable without signing and reputation.

## MVP: The Useful Everyday Client

### Requests

- HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- URL editor with variable highlighting
- Query parameter table
- Header table with enable/disable checkboxes
- Request body modes:
  - JSON
  - plain text
  - XML
  - form URL encoded
  - multipart form data and files
  - binary file
- Authentication:
  - none
  - Basic
  - Bearer token
  - API key in header or query
- Request timeout and redirect settings
- Cancel in-progress request
- Generate and import cURL

### Responses

- Status, elapsed time, and response size always visible
- Pretty, raw, and preview modes
- JSON tree viewer and syntax highlighting
- Response headers and cookies
- Search response
- Copy and save response to file
- Image response preview
- Clear errors for DNS, TLS, timeout, and connection failures

### Organization

- Tabs for open requests
- Collections and nested folders
- Rename, duplicate, move, and delete
- Favorites and recent requests
- Search by request name, URL, and method
- Autosave with visible saved/unsaved state
- Request history stored locally

### Variables and environments

- `{{variable}}` syntax
- Global, collection, environment, and temporary scopes
- Environment switcher always visible
- Secret variables masked in the UI
- Explain which scope supplied a variable on hover
- Show an error before sending if a variable is unresolved

### Import and export

- Import Postman Collection v2.1
- Import Postman environments
- Import OpenAPI 3.x
- Import cURL
- Export the app's open, documented workspace format
- Export a portable workspace ZIP without secrets by default

## Version 1 Features

- Pre-request and post-response JavaScript scripts in a sandbox
- Friendly assertion builder for status, header, JSON path, and timing tests
- Advanced script editor for users who want code
- Collection runner with pass/fail report
- CSV and JSON data-driven runs
- CLI runner for CI, using the same workspace files
- OAuth 2.0 flows
- Client certificates and custom CA certificates
- Proxy support
- Cookie jar
- GraphQL request editor
- Compare two responses
- Export JUnit and JSON test reports

## Later Features

- WebSocket client
- Server-sent events
- gRPC
- OpenAPI validation and schema-aware suggestions
- Mock server that runs locally
- Plugin API
- Optional Git helpers

Do not add accounts, hosted sync, AI features, team billing, or mandatory cloud services. They conflict with the product promise and create ongoing operating costs.

## User-Friendly GUI

Use a familiar three-column layout:

```text
Collections / Search | Request editor and tabs | Optional environment/variable inspector
                     | Response panel
```

Key interaction rules:

- A new user can send a GET request within ten seconds.
- The URL field and Send button are the strongest visual elements.
- Advanced settings remain available but do not crowd the default screen.
- Every destructive action supports undo where practical.
- Keyboard shortcuts cover send, new request, save, search, and tab navigation.
- Errors explain what happened and suggest a useful fix.
- Never show account, upgrade, trial, or cloud prompts.
- Accessibility is part of the MVP: keyboard navigation, visible focus, sufficient contrast, and screen-reader labels.

## Security Requirements

- The native core sends requests; the webview does not receive unrestricted filesystem or shell access.
- Script execution is sandboxed, disabled by default for imported collections, and has explicit permissions.
- Imported collections are data, never trusted code.
- Secrets are encrypted at rest using a user-provided vault password.
- Sensitive headers and variables are redacted from logs and exports.
- TLS verification is on by default. Disabling it shows a clear warning.
- Dependencies and licenses are checked automatically in CI.

## Phase 1 Implementation Status

- [x] Portable Windows/macOS launchers and shared USB layout generator
- [ ] Confirm and publish Windows x64 and universal macOS portable packages
- [x] AES-256-GCM encrypted secret vault with Argon2 password derivation
- [x] Multi-request tabs, autosave, and unsaved-exit warning
- [x] Global, collection, environment, and temporary variables with source explanations
- [x] cURL import/generation and URL variable highlighting
- [x] JSON tree viewer and syntax highlighting
- [x] OpenAPI JSON/YAML and Postman collection/environment imports
- [ ] Preserve imported Postman folder hierarchy and complete authentication values
- [x] Documented standalone workspace export format
- [x] Configurable history limit and log-limit setting
- [ ] Implement log retention and enforce the configured log-size limit
- [x] Keyboard shortcuts, destructive-action undo, labels, and visible focus
- [ ] Complete hands-on accessibility verification

## Open-Source Model

Recommended license: **GPL-3.0-or-later**.

This keeps distributed modified versions open. The repository should also include:

- `LICENSE`
- `README.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- public issue templates and roadmap
- reproducible GitHub Actions builds
- checksums for every release
- a policy that core features will never become paid features
- Oxlint must pass before JavaScript or TypeScript changes can be merged

Donations and sponsorship are acceptable, but must not unlock functionality.

## Delivery Plan

### Phase 0: Prototype

**Status: In progress**

Validated on June 6, 2026:

- [x] Tauri shell and basic GUI
- [x] Send one HTTP request through the Rust core
- [x] Display status, headers, and pretty JSON
- [ ] Confirm Windows and macOS builds
  - macOS Apple Silicon application bundle and DMG build successfully.
  - Windows x64 and universal macOS builds are configured in CI but have not yet been confirmed.
- [ ] Prove portable-mode storage beside the executable
  - `portable.flag` ancestor detection and the shared workspace layout are implemented.
  - Physical USB testing on Windows and macOS is still required.

Validation commands passed:

- `corepack pnpm check`
- `cargo check`
- `cargo test`
- `corepack pnpm tauri build --bundles app`

### Phase 1: MVP

**Status: In progress**

- [x] Complete request editor and response viewer
  - [x] Query parameters and editable headers
  - [x] JSON, text, XML, and form URL encoded bodies
  - [x] Basic, Bearer token, and API key authentication
  - [x] Request timeout, redirect control, and cancellation
  - [x] Pretty/raw response body, response search, copy, headers, and metadata
  - [x] Multipart and binary request bodies
  - [x] Response preview, cookies, and save to file
- [x] Collections, folders, history, variables, environments
- [x] Plain-text workspace format
- [x] cURL and Postman import
- [ ] Published portable Windows and macOS release packages

#### Remaining Phase 1 Work

- [ ] Build, test, and publish actual Windows x64 and universal macOS portable packages
- [x] Portable launchers and shared USB folder layout generator
- [x] Encrypted secret vault
- [x] Nested collection folders, rename, duplicate, move, delete, and favorites
- [x] Real multi-request tabs and autosave
- [x] Global, collection, and temporary variable scopes with source explanations
- [x] cURL generation and URL variable highlighting
- [x] JSON tree viewer and syntax highlighting
- [ ] Preserve Postman folder hierarchy and import complete authentication values
- [x] OpenAPI JSON/YAML and broader Postman body/query/header import
- [x] Documented standalone workspace export format
- [ ] Implement log files and enforce the configured log-size limit
- [x] Configurable history limit and pending-write exit warning
- [x] Keyboard shortcuts and destructive-action undo
- [ ] Complete hands-on keyboard, screen-reader, and contrast accessibility verification
- [ ] Test portable mode on physical Windows and macOS machines/USB media

### Phase 2: Testing

- Script sandbox
- Assertions
- Collection runner
- CLI and reports

### Phase 3: Protocols and polish

- OAuth 2.0, certificates, proxy, GraphQL
- WebSocket, SSE, and gRPC
- Plugin API after the internal APIs are stable

## Sources Consulted

- Tauri overview and cross-platform architecture: https://tauri.app/
- Tauri distribution and signing: https://v2.tauri.app/distribute/
- Tauri Windows WebView2 packaging options: https://v2.tauri.app/distribute/windows-installer/
- Tauri macOS app bundles: https://v2.tauri.app/distribute/macos-application-bundle/
- Tauri macOS signing and notarization: https://v2.tauri.app/distribute/sign/macos/
- Microsoft SmartScreen reputation guidance: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Bruno local-first approach: https://docs.usebruno.com/v2/introduction/what-is-bruno
- Bruno source repository: https://github.com/usebruno/bruno
- Hoppscotch source repository: https://github.com/hoppscotch/hoppscotch
- Postman collections: https://learning.postman.com/docs/collections/collections-overview
- Postman variables: https://learning.postman.com/docs/use/send-requests/variables/variables
- Postman scripting and tests: https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-send-request/
- Oxlint usage and setup: https://oxc.rs/docs/guide/usage/linter.html
