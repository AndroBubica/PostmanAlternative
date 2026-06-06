# Interface Completion Plan

This plan covers controls and workflows that are visible in the desktop
interface but are incomplete, inconsistent, or likely to lose user state.
Phase 2 should not be considered release-ready until the P0 and P1 sections are
complete and verified in the packaged Tauri application.

## Audit Scope

- Request editor, response viewer, tabs, history, collections, environments,
  variables, vault, scripts, assertions, collection runner, imports, exports,
  settings, and keyboard behavior.
- Static code review, rendered-interface review, TypeScript build/lint, and Rust
  tests.
- Current automated checks pass, but there is no automated React/interface test
  suite and only two CLI Phase 2 unit tests.

## P0: Protect User Data and State

### Preserve complete tab state

Current behavior:

- Tabs preserve the response and error, but lose test results and the selected
  request/response views when switched.
- Closing a dirty tab does not warn the user.
- Deleting an open request leaves other tabs for that deleted request open.

Implementation:

- Replace the separate active-request state fields with a single `TabState`
  model, or extend `OpenTab` to include `testResults`, selected views, dirty
  state, and request state.
- Capture the active tab before every switch, close, delete, and new-tab action.
- Confirm before closing a dirty tab when autosave is disabled or a write is
  pending.
- Close all tabs associated with a deleted request.

Acceptance:

- Editing, sending, viewing tests, switching tabs, and switching back restores
  the exact prior state.
- Dirty work cannot be silently discarded.

### Make collection-delete undo complete

Current behavior:

- Deleting a collection removes every descendant folder and request.
- Undo restores only the selected collection and requests directly inside it.
  Nested folders and their requests remain deleted.

Implementation:

- Before deletion, capture the complete descendant collection and request set.
- Restore collections parent-first, then restore every affected request.
- Prefer moving this snapshot/restore operation into backend commands so it is
  atomic and testable.

Acceptance:

- Undo after deleting a deeply nested collection restores the exact hierarchy,
  variables, requests, and favorites.

### Make variable and secret editing safe

Current behavior:

- Variable and vault values are written on every keystroke, allowing writes to
  race and older values to overwrite newer values.
- There is no remove-variable action.
- Converting a plain variable to a secret clears its value without migrating it
  into the vault.
- Renaming a secret does not migrate or remove its vault entry.

Implementation:

- Edit variables in local draft state and save with a debounced, serialized
  write queue or an explicit Save action.
- Add remove-variable with confirmation for secrets.
- Add backend vault commands for atomic rename, migrate-to-secret, and
  convert-to-plain operations.
- Show locked-secret state without allowing accidental replacement by an empty
  value.

Acceptance:

- Fast typing, secret conversion, rename, lock/unlock, and deletion never lose
  or resurrect stale values.

## P1: Make Core Request Workflows Consistent

### Use one request builder everywhere

Current behavior:

- Interactive Send, desktop collection runner, Copy cURL, and CLI each build
  requests differently.
- Interactive Send does not resolve variables in auth fields or multipart
  fields.
- Disabled headers can still fail because their variables are resolved before
  disabled rows are filtered.
- Copy cURL omits multipart and binary bodies.

Implementation:

- Introduce a shared, pure frontend request-builder module used by Send,
  desktop runner, and cURL generation.
- Filter disabled rows before variable resolution.
- Resolve URL, params, enabled headers, auth fields, form fields, multipart
  names/values/paths, and body consistently.
- Generate correct cURL for text, form, multipart, and binary bodies.
- Align the CLI builder behavior and document intentional desktop/CLI
  differences.

Acceptance:

- The same saved request targets the same URL, headers, auth, and body when sent
  interactively, run from a collection, copied as cURL, or run through the CLI
  where supported.

### Repair history behavior

Current behavior:

- History records a temporary transport request ID instead of the saved request
  ID.
- Clicking history overwrites only the current name, method, and URL, leaving
  unrelated headers, auth, body, scripts, and assertions in place.

Implementation:

- Store the saved request ID when available.
- Clicking a linked history entry opens the saved request in a tab.
- Clicking an unlinked entry opens a clean unsaved request populated from the
  history snapshot.
- Store enough request snapshot data in history to reproduce an unsaved send,
  or label history as URL-only and clear all unrelated editor state.

Acceptance:

- Opening history never combines data from two different requests.

### Separate response success from script/test failure

Current behavior:

- A post-response script error clears a successful HTTP response and reports
  the whole request as failed.
- Pre-request script tests are discarded.
- Script-produced variable updates are returned but not applied or clearly
  scoped.

Implementation:

- Treat transport, pre-script, post-script, and assertion outcomes separately.
- Preserve successful responses when post-response scripts fail.
- Display script errors as failed test results with phase labels.
- Define variable mutation semantics: temporary for the current run by default,
  with explicit APIs for persisted scopes.

