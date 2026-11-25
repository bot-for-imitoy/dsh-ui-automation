Title: Add dsh-ui-automation 2.1.0 — numbered-image UI control for Linux, with GTK4 X11-origin fallback

Body:

## What it is

`dsh-ui-automation` gives DSH a **numbered-image** way to drive a Linux GUI. It screenshots the
configured display, enumerates AT-SPI elements, draws yellow numbered badges (`1..N`) and thin
outlines onto a cropped PNG, and returns the image path plus an index list. The agent then operates
by number only: `ui_click`, `ui_double_click`, `ui_scroll`, `ui_drag`, `ui_type`. Every action
clicks the recorded rectangle's centre with XTEST, waits `afterSeconds`, captures the **next**
numbered image, and returns it. Indices from the previous image are dead.

The full surface is six tools:

| Tool | Parameters |
|---|---|
| `ui_screenshot` | — |
| `ui_click` | `index`, `button?`, `afterSeconds?` |
| `ui_double_click` | `index`, `intervalMs?`, `afterSeconds?` |
| `ui_scroll` | `index`, `direction`, `amount?`, `afterSeconds?` |
| `ui_drag` | `fromIndex`, `toIndex`, `steps?`, `afterSeconds?` |
| `ui_type` | `text?` or `keys?`, `index?`, `afterSeconds?` |

There is no launch tool and no sandbox management: the application owner starts the app and gives
the plugin a `display` (the tests start Xvfb + a private D-Bus themselves). There is deliberately
no name/role/path addressing and no raw x/y addressing — the contract is “number = pixel”.

## GTK4 support (new in 2.1.0)

GTK 4.24's AT-SPI bridge hardcodes every `SCREEN` coordinate to `(0,0)` while `GetExtents(WINDOW)`
is correct ([investigation](docs/GTK4-GEOMETRY.md)). The plugin now detects that shape **per
application** and rebuilds each rectangle from the X11 toplevel's content origin plus the WINDOW
rectangle. The toplevel is matched by pid and client-area size (`xdotool` + `xwininfo`), dialogs and
popovers are handled per frame, and `_GTK_FRAME_EXTENTS` is honoured when the toolkit advertises it.

Safety is the point of the design:

- GTK3/Qt never match the detection shape and are untouched;
- if the X11 origin cannot be computed, that application's targets are **dropped** with a
  structured warning (`E_NO_X11_UTILS` / `E_NO_X11_WINDOW` / `E_NO_X11_ORIGIN`) and
  `geometryTrusted: false` — never renumbered at `(0,0)`;
- `gtk4OriginFallback=false` refuses GTK4 apps explicitly;
- a final global guard still rejects a capture whose remaining targets all share one origin.

## Why it is useful

- **One contract.** A click is always an XTEST click at the centre of a numbered rectangle.
- **Inspectable.** The exact frame that produced the indices is on disk.
- **Bounded by construction.** Cropped to the windows, capped target count, pruned old images.
- **Safe failure.** A toolkit whose coordinates cannot be trusted loses its indices instead of
  producing wrong clicks.

## How it is verified

- `test/integration.mjs`: **80/80 checks** with the fixtures shipped in this repository (Qt 6,
  GTK 3, GTK 4): screenshot/crop, stable numbering, click, double-click, drag, wheel, ASCII/CJK
  typing, key chords, index errors, attachment rendering, tool entry points, **GTK4 fallback**
  (numbered, click increments the counter, window move shifts every rect by exactly +200/+150,
  pixel bbox error 0 px, fallback-off refusal) and a **mixed Qt6+GTK3+GTK4 desktop** (18 targets,
  each click lands on its own app, fallback-off drops only GTK4).
- `test/reliability.mjs`: **450 operations (15 groups × 30), 100% success**, measured end-to-end:
  screenshot 493–562 ms mean, actions 706–968 ms mean, p95 ≤ 1028 ms. Full table in `VERIFY.md`.
- Measured accuracy: GTK4 fixture **0 px** (pixel bbox assertion); real libadwaita apps 5–11 px and
  popovers ~8 px per the report — still inside the control's hit area.
- WorkBuddy (a real Electron app) was numbered through the plugin itself: 40 targets, 1025×710.

Screenshots from the verification run:

- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/qt6-panel.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/gtk3-panel.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/gtk4-numbered.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/gtk4-no-geometry.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/workbuddy-numbered.png

## Limitations

- Linux/X11 only; no Wayland-native path.
- GTK4 fallback needs `x11-utils`; without it the app is refused with a warning.
- libadwaita/popover residual 5–11 px (clicks still land); `_GTK_FRAME_EXTENTS` is used when present.
- Electron needs `--force-renderer-accessibility`.
- Indices are valid only for their own image; a change made outside the plugin requires a fresh
  `ui_screenshot`.
- No OCR: elements absent from AT-SPI appear in the screenshot but are not numbered.
- The plugin can drive a real desktop; tools are allow-listed per session/workspace by default.

## Checklist

- [x] public repository, MIT licensed, Linux only (documented in both READMEs)
- [x] `dsh.bundle.patch` manifest (`cordis.patch.yml`)
- [x] `dsh-plugin` topic
- [x] installation documented for both `github:owner/repo` and a local checkout
- [x] only adds `data/plugins/bot-for-imitoy__dsh-ui-automation.yml`
