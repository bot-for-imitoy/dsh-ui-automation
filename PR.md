Title: Add dsh-ui-automation — headless Xvfb UI automation with state readback

Body:

## What it is

`dsh-ui-automation` gives DSH a disposable GUI lab. Each `ui_launch` starts the
application in a private Xvfb display, a private D-Bus session and its own
`XDG_RUNTIME_DIR`; a bundled AT-SPI driver then exposes ten `ui_*` tools:

`ui_launch`, `ui_click`, `ui_double_click`, `ui_drag`, `ui_scroll`, `ui_type`,
`ui_tree`, `ui_screenshot`, `ui_close`, `ui_list`.

Controls are addressed semantically (`name` + optional `role`/`index`/`match`,
or the `path` from `ui_tree`) with explicit `x`/`y` as a fallback. Text input
prefers AT-SPI `EditableText` and falls back to XTEST, so CJK text works in a
private X11 shell without an input method daemon.

## Why it is useful

An agent that renders or modifies a UI should be able to prove that the UI
works. This plugin closes that loop inside DSH:

- every action is followed by a diff of the accessibility tree, so the result
  says `effect.changed: false` instead of pretending a dropped toolkit event
  succeeded;
- actions are paced per toolkit (Qt ≥120 ms, GTK4 ≥300 ms) and a double-click
  is followed by a 600 ms quiet window, because both were measured to be
  necessary;
- instances are fully isolated from each other and from the user's desktop,
  and are torn down with their whole process group;
- the tools are allow-listed per workspace/session, so a launch-and-type
  surface is not exposed to every conversation.

It is explicitly a sandbox/regression tool, not a remote desktop: it never
attaches to the user's real windows.

## How it is verified

- `test/integration.mjs`: **56/56 checks** with the two fixtures shipped in
  this repository (Qt 6 and GTK 3) — semantic and coordinate addressing,
  double-click, 12-step drag, wheel, ASCII/CJK text via AT-SPI and XTEST, key
  chords, screenshots, parallel isolation, launch-failure paths and tool entry
  points. Pointing `XVFB_PROBE_DIR` at the three external research probes
  (Qt 6 / GTK 3 / GTK 4) raises it to 104/104; both runs are recorded in
  `VERIFY.md`. Only the 56-check run is reproducible from this repository
  alone, which is why it is the headline number.
- `test/reliability.mjs`: **300 operations (10 groups × 30), 0 failures** on
  the shipped fixtures, mean 118–782 ms and p95 ≤ 805 ms per group; the
  480-operation (16 groups) figure in `VERIFY.md` includes those external
  probes. Per-group success rate and mean/p50/p95/max latency are tabulated
  there.
- Every assertion reads the fixture's own counter label over AT-SPI, so a PASS
  means the application really changed state.

Screenshots from the verification run:

- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/qt6-panel.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/gtk3-panel.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/gtk4-panel.png

## Checklist

- [x] public repository, MIT licensed
- [x] `dsh.bundle.patch` manifest (`cordis.patch.yml`)
- [x] `dsh-plugin` topic
- [x] installation documented for both `github:owner/repo` and a local checkout
- [x] only adds `data/plugins/bot-for-imitoy__dsh-ui-automation.yml`
