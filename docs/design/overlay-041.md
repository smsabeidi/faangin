# Overlay recovery and resizing · 0.4.1

The reported upgrade failure combined two concrete problems: saved overlay bounds of 1512×949 on a 1512×870 work area, and a running 0.3.0 candidate process receiving launches intended for the installed 0.4.0 app. The previous renderer viewport checks did not cover restored native geometry. The saved 35% opacity was also retained from the older app.

The overlay now restores oversized or full-screen saved bounds to a reachable 480×560 window. Ordinary user sizes and display-local positions remain saved. Its native minimum is 360×400 and its maximum is 720×840, further constrained by the current display’s available work area. A 16 px gutter keeps the header and resize corner reachable. Workspace window sizes remain independent.

A visible bottom-right grip resizes the actual native window. Pointer events use screen coordinates and pointer capture; requests are coalesced with at most one IPC call in flight. Arrow keys change size by 16 px, or 64 px with Shift. Collapse stays 54 px high and restores the previous expanded size. Native full-screen and maximize are disabled, including after macOS resizability changes. Unrelated settings saves do not resize the overlay.

More opens with Compact, Comfortable, and Reset size & position controls. Reset is also available in Settings → Appearance and the native menu bar menu, so recovery does not depend on reaching a window edge. The native menu and tray tooltip show the running version. Readable background is an explicit action that selects 94% opacity without changing theme, font, or privacy preferences.

`scripts/overlay-layout-qa.mjs` verifies actual BrowserWindow bounds, content bounds, native min/max and resizability flags. It exercises the user’s exact saved dimensions, an oversized stored height, disconnected-display geometry, pointer/keyboard resizing, both presets, all reset entry points, collapse/expand, and persistence after a complete restart. It supports `FAANGIN_APP_PATH` for the finished app and records its archive hash. These checks use trusted renderer input and real native geometry; they do not claim physical OS edge hit-testing or physical monitor unplug testing.

The legacy user process was preserved until the user explicitly authorized restarting its RAM-only session. The verified replacement was then launched from Applications with an explicitly approved 94% background. Every other saved preference was compared and preserved; session storage and credentials were not erased.
