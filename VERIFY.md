# 验证记录（真机）：标号图片 + 索引操作 + GTK4 原点回退

> 验证时间：2026-11-25（v2.2.0；跨插件抑制新增 `test/visibility.mjs` 20/20，集成矩阵仍 80/80，
> 可靠性 15 组 × 30 次仍 100%；v2.2.0 只新增 `uiAutomationVisibility` 服务与 `when` 里的一次判定，
> 没有改动编号/GTK4 路径）
> 环境：Arch Linux / Xvfb 21.1.26 / at-spi2-core 2.62.2 / Qt 6.12.0 / GTK 3.24.52 / GTK 4.24.1 / xdotool 4.0 / x11-utils（xwininfo、xprop）/ ffmpeg / python-gobject / Node v26.13.1
> GTK4 根因与方案调查报告：[docs/GTK4-GEOMETRY.md](docs/GTK4-GEOMETRY.md)；实验脚本：[test/gtk4-probe/](test/gtk4-probe/)
> 所有数字均来自本机实际运行；原始输出在 `test/out/`，可重跑。

## 被测对象

| 目标 | 工具包 | 用途 |
|---|---|---|
| `test/fixtures/panel_qt` | Qt 6 | 按钮/复选框/输入框 + 双击、拖拽、滚轮计数器 |
| `test/fixtures/panel_gtk3` | GTK 3 | 同一套控件的 GTK3 版本 |
| `test/fixtures/panel_gtk4` | GTK 4 | 零 extents 的 X11 原点回退（6 个目标）；关闭回退时复现 `E_NO_GEOMETRY` |
| `/opt/WorkBuddy/workbuddy` | Electron | 真实应用截图，插件自身输出 |

测试拥有环境，插件只拿 display：每个用例自己起 `Xvfb`、私有 `dbus-daemon` 和 fixture，再把
`display`（与私有总线地址）配给插件。工具层没有启动应用、没有沙盒管理。

**断言方式**：每次编号操作后，测试通过 AT-SPI 读 fixture 自己的
`clicks=… dclicks=… drags=… wheel=… text='…'` 状态标签；PASS 表示应用状态真的变了。

## 1. 编号契约矩阵：80/80 通过

`node test/integration.mjs`（Qt 6 + GTK 3 原矩阵、GTK4 回退、混合桌面、回退关闭、工具入口）：

```
== GTK4 X11-origin fallback ==
  [PASS] GTK4 is numbered instead of refused — 6 targets; fallback={"detected":1,"fixed":1,...}
  [PASS] every GTK4 target carries rectSource=x11-origin+window
  [PASS] GTK4 click by index increments the fixture counter — #2 clicks 0 → 1
  [PASS] moving the window shifts every rect by exactly (+200,+150) — 6 targets; crop=(200,150,460,560)
  [PASS] click after the move still lands on the button — clicks 1 → 2
  [PASS] pixel-level error of the derived geometry is 0–2 px — bbox=(208,272,444,80), maxΔ=0px
  [PASS] gtk4OriginFallback=false refuses the GTK4 app — E_NO_GEOMETRY（E_GTK4_FALLBACK_DISABLED）
  [PASS] refused GTK4 leaves no usable indices

== Mixed desktop: Qt6 + GTK3 + GTK4 ==
  [PASS] all three toolkits are numbered together — 18 targets
  [PASS] each toolkit has a clickable button target — qt:#3@(285,75) gtk3:#4@(808,83) gtk4:#14@(250,385)
  [PASS] targets are not all collapsed onto the top-left corner
  [PASS] click lands on panel_qt only — clicks 0 → 1；gtk3/gtk4 不变
  [PASS] click lands on panel_gtk3 only — clicks 0 → 1；qt/gtk4 不变
  [PASS] click lands on panel_gtk4 only — clicks 0 → 1；qt/gtk3 不变
  [PASS] fallback disabled drops only the GTK4 app — 12 targets 保留，warning=E_GTK4_FALLBACK_DISABLED
  [PASS] other toolkits stay clickable with the fallback disabled — Qt clicks 1 → 2

numbered-image integration matrix: 80/80 passed
```

