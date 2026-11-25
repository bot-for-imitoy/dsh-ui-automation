# dsh-ui-automation — numbered-image UI control for DeepSeek Harness

**Linux only.** The plugin drives an X11 display through XTEST and reads the screen through
AT-SPI2. macOS and Windows are not supported.

The agent never addresses a control by name, role or coordinate. It takes a **numbered
screenshot**: every actionable element gets a yellow badge (`1..N`), a thin outline, and an entry
in a sidecar JSON. The agent then says “click 4”. Every action clicks the centre of rectangle 4
with XTEST, waits `afterSeconds`, captures a **new** numbered image, and returns it. Indices from
the previous image are dead the moment the next image exists.

![Qt 6 fixture after a scripted run: clicks=1 dclicks=1 drags=1 dragdist=176 wheel=-240 text='中文键盘输入'](screenshots/qt6-panel.png)

## Why numbered images

- **One contract.** “Number = pixel.” No semantic tree API to reconcile with a coordinate
  fallback, no toolkit-specific action names — a click is always an XTEST click at the centre of
  the numbered rectangle.
- **Inspectable.** The model (or a human reviewing the session) can `read_image` the exact frame
  that produced the indices. A stale numbering is visible, not hidden.
- **Works where accessibility is thin.** The numbering filter picks actionable roles/actions; if
  the tree is poor the model still sees the screenshot and can fall back to reading it.
- **Bounded by construction.** The screenshot is cropped to the windows, indices are capped, and
  old images are pruned; a session cannot accumulate an unbounded index space.

## What it is / is not

- **It is** a screen-level driver: point it at a display (an Xvfb used by your tests, or a real
  desktop) and drive it by number.
- **It is not** a launcher or a sandbox. There is no `ui_launch`: the test/app owner starts the
  application and gives the plugin a `display`. The plugin only screenshots and clicks.
- **It is not** a remote-desktop protocol. It uses the local X server and AT-SPI.
- **It is not** OCR: rectangles and labels come from the accessibility tree. Text the tree does
  not expose still appears in the screenshot, but is not numbered.

## Tools

| Tool | Parameters | Returns |
|---|---|---|
| `ui_screenshot` | — | `imagePath`, `imageId`, `display`, `screen`, `crop`, `targets[]` |
| `ui_click` | `index`, `button?`, `afterSeconds?` | action details + next numbered image |
| `ui_double_click` | `index`, `intervalMs?`, `afterSeconds?` | action details + next numbered image |
| `ui_scroll` | `index`, `direction` (`up/down/left/right`), `amount?`, `afterSeconds?` | action details + next numbered image |
| `ui_drag` | `fromIndex`, `toIndex`, `steps?`, `afterSeconds?` | action details + next numbered image |
| `ui_type` | `text?` or `keys?`, `index?`, `afterSeconds?` | typed/readback details + next numbered image |

`index` is 1-based and only valid for the most recent numbered image. Out-of-range indices return
a structured `E_INDEX`; an action before any screenshot returns `E_NO_IMAGE`.

`afterSeconds` defaults to the plugin setting (1.0 s) and is clamped to 0–30 s. The wait happens
**before** the new screenshot, so apps that repaint late are still captured.

`ui_type` with `index` clicks that element first to focus it. Text prefers AT-SPI
`EditableText.SetTextContents` (reliable for CJK); when the node has no `EditableText` it falls
back to XTEST typing and reads the text back to verify. `keys` (`ctrl+a`, `Return`, …) always uses
XTEST.

## How the numbering pipeline works

1. Capture the display size with `xdpyinfo`.
2. Walk every AT-SPI application on the session bus.
3. Keep interactive roles/actions (plus named drag surfaces), drop layout wrappers, exact
   duplicates, and regions that contain other candidates.
4. Sort by reading order: cluster elements into vertical bands by their centre, then
   left-to-right.
5. Crop the image to the union of the contributing windows (plus `padding`), so no black desktop
   surrounds the screenshot.
6. `ffmpeg -f x11grab` grabs the crop and draws thin outlines + yellow badges with
   `drawtext` (`/usr/share/fonts/TTF/Hack-Bold.ttf`). No PIL, no Qt overlay.
7. Write `<imageId>.png` and `<imageId>.json` (index → role/name/rect/centre/app pid/AT-SPI path,
   plus screen/crop metadata).

If every target reports the same `(x, y)` (GTK 4.24 on X11 does this — see below), the capture is
refused with `E_NO_GEOMETRY` and the raw cropped screenshot is still written as evidence. A
coordinate contract must not pretend those rectangles are clickable.

## Screenshots

| Qt 6 fixture | GTK 3 fixture |
|---|---|
| ![Qt6](screenshots/qt6-panel.png) | ![GTK3](screenshots/gtk3-panel.png) |

| GTK 4 (geometry unavailable) | WorkBuddy (Electron, real app) |
|---|---|
| ![GTK4](screenshots/gtk4-no-geometry.png) | ![WorkBuddy](screenshots/workbuddy-numbered.png) |

