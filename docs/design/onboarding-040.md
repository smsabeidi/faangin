# First-run experience and compact overlay · 0.4.0

The first launch introduces the workspace in four short steps: Welcome, Your focus, Access, and Ready. It uses the system appearance, opaque content surfaces, clear typography, and a single primary action on each step.

## Setup behavior

- Interview practice and Meetings map directly to the existing workspace modes. The choice becomes the starting mode without replacing an existing session.
- Permissions are optional. Their badges use the operating system’s actual state. Opening the guide does not start audio, capture a screen, send context, or test a provider. Clicking **Allow access** requests native microphone consent or registers screen access without pixel thumbnails; previously denied access opens the appropriate system settings instead.
- Progress and the chosen mode are saved locally under `faangin.onboarding.v1`. Closing the app midway resumes the guide. Explore first, Escape, and the close button finish the guide; it can be reopened with **Settings → Replay setup guide**.
- Existing connected workspaces with saved sessions continue opening directly. The guide remains available in Settings.
- The last step describes Capture, moving/collapsing the overlay, and Settings. Capture shortcuts are shown only when they were successfully registered. Connection status reports configuration, without claiming a successful provider test.
- Keyboard focus enters the guide, stays inside it while navigating, and moves to the heading when the step changes. Mode choices support arrow keys. The center scrolls independently so navigation stays reachable on smaller displays.

## Overlay behavior

The header keeps one primary Capture action alongside microphone, More, and collapse. Microphone access remains visible at the 360 px minimum width. More contains secondary controls, with arrow-key navigation and Escape to close and restore focus.

Answers use the configured text size with clear spacing. Model, timing, token counts, and included-context diagnostics live under **Response details** in the overlay. Interruption, updated-question, errors, source references, and provisional-speech notices remain visible. The response scrolls independently of the composer.

New profiles use 94% background opacity and a 560 px expanded overlay, with system appearance. Saved preferences remain respected, including a transparent background at 0%. Reduced transparency, reduced motion, and increased contrast follow the OS settings. Collapsing keeps the existing 54 px native window and restores its prior expanded height.

## Local verification

Run `npm run verify` for the regression suite, production build, and isolated desktop fixture workflow. Run `node scripts/onboarding-qa.mjs` for setup progression, mode selection, keyboard focus, permission-state accuracy, restart persistence, replay, small-window geometry, and saved local screenshots. The latter uses a disposable profile with no real credentials or recordings.

Screenshots and generated reports are saved under `output/qa/onboarding/`. These checks establish the rendered UI and local behavior; native permission approval and live provider/audio quality require the user’s own hardware and connection.