Qt6 / GTK3 的原有 67 项（截图裁剪、编号稳定、点击/双击/拖拽/滚轮、ASCII/CJK、按键组合、
越界索引、无图操作、attachment、工具入口）全部保持通过；新增 13 项是 GTK4 回退与混合桌面。

## 2. 可靠性：15 组 × 30 次 = 450 次操作，100%

`node test/reliability.mjs`。每次动作的耗时包含：XTEST 动作 → 等 `afterSeconds`（测试 0.2s）
→ AT-SPI 枚举/去重/排序 →（GTK4 时）X11 原点回退 → 裁剪 → 画徽章 → PNG + sidecar。

| fixture | 操作 | 成功 | mean | p50 | p95 | max |
|---|---|---|---|---|---|---|
| Qt 6 | screenshot | 30/30 | 539ms | 532ms | 575ms | 591ms |
| Qt 6 | click | 30/30 | 850ms | 844ms | 919ms | 941ms |
| Qt 6 | double_click | 30/30 | 880ms | 876ms | 950ms | 958ms |
| Qt 6 | drag | 30/30 | 883ms | 880ms | 917ms | 956ms |
| Qt 6 | scroll | 30/30 | 729ms | 726ms | 774ms | 791ms |
| Qt 6 | type | 30/30 | 934ms | 929ms | 975ms | 1040ms |
| GTK 3 | screenshot | 30/30 | 493ms | 488ms | 543ms | 550ms |
| GTK 3 | click | 30/30 | 791ms | 783ms | 831ms | 831ms |
| GTK 3 | double_click | 30/30 | 824ms | 811ms | 883ms | 889ms |
| GTK 3 | drag | 30/30 | 856ms | 851ms | 887ms | 907ms |
| GTK 3 | scroll | 30/30 | 706ms | 701ms | 760ms | 766ms |
| GTK 3 | type | 30/30 | 883ms | 878ms | 924ms | 940ms |
| GTK 4（回退） | screenshot | 30/30 | 562ms | 548ms | 659ms | 661ms |
| GTK 4（回退） | click | 30/30 | 851ms | 844ms | 902ms | 902ms |
| GTK 4（回退） | type | 30/30 | 968ms | 965ms | 1028ms | 1062ms |

总墙钟 477.6s；所有组 100%。GTK4 的 `screenshot` 比 Qt/GTK3 多约 23–69ms（多一次
`xdotool search` + `xwininfo`/`xprop`）。

## 3. GTK4 回退：实现与安全性

- **按应用检测**（不是全局）：某应用的候选目标 `SCREEN` 原点只有同一个值、`WINDOW` 原点却不止
  一个时，才判定它的 SCREEN 坐标损坏。GTK3/Qt 的 SCREEN 原点正常，永远不进入回退分支。
- **回退**：`screen = X11 顶层内容原点 + GetExtents(WINDOW)`；用 `xdotool search --pid` 找窗口，
  `xwininfo` 按客户区尺寸匹配（有 `_GTK_FRAME_EXTENTS` 时按 extents 调整尺寸并取内容原点），
  每个 frame/dialog 独立算 delta。结果标记 `rectSource='x11-origin+window'`。
- **失败不静默**：匹配不到窗口时该应用的目标全部剔除，返回 `E_NO_X11_UTILS` /
  `E_NO_X11_WINDOW` / `E_NO_X11_ORIGIN`，`geometryTrusted=false`；只剩 GTK4 时整张图
  `E_NO_GEOMETRY`。混合桌面上其它应用继续可用，GTK4 不会被编号到 `(0,0)`。
- **全局兜底**：逐应用处理完之后，如果剩余目标仍全部共享同一原点（≥3 个），整张图仍拒绝。
- **移动窗口**：窗口从 `+0+0` 移到 `+200+150` 后，6 个目标的矩形全部精确平移 `(+200,+150)`，
  crop 也变成 `(200,150,460,560)`；点击仍然命中（计数 +1）。没有缓存陈旧偏移。
- **像素级误差**：GTK4 fixture 的灰色区域在屏幕上的真实 bbox 为 `(208,272,444,80)`，回退推导值
  完全相同（maxΔ=0px）。

