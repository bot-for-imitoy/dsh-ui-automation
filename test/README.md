# Tests

The tests drive the plugin's **real** engine and tool definitions (the same
objects the Host registers) against live X11 applications. There are no mocks:
a PASS means the application's own counter label changed, read back over
AT-SPI.

## Requirements

- `Xvfb`, `dbus-run-session` (dbus), `xdotool`, `ffmpeg`
- `python3` with `gi.repository.Atspi` (`python-gobject`)
- to build the fixtures: `pkg-config`, a C compiler, Qt 6 Widgets and GTK 3 dev
  headers

## Run

From the repository root:

```bash
make -C test fixtures        # build the Qt6 and GTK3 control panels
node test/integration.mjs    # 100+ checks: operations, isolation, failures, tools
node test/reliability.mjs    # N attempts per operation (default 30 each)
```

Outputs land in `test/out/` (git-ignored):
`integration.json`, `integration.log`, `reliability.json`, `reliability.log`
and the screenshots taken during the run.

## Optional research probes

The GTK4 pitfalls (fake `extents`, 300 ms debounce, focus stealing) were
investigated with three extra probe applications that are **not part of this
repository** (`app_qt`, `app_gtk3`, `app_gtk4`). If you have them, point
`XVFB_PROBE_DIR` at their directory and the matrix/reliability runners pick
them up automatically:

```bash
XVFB_PROBE_DIR=/path/to/probe node test/integration.mjs
```

Without the variable those cases are skipped with a one-line notice; the
fixtures in `test/fixtures/` cover click, double-click, drag, scroll, text
input (ASCII + CJK), key chords and screenshots for Qt 6 and GTK 3.
