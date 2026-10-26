# Permission-first setup · 0.4.2

Access setup is now the first screen, before the workspace, overlay, or optional product tour. Users grant microphone, screen capture, and computer audio access through one guided sequence. The app opens the correct operating system controls, checks status automatically after returning, and continues the sequence without overlapping permission prompts. Denials show concrete recovery steps rather than a generic error.

## Readiness and configuration

Microphone and screen access use OS permission states. Computer audio is a separate capability: a bounded local check requests a display-audio stream, confirms a live audio track, and immediately stops every track. It does not read audio samples or screen pixels, create an audio processing graph, transcribe, save media, or call an AI provider.

Continue becomes available only after all required access is ready. Completion is saved in the main-process `access-setup` configuration independently of session history and the optional guide. Faangin configures both audio inputs and the remote-call question source, keeps automatic replies off, applies the user's screen-share privacy choice, and routes to the workspace or the existing provider connection screen. Listening starts only when the user chooses it.

The screen-share privacy checkbox requests native content protection where supported. It is an app setting, not a separate OS permission. Modern macOS capture applications can still include the window; the UI asks users to check their sharing preview and does not promise universal invisibility.

## Future launches and revoked access

A saved computer-audio timestamp is historical evidence, not current permission. Each process begins without a current audio proof. After completed setup and consent, one bounded background check verifies computer audio on the next launch, provided microphone and screen access remain granted. Failure closes the gate and does not retry in a loop. Later launches wait for a manual check, and once one passes the consented startup check resumes; a failed check never revokes consent. New installs never start this check before the user's setup action.

Focus and visible setup polling re-read OS status without reopening streams or prompts. Runtime permission loss stops capture, cancels pending assistance, hides the overlay, and returns to setup. Existing RAM-only session data is retained; the setup screen exposes a Save current session action before any manual OS-requested restart.

## Enforcement and verification

The main process enforces readiness for capture, screenshots, region selection, generation, provider connection tests, overlay operations, native menus, and global shortcuts. Renderer navigation, Escape, a saved optional-tour flag, or a forged completion flag alone cannot bypass required access. Stop, export, and access management stay available.

`scripts/access-setup-qa.mjs` uses disposable profiles with explicit, isolated permission fixtures. It checks denied and independent permission states, sequential prompts, automatic status updates, backend and shortcut guards, probe cleanup, configuration without recording, persistence, revocation, and the single consented startup check. It does not alter the host's real OS permissions. Physical native permission dialogs still require user approval.