Acceptance:

- A successful HTTP response remains inspectable even when a post-response test
  or script fails.

## P1: Finish Phase 2 Interface Behavior

### Complete collection-runner interaction

Current behavior:

- Starting a run does not open the Runner response tab, so the action appears
  to do nothing.
- There is no run cancellation.
- Unexpected failures can leave `runningCollection` stuck.
- Per-request failures show limited details.

Implementation:

- Open and focus the Runner tab immediately when a run starts.
- Wrap runner state in `try/finally`.
- Add cancellation and current-request progress.
- Expand each result to show failed assertions, script errors, URL, and timing.
- Disable additional run buttons while a run is active.

Acceptance:

- Every run has immediate visible feedback, can be cancelled, and always leaves
  the interface in a usable state.

### Make assertions easier to configure correctly

Current behavior:

- Every assertion kind offers every operator, including combinations that do
  not make sense.
- Inputs do not clearly indicate which fields are required.
- JSON path support is limited to dot-separated object keys.

Implementation:

- Offer operators appropriate to each assertion kind.
- Hide or disable Expected for `exists`; require Target only for header and JSON
  path assertions.
- Validate assertions before send/save and show inline errors.
- Implement shared JSON-path behavior for desktop and CLI, including array
  indexes.

Acceptance:

- Invalid assertion combinations cannot be saved accidentally, and desktop/CLI
  results match.

### Harden and define the script sandbox

Current behavior:

- The interface says network APIs are removed, but the sandbox contract is not
  tested and other worker-global capabilities are not explicitly controlled.
- Desktop scripts and CLI scripts behave differently.

Implementation:

- Define the supported script API and prohibited globals.
- Add sandbox capability tests for network, storage, worker creation, imports,
  timeout, and error reporting.
- Clearly mark CLI-incompatible scripts in the editor and runner.
- Decide whether CLI script execution is required for Phase 2 completion or is
  an accepted documented limitation.

Acceptance:

- The sandbox claim is backed by tests, and users see incompatibilities before
  starting a CLI run.

## P2: Complete Visible Management Controls

### Environments and collections

- Add rename and delete environment actions.
- Show collection paths in the request destination selector so duplicate folder
  names are distinguishable.
- Add a direct request Move action from the sidebar.
- Make the collection chevron actually collapse/expand folders, or remove it.
- Persist collapsed state per workspace if collapse is implemented.

### Variables and settings

- Add remove-variable actions and clear messaging when no environment or
  collection scope is available.
- Move workspace-wide history/log/autosave settings out of the per-request
  Settings tab.
- Validate numeric settings and show save failures instead of using unhandled
  fire-and-forget writes.

### Feedback and error handling

- Route every async button action through one error-handling helper.
- Show success/failure feedback for response copy/save, cURL copy, imports,
  exports, vault operations, settings, and report saves.
- Clear stale errors after a later successful action.
- Replace prompt-based collection/environment workflows with accessible dialogs.

### Import and export

- Improve cURL import parsing for common options such as `--url`, basic auth,
  form data, and binary data.
- Warn about unsupported cURL options instead of silently dropping them.
- Validate generated JSON and JUnit reports.

## P2: Interface Quality

- Make the top action bar and request line usable at smaller window widths.
- Add horizontal tab overflow or scrolling when many requests are open.
- Ensure collection actions are discoverable without requiring hover.
- Complete keyboard, VoiceOver/NVDA, contrast, and zoom verification.
- Remove duplicate CSS declarations and add empty/error states for collections,
  history, environments, and variables.

## Implementation Sequence

1. Extract pure request building, assertion evaluation, and report generation
   modules. Add unit tests before changing behavior.
2. Refactor tab state and add dirty-close protection.
3. Add backend atomic operations for collection restore and secret migration.
4. Repair history and environment/variable management.
5. Repair script/test error separation and runner interaction.
6. Complete cURL/import/report behavior and async error feedback.
7. Add interface automation and finish accessibility/platform verification.

## Required Automated Coverage

- Frontend unit tests for request building, variable precedence, assertions,
  cURL generation, report generation, and tab-state reducers.
- Backend tests for recursive delete/restore, environment deletion, serialized
  writes, and vault secret migration.
- CLI tests for every assertion kind/operator, nested collections, environment
  selection, exit codes, JSON reports, and JUnit escaping.
- Packaged-app smoke workflows for save/load, tabs, history, runner, vault,
  import/export, and cancellation.

## Release Gate

Phase 2 is ready to release only when:

- All P0 and P1 items are complete.
- No visible control silently fails or drops data.
- Desktop runner and CLI behavior differences are explicit and tested.
- Automated checks cover the Phase 2 workflows.
- The packaged macOS and Windows interfaces pass the manual smoke checklist.
