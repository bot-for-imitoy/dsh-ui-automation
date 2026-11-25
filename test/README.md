# Tests

The plugin never launches applications, so each test owns the whole environment:
one Xvfb display, a private `dbus-daemon` session bus, and the fixture. The
plugin is then pointed at that display (and bus) through its normal settings.

| File | Purpose |
|---|---|
| `fixtures/panel_qt.cpp` | Qt 6 panel: click, double-click, drag, wheel, text, status label |
| `fixtures/panel_gtk3.c` | same panel for GTK 3 |
| `fixtures/panel_gtk4.c` | GTK 4 panel; its all-zero AT-SPI extents exercise the X11-origin fallback (and `E_NO_GEOMETRY` when the fallback is disabled) |
| `lib/env.mjs` | Xvfb + private D-Bus + fixture lifecycle, AT-SPI a11y switch |
| `lib/checks.mjs` | PASS/FAIL collector, status parsing, index-stability helpers |
| `integration.mjs` | numbered-image matrix, index errors, GTK4 fallback (numbering, window move, pixel check, fallback-off), mixed Qt6+GTK3+GTK4 desktop, tool entry points |
| `reliability.mjs` | 30 attempts per operation per fixture, with latency percentiles |
| `capture-screenshots.mjs` | regenerates the curated images in `../screenshots/` |
| `smoke.mjs` | one-fixture sanity run while developing |

```bash
make -C test fixtures            # Q: pkg-config Qt6Widgets/gtk+-3.0/gtk4
node test/integration.mjs
node test/reliability.mjs
node test/capture-screenshots.mjs
```

Every assertion reads the fixture's own `clicks=… dclicks=… drags=… wheel=… text='…'`
label back through AT-SPI — the fixture's status line is the source of truth, not
the plugin's return value.
