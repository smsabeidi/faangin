# Overlay interaction repair 0.3.3

The overlay now opens with mouse input enabled. Only its bounded logo/status area is draggable; header controls, menus, text fields, images, and the answer canvas do not drag the window. Explicitly opening or reopening the overlay restores interaction. Background answer updates still use nonactivating presentation and preserve an explicitly selected click-through mode. Click-through is an opt-in; Control–Option–I and the application/status menu provide recovery.

The Settings shortcut now opens the workspace Settings when used from the overlay. Capture & solve remains Control–Option–S. Cancelling an in-flight region preview and immediately invoking Capture & solve waits for the previous native acquisition to finish, revalidates the operation, then captures a fresh image exactly once. The wait has a deadline and respects Stop, session/configuration changes, shutdown, and native draining. It does not retry generation or substitute the cancelled region's image.

## Source recovery

The user confirmed `/Users/admin/Documents/desk/faangin` as the moved project. That checkout identified as 0.3.0 while the installed app was 0.3.2. The current source changes were recovered from verified local code-edit history into staging, without replaying arbitrary commands or replacing the original checkout. The recovered 0.3.2 source passed its **580 tests**, and all **15 production output files matched the installed 0.3.2 ASAR byte for byte**. The 0.3.3 fixes were then applied to that verified TypeScript baseline. Original source files are backed up before restoration into the moved project.

## Verification

The final source passes **588 tests**, strict TypeScript, and the production build. The focused native contracts cover fresh interaction, nonactivating output, explicit click-through, reopening, screenshot cancellation/deadline/drain behavior, and shutdown. The reusable `scripts/overlay-interaction-qa.mjs` checks actual native BrowserWindow focusability plus renderer action flows using a disposable profile, synthetic screenshots/audio state, and a localhost provider. It verifies the original default-mode failure before any forced recovery; no test step silently enables interaction to hide the defect.

Source and packaged results, public screenshots, exact artifact hashes, source restoration details, and installation observations are archived with the candidate. A 110 px drag handle is checked at 480 px and 360 px widths. The checks cover capture/solve, selected-image review, Answer latest without images, duplicate request coalescing, cancel, quota errors, region Cancel → immediate single-click capture, More keyboard/Escape, collapse, Smart policy, hide/reopen, listening consent, synthetic audio pause/stop, a missing-key Resume guard, and overlay Settings navigation.

These fixtures do not certify physical macOS pointer routing, every recording application's protection behavior, OS file-picker interaction, actual microphone/system audio resume, or live provider answer quality. The app remains an unsigned local development artifact. No claim of universal 100% operation or process invisibility is made.


## Final acceptance and installed artifacts

Source and packaged checks each passed all **22 overlay interaction checks**, **9 additional localhost fixture responses**, and **four visually reviewed light/dark screenshots** at 480 × 700 and 360 × 550. Both general interview smoke runs also passed **21 localhost fixture requests**. Actual native BrowserWindow focusability is true on first creation/reopening and false only after explicit click-through opt-in. Tests include the strict single-click Region Cancel → Capture & solve sequence and the overlay Settings shortcut. No real provider request, user screen upload, or physical recording occurred.

The restored project built successfully from `/Users/admin/Documents/desk/faangin`. All **15 compiled output files** match the candidate, installed, and normal-launch ASAR archives. All regular bundle files match across those copies; the Desktop installer matches the candidate. The actual app at `/Applications/Faangin.app` is updated to 0.3.3. It was not running during replacement and was not launched after installation. Reopen it normally to use the repair.

The previous source archive, previous app bundles, exact source fingerprint, final logs, public screenshots, and artifact hashes are retained under `dist/source-backups`, `dist/previous-launch`, and `dist/interaction-repair-candidate`. `source-restoration.json` records the exact backup location; `build-provenance.json` and `SHA256SUMS` bind the checks to the installed artifact. The newer source was restored without changing user data or credentials.