Each fixture shows its own counter line (`clicks=… dclicks=… drags=… wheel=… text='…'`); the
values match the state read back over AT-SPI after each numbered action. GTK 4 reports
`(0,0,w,h)` for every widget, so the plugin returns `E_NO_GEOMETRY` instead of drawing meaningless
badges — the capture above is the unnumbered evidence image.

## Install

### Requirements

| Dependency | Why |
|---|---|
| an X11 `DISPLAY` | the plugin operates on a display you provide; it does not start one |
| `at-spi2-core` | accessibility registry the numbering helper reads |
| `python3` + `python-gobject` (`gi.repository.Atspi`) | AT-SPI enumeration |
| `xdotool` | XTEST clicks, drags, wheel and keyboard |
| `ffmpeg` | `x11grab` capture + `drawtext` badges |

On Arch: `pacman -S at-spi2-core xdotool ffmpeg python-gobject`.
On Debian/Ubuntu: `apt install at-spi2-core xdotool ffmpeg python3-gi`.
Tests additionally need `xvfb` (`pacman -S xvfb` / `apt install xvfb`).

### From GitHub

```bash
dsh plugin --profile web add github:bot-for-imitoy/dsh-ui-automation
```

### From a local checkout

```bash
dsh plugin --profile web add /path/to/dsh-ui-automation
```

Then set `display` in the plugin settings (or leave it empty to use the Host's `DISPLAY`).

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `display` | empty → `$DISPLAY` → `:0` | target X display |
| `dbusAddress` | empty → Host env | optional session-bus address when AT-SPI lives on a private bus (tests/CI) |
| `screenshotDir` | empty → `screenshots/` | where PNG + sidecar JSON are written |
| `fontFile` | `/usr/share/fonts/TTF/Hack-Bold.ttf` | badge font |
| `maxDepth` | 24 | AT-SPI walk depth (Electron needs ≥24) |
| `maxTargets` | 60 | badge cap per image (1–200) |
| `padding` | 6 | crop margin in pixels |
| `crop` | true | crop to the participating windows (no black desktop) |
| `afterSeconds` | 1.0 | wait before the automatic re-screenshot (0–30) |
| `keepImages` | 15 | generated image pairs kept on disk (curated screenshots are untouched) |
| `attachImage` | true | also expose the PNG as an attachment/image block when the Host supports it (each capture adds a durable attachment; turn off if storage matters more than inline vision) |
| `enabledSessionIds` | empty | extra session ids allowed to use the tools |
| `allowedWorkspacePaths` | empty → plugin dir | workspaces allowed to use the tools |
| `allowAllSessions` | false | open the tools to every session |

## Visibility and safety

The plugin can drive **whatever display you configure** — including a real desktop. Tools are
therefore exposed only to allow-listed sessions/workspaces by default (the plugin's own workspace),
and every session that gets them receives a short workflow prompt. Keep the allow-list narrow
unless you really want every conversation to be able to click arbitrary windows.

Treat it as a powerful local input device, not a sandbox: it does not isolate processes, and a
misnumbered click is a real click.

## Image return

Every result carries `imagePath` and a text index list. When a `ctx.attachments` service exists and
`attachImage` is true, the PNG is also saved with `saveImage()` and returned as an `image` content
block; if the model route is text-only the Host replaces it with a placeholder handle. In that
case (the default DeepSeek route) the model should call `read_image` on `imagePath` when it needs
to look at the frame.

## Limitations

- **GTK 4.24 on X11** reports `(0,0,w,h)` for every widget; coordinate numbering is impossible, so
  the tool returns `E_NO_GEOMETRY` with the cropped evidence image.
- **Electron** must run with `--force-renderer-accessibility` (as the WorkBuddy capture does) or
  its tree contains almost nothing.
- Indices are only valid for the image they came from; a state change made outside the plugin
  requires a new `ui_screenshot`.
- Radio buttons and other tiny controls get a badge but small hit targets are still small; the
  click always uses the recorded centre.
- No OCR: elements missing from AT-SPI appear in the screenshot but are not numbered.
- No Wayland-native support; XWayland behaves like X11 only for what it exposes.
- Linux only.

## Testing

```bash
make -C test fixtures          # build the Qt6 / GTK3 / GTK4 panels
node test/integration.mjs      # 67 checks, starts its own Xvfb + private D-Bus + fixtures
node test/reliability.mjs      # 30 attempts per operation
node test/capture-screenshots.mjs
```

The tests own Xvfb, the private session bus and the fixture; the plugin only receives the display
(and bus address). Every assertion reads the fixture's own counter label over AT-SPI. See
[VERIFY.md](VERIFY.md) for the measured numbers.

## Project layout

```
index.js                 plugin entry, settings, session gating, prompt
lib/automation.js        latest-image state, capture orchestration, actions
lib/tools.js             the six tool definitions + human rendering
lib/x11.js               xdotool/XTEST wrapper
lib/shipped.js           resolve dsh-tools/schemastery from the DSH install
scripts/numbering.py     AT-SPI enumeration, numbering, crop, badges, sidecar JSON
test/                    fixtures + integration/reliability/capture scripts
screenshots/             curated numbered images referenced by the docs
```

## License

MIT. Only Linux is supported.
