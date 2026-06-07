# API Lantern v0.2.0

API Lantern v0.2.0 adds Phase 2 request testing and automation workflows, plus
interface and architecture improvements across the desktop app and CLI.

## Highlights

- Isolated pre-request and post-response JavaScript execution, disabled by
  default for safety.
- Friendly assertions for status, headers, JSON paths, response bodies, and
  timing.
- Nested collection runs with progress, cancellation, and pass/fail results.
- JSON and JUnit report exports.
- A workspace CLI runner for local automation and CI.
- More robust request, tab, import, save, and error-handling workflows.
- Refactored frontend and Rust modules with shared runner, workspace, request,
  assertion, report, and response-formatting logic.
- Added frontend and Rust tests covering the new workflows.

## Packages

- Portable Windows x64 package.
- Universal macOS package for Intel and Apple Silicon.
- SHA-256 checksum files for both packages.

Packages and checksums are produced by the tagged release workflow:
https://github.com/AndroBubica/PostmanAlternative/releases/tag/v0.2.0

## Remaining Verification

- Independently download and verify the published Windows and macOS packages.
- Test portable mode using physical USB media on Windows and macOS.
- Complete hands-on keyboard, NVDA/VoiceOver, contrast, and zoom verification.