## 4. 混合桌面（Qt6 + GTK3 + GTK4 同 display）

1440×900 的 Xvfb 上同时跑三个 fixture，窗口分别放到 `(20,20)`、`(520,20)`、`(20,320)`：

- 一张图 18 个目标，三个应用都在；
- 三个按钮中心分别是 `(285,75)`、`(808,83)`、`(250,385)`，互不相同、都不在左上角；
- 依次点三个按钮，只有对应 fixture 的 `clicks` +1（另外两个不变）。
- 同一张混合桌面把回退关掉：12 个目标保留（Qt+GTK3），GTK4 目标全部剔除，
  `E_GTK4_FALLBACK_DISABLED` warning，`geometryTrusted=false`；Qt 仍可点击。

## 5. 误差范围（实测/引用）

| 目标 | 误差 | 说明 |
|---|---|---|
| GTK4 fixture | **0 px** | 本仓库集成测试按像素 bbox 断言（maxΔ=0） |
| 真实 libadwaita（nautilus） | **5–11 px** | 见调查报告 §6.4；点击仍命中（侧栏"回收站"导航成功） |
| GTK4 popover（独立 surface） | **~8 px** | 调查报告 §4.2/§6.4；`item2` 点击成功 |
| GTK3 / Qt | 0 px | 本来就用正确的 SCREEN 坐标，不走回退 |

`_GTK_FRAME_EXTENTS`：匹配窗口与计算内容原点时会读取并使用；本机 GTK4/GNOME 应用在 Xvfb 下
没有设置该属性，因此这一分支没有真实应用样本可测，只做了代码路径处理。libadwaita 的 5–11px
残差原因仍未完全查清（报告 §4.1），但小于控件尺寸，不影响命中。

## 6. 截图与图片返回

- `screenshots/gtk4-numbered.png`（460×560，6 个编号）：GTK4 fixture 经回退后的真实标号图；
- `screenshots/gtk4-no-geometry.png`（460×560）：关闭回退时的未编号证据图；
- `screenshots/qt6-panel.png`（639×460）、`screenshots/gtk3-panel.png`（698×460）：各自 6 个编号；
- `screenshots/workbuddy-numbered.png`（1025×710，40 个编号）：真实 Electron 应用，插件自身输出。

图片返回路径未变：`attachImage=true` 且 Host 有 `ctx.attachments` 时保存 attachment 并输出
`image` content block；纯文本路由退回 `imagePath` + 索引清单，模型用 `read_image` 读取。

## 7. 已知边界

| 边界 | 现象 |
|---|---|
| GTK 4.24 | SCREEN 坐标恒 `(0,0)`；默认用 X11 原点回退。关闭回退或匹配不到窗口时整应用被剔除 |
| libadwaita / popover | 回退后仍有 5–11px（popover ~8px）残差；仍可命中 |
| x11-utils 缺失 | GTK4 应用返回 `E_NO_X11_UTILS` 并被剔除，不会静默错编号 |
| Wayland 原生 | 不支持；回退依赖 X11 窗口 |
| Electron | 必须 `--force-renderer-accessibility` |
| 索引寿命 | 只在最近一张标号图内有效 |
| 真实桌面 | `display` 可指向用户桌面，因此默认只对白名单会话/工作区开放 |

## 8. 复现

```bash
cd /home/bot-for-imitoy/workspace/dsh-ui-automation-plugin
make -C test fixtures            # 编译 Qt6 / GTK3 / GTK4 面板（需要对应 -dev 包）
node test/integration.mjs        # 80 项，约 130s
node test/reliability.mjs        # 450 次操作，约 470s
node test/capture-screenshots.mjs
```

GTK4 研究复现：`test/gtk4-probe/env.sh 151`（Xvfb + 私有 session/a11y 总线）、
`test/gtk4-probe/dump.py`、`test/gtk4-probe/verify_fix.py`，详见 [docs/GTK4-GEOMETRY.md](docs/GTK4-GEOMETRY.md)。

原始输出：`test/out/integration.log`、`test/out/integration.json`、`test/out/reliability.log`、
`test/out/reliability.json`、`test/out/capture.log`。
