Title: Add dsh-ui-automation — numbered-image UI control for Linux

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

## Why it is useful

- **One contract.** A click is always an XTEST click at the centre of a numbered rectangle; there is
  no semantic-tree API to reconcile with a coordinate fallback and no toolkit-specific action names.
- **Inspectable.** The exact frame that produced the indices is on disk; the model can `read_image`
  it, and a human reviewing the session can see what was numbered.
- **Works where accessibility is thin.** Numbering comes from AT-SPI, but the screenshot is the
  source of truth shown to the model.
- **Bounded by construction.** Cropped to the windows, capped target count, pruned old images.

## How it is verified

- `test/integration.mjs`: **67/67 checks** with the fixtures shipped in this repository (Qt 6,
  GTK 3, GTK 4) — screenshot/crop, stable numbering across captures, click, double-click, drag,
  wheel, ASCII/CJK typing with AT-SPI readback, key chords, out-of-range/no-image errors, tool
  entry points, attachment rendering, and the GTK 4 geometry guard. The test owns Xvfb, a private
  session bus and the fixtures; every assertion reads the fixture's own counter label over AT-SPI.
- `test/reliability.mjs`: **360 operations (12 groups × 30), 100% success**, measured end-to-end
  (action → wait → enumerate → crop → badges → PNG): screenshot 476–494 ms mean, actions
  675–926 ms mean, p95 ≤ 975 ms. Full table in `VERIFY.md`.
- GTK 4.24 on X11 reports `(0,0,w,h)` for every widget. The plugin refuses the capture with
  `E_NO_GEOMETRY` (and still writes the cropped evidence image) instead of drawing meaningless
  badges — reproduced by `test/fixtures/panel_gtk4.c`.
- WorkBuddy (a real Electron app) was numbered through the plugin itself: 35 targets, 1037×722.

Screenshots from the verification run:

- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/qt6-panel.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/gtk3-panel.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/gtk4-no-geometry.png
- https://github.com/bot-for-imitoy/dsh-ui-automation/blob/main/screenshots/workbuddy-numbered.png

## Limitations

- Linux/X11 only; no Wayland-native path.
- GTK 4.24 cannot be numbered (zero extents), reported as `E_NO_GEOMETRY`.
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
