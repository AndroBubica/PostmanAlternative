# Phase 1 Accessibility Verification

## Automated and Source Review

Validated on June 6, 2026:

- `corepack pnpm lint`
- `corepack pnpm build`
- Every request/body editor has an accessible label.
- Request and response tabs expose selected state and support Left Arrow, Right
  Arrow, Home, and End.
- Keyboard shortcuts cover new request, save, send, search, and tab switching.
- Status messages use live status semantics.
- Interactive controls have a visible focus outline.
- Low-contrast secondary text colors were raised for small labels and empty
  states.

## Required Hands-On Matrix

These checks must be completed on packaged applications before Phase 1 can be
marked fully verified.

| Platform | Keyboard | Screen reader | Contrast/zoom | Status |
| --- | --- | --- | --- | --- |
| Windows x64 | Tab, Shift+Tab, shortcuts, tab arrows | NVDA | Windows Contrast Themes, 200% scaling | Pending physical Windows test |
| macOS Apple Silicon | Tab, Shift+Tab, shortcuts, tab arrows | VoiceOver | Increase Contrast, 200% zoom | Pending packaged-app test |
| macOS Intel | Tab, Shift+Tab, shortcuts, tab arrows | VoiceOver | Increase Contrast, 200% zoom | Pending physical Intel Mac test |

For each row:

1. Reach and operate every visible control without a pointer.
2. Confirm focus order follows the visual layout and focus is always visible.
3. Confirm the screen reader announces control name, role, state, errors, and
   request completion.
4. Confirm text and controls remain readable with the listed contrast and zoom
   settings.
5. Record the app version, OS version, assistive-technology version, tester,
   date, and any defects.

