# Portable Package Verification

## Release Artifacts

The `Portable desktop packages` workflow builds, tests, assembles, checksums,
launch-smoke-tests, and uploads:

- `API-Lantern-Windows-x64.zip`
- `API-Lantern-macOS-universal.zip`

Tagged builds also publish both archives and their SHA-256 checksum files to
the GitHub release.

Before upload, each CI runner extracts its archive, verifies the expected
portable layout, launches the packaged executable, and confirms that
`workspace/api-lantern.json` is created beside the application.

## Physical USB Test Matrix

Use a newly formatted USB drive for each filesystem under test. Do not mark a
row complete using a local folder or disk image.

| Host | USB filesystem | Package | Status |
| --- | --- | --- | --- |
| Windows 10 x64 | exFAT | Windows x64 | Pending |
| Windows 11 x64 | exFAT | Windows x64 | Pending |
| macOS Apple Silicon | exFAT | Universal macOS | Pending |
| macOS Intel | exFAT | Universal macOS | Pending |

For each row:

1. Verify the archive checksum, extract it directly to the USB drive, and use
   the supplied launcher.
2. Create a collection, nested folder, request, environment, secret, history
   entry, and log entry.
3. Exit cleanly, eject, reconnect, relaunch, and confirm all data remains in
   `workspace/` on the USB drive.
4. Confirm no API Lantern workspace was created in the user's application-data
   folder.
5. Move a folder, send a request, enforce a small history/log limit, and
   confirm the limits persist after relaunch.
6. Record host OS/version, CPU, USB model/filesystem, app version, tester,
   date, launch warnings, and defects.
