# test/gtk4-probe — GTK4 geometry research probes

Throw-away research tooling behind [`docs/GTK4-GEOMETRY.md`](../../docs/GTK4-GEOMETRY.md).
Nothing here runs under `node test/integration.mjs`; it is kept so the report's
numbers can be reproduced.

Every probe owns a private Xvfb display, a private session bus **and a private
a11y bus** (`AT_SPI_BUS_ADDRESS`). That matters: the default a11y bus
(`~/.cache/at-spi/bus` or `$XDG_RUNTIME_DIR/at-spi/bus_0`) is shared with the
live desktop session, so probing there mixes the fixture with real apps and
races the real `at-spi2-registryd`.

| File | Purpose |
|---|---|
| `env.sh` | start Xvfb `:15x` + private session bus + private a11y bus + registryd |
| `use.sh` | re-export that environment in a fresh shell |
| `dump.py` | walk the AT-SPI tree over raw D-Bus and print every geometry API; `--gi` uses libatspi (the plugin's path), `--cache` reads `org.a11y.atspi.Cache` |
| `iface_probe.py` | exercise Component/Text/Hypertext/Value on one node, incl. `GetAccessibleAtPoint`/`Contains` |
| `verify_fix.py` | derive screen rects as *X11 toplevel origin + GetExtents(WINDOW)*, then click the derived centre and read the fixture's own status label back |
| `panel_gtk4_popover.c` | GTK4 fixture with a `GtkMenuButton` + `GtkPopover` (secondary surface) |

```bash
# 1. environment (Xvfb :151, private buses)
./test/gtk4-probe/env.sh 151          # prints DISPLAY + bus addresses

# 2. app under test
. ./test/gtk4-probe/use.sh 151
./test/fixtures/panel_gtk4 &

# 3. measure
. ./test/gtk4-probe/use.sh 151
python3 test/gtk4-probe/dump.py --depth 4            # SCREEN vs WINDOW vs PARENT
python3 test/gtk4-probe/verify_fix.py --name panel_gtk4 --click "点击 Click"

# 4. tear down (pass the display number as $2, not $1)
./test/gtk4-probe/env.sh stop 151
```

`env.sh` starts `at-spi2-registryd` explicitly: D-Bus activation of
`org.a11y.atspi.Registry` on a hand-rolled a11y bus times out here.

Optional popover fixture:

```bash
gcc -O1 test/gtk4-probe/panel_gtk4_popover.c -o /tmp/panel_gtk4_popover \
    $(pkg-config --cflags --libs gtk4)
```
