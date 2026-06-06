#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then shift; fi
ROOT="${1:-release/API-Lantern}"
mkdir -p "$ROOT/Windows-x64/runtime" "$ROOT/macOS" "$ROOT/workspace" "$ROOT/exports"
touch "$ROOT/portable.flag"
cp packaging/Start-Windows.cmd "$ROOT/Start-Windows.cmd"
cp packaging/Start-macOS.command "$ROOT/Start-macOS.command"
cp packaging/PORTABLE-README.txt "$ROOT/README.txt"
chmod +x "$ROOT/Start-macOS.command"
printf 'Portable layout created at %s\n' "$ROOT"
