# 验证记录（真机）：标号图片 + 索引操作

> 验证时间：2026-11-25
> 环境：Arch Linux / Xvfb 21.1.26 / at-spi2-core 2.62.1 / Qt 6.12.0 / GTK 3.24.52 / GTK 4.24.1 / xdotool 4.0 / ffmpeg / python-gobject / Node v26.13.1
> 所有数字都来自本机实际运行；原始输出在 `test/out/`，可重跑。

## 被测对象

| 目标 | 工具包 | 用途 |
|---|---|---|
| `test/fixtures/panel_qt` | Qt 6 | 按钮/复选框/输入框 + 双击、拖拽、滚轮计数器 |
| `test/fixtures/panel_gtk3` | GTK 3 | 同一套控件的 GTK3 版本 |
| `test/fixtures/panel_gtk4` | GTK 4 | 复现 GTK4 的零 extents（`E_NO_GEOMETRY`） |
| `/opt/WorkBuddy/workbuddy` | Electron | 真实应用：插件在真实界面上编号 35 个目标 |

测试拥有环境，插件只拿 display：每个测试用例自己起 `Xvfb`、私有 `dbus-daemon` 和 fixture，
再把 `display`（以及私有总线地址）配给插件。工具层没有启动应用、没有沙盒管理。

**断言方式**：每次编号操作后，测试都通过 AT-SPI 读 fixture 自己的
`clicks=… dclicks=… drags=… wheel=… text='…'` 状态标签；PASS 表示应用状态真的变了，而不是
XTEST 调用返回 0。

## 1. 编号契约矩阵：67/67 通过

`node test/integration.mjs`（Qt 6 + GTK 3 fixture，覆盖截图/裁剪/编号稳定性、按编号点击、
双击、拖拽、滚轮、ASCII/中英文输入、按键组合、越界索引、无图操作、工具入口、图片 attachment、
GTK4 守卫）：

```
== Qt6 fixture ==
  [PASS] ui_screenshot succeeds (467 ms) — shot-20261125-...
  [PASS] cropped to the window (no black desktop) — image 542×472 vs screen 1024×768
  [PASS] numbered 6+ targets — 6: input, button, check, dragarea, dblarea, wheelarea
  [PASS] sidecar records identity per index — 6 entries, e.g. #1 pid=… path=0/0
  [PASS] same screen → same indices — 6 targets, identical indices and rects
  [PASS] click by index → counter +1 — #2 clicks 0 → 1
  [PASS] double click by index → dclicks +1 — #5 dclicks 0 → 1
  [PASS] drag fromIndex → toIndex → drags +1 and distance > 0 — #4→#6 dist=176
  [PASS] scroll by index → wheel ticks +2, −240 — wheelTicks 0 → 2
  [PASS] type ASCII/CJK through the input index — readback="hello numbered" / "你好，标号图片"
  [PASS] key chord through the input index — #1 xtest-key
  [PASS] index out of range → E_INDEX
  [PASS] click before any screenshot → E_NO_IMAGE
  [PASS] attachment is created and rendered as an image block — blocks: image, text

== GTK4 geometry limit（可复现） ==
  [PASS] GTK4 screenshot is refused with E_NO_GEOMETRY
  [PASS] evidence image is still written（裁剪后的未编号图）
  [PASS] no stale indices are kept

numbered-image integration matrix: 67/67 passed
```

GTK3 fixture 结果相同（裁剪 588×472、6 个目标、所有操作通过）。

## 2. 可靠性：12 组 × 30 次 = 360 次操作，100%

`node test/reliability.mjs`。每次动作的耗时包含：XTEST 动作 → 等 `afterSeconds`（测试用 0.2s）
→ AT-SPI 枚举/去重/排序 → 裁剪 → 画徽章 → PNG + sidecar。

| fixture | 操作 | 成功 | 成功率 | mean | p50 | p95 | max |
|---|---|---|---|---|---|---|---|
| Qt 6 | screenshot | 30/30 | 100% | 494ms | 486ms | 552ms | 570ms |
| Qt 6 | click | 30/30 | 100% | 825ms | 810ms | 930ms | 959ms |
| Qt 6 | double_click | 30/30 | 100% | 820ms | 812ms | 863ms | 865ms |
| Qt 6 | drag | 30/30 | 100% | 873ms | 866ms | 927ms | 943ms |
| Qt 6 | scroll | 30/30 | 100% | 711ms | 700ms | 744ms | 864ms |
| Qt 6 | type | 30/30 | 100% | 926ms | 930ms | 975ms | 1017ms |
| GTK 3 | screenshot | 30/30 | 100% | 476ms | 471ms | 516ms | 534ms |
| GTK 3 | click | 30/30 | 100% | 779ms | 772ms | 818ms | 818ms |
| GTK 3 | double_click | 30/30 | 100% | 800ms | 795ms | 846ms | 867ms |
| GTK 3 | drag | 30/30 | 100% | 852ms | 845ms | 887ms | 895ms |
| GTK 3 | scroll | 30/30 | 100% | 675ms | 673ms | 728ms | 743ms |
| GTK 3 | type | 30/30 | 100% | 866ms | 860ms | 913ms | 913ms |

总墙钟 374.4s。`type` 的中文/ASCII 交替输入全部经 AT-SPI `SetTextContents` 并逐次回读。

## 3. 编号稳定性与裁剪

- 同一画面连续两次截图：6 个目标的 **name → index 完全一致，rect 完全一致**，`imageId` 不同。
- 编号只在对应图片内有效：每次动作返回新图，`previousImageId` 指向旧图；越界索引返回
  `E_INDEX`（带 `available`）。
- 裁剪：Qt fixture 窗口 542×472（根窗口 1024×768），GTK3 588×472；精选截图里 Qt 651×472
  （脚本输入中文后窗口略变宽）、GTK3 710×472。全部无黑边。

## 4. GTK4：可复现的 `E_NO_GEOMETRY`

GTK 4.24（X11）对所有控件报 `(0,0,w,h)`（`distinctPositions=1`）。插件的坐标契约不能假装这些
矩形可点，因此：

```
E_NO_GEOMETRY: AT-SPI reports identical (x,y) rectangles for every target;
this toolkit (typically GTK4) cannot be numbered for a coordinate contract.
```

同时仍写出裁剪后的证据图（未画徽章），并且作废 latest 索引，避免误点。
证据图：`screenshots/gtk4-no-geometry.png`（472×432）。

## 5. 图片返回（attachment）结论

- 插件在每次成功后把 PNG 写成 `imagePath` + 文本索引清单；当设置 `attachImage=true` 且 Host
  提供 `ctx.attachments` 时，还会 `saveImage()` 并把 `image` content block 放在文本块之前。
- 测试用一个假的 attachment store 验证了这条路径：渲染块为 `image, text`（67/67 中包含该项）。
- DSH 的 DeepSeek 适配器明确支持 **user 消息与 tool result 中的图片**；本环境默认
  `deepseek-flash` 声明了 image 输入模态，所以图片块可以进入模型请求。纯文本路由会由 Host
  替换成占位说明；此时模型应 `read_image(imagePath)`。
- 本次没有在已安装的 profile 里做端到端"模型看到图"的实验（profile 里装的是上一版安装名），
  但 attachment 创建与图片块生成已在测试中验证。

## 6. WorkBuddy（真实 Electron 应用）

用插件自己的 `ui_screenshot` 在 1440×900 的 Xvfb 上截取：

- `screenshots/workbuddy-numbered.png`，1037×722，35 个编号目标；
- 启动参数需要 `--force-renderer-accessibility`（否则树里几乎为空），截图前等待界面稳定；
- 该图是插件真实输出，不是外部原型。

## 7. 已知边界

| 边界 | 现象 |
|---|---|
| GTK 4.24 | 所有控件 extents 为 (0,0,w,h)，返回 `E_NO_GEOMETRY` |
| Electron | 必须 `--force-renderer-accessibility` |
| 索引寿命 | 只在最近一张标号图内有效；外部状态变化后需 `ui_screenshot` |
| 无 OCR | AT-SPI 看不到的元素出现在图里但不编号 |
| Wayland | 不支持原生 Wayland；只测 X11/Xvfb |
| 真实桌面 | `display` 可以指向用户桌面，因此默认只对白名单会话/工作区开放 |
| 小目标 | 徽章按元素左上角避让放置；极小的目标仍可能被徽章遮住部分内容 |

## 8. 复现

```bash
cd /home/bot-for-imitoy/workspace/dsh-ui-automation-plugin
make -C test fixtures          # 编译 Qt6 / GTK3 / GTK4 面板（需要对应 -dev 包）
node test/integration.mjs      # 67 项，约 90s
node test/reliability.mjs      # 360 次操作，约 375s
node test/capture-screenshots.mjs   # 重新生成 screenshots/
```

原始输出：`test/out/integration.log`、`test/out/integration.json`、`test/out/reliability.log`、
`test/out/reliability.json`、`test/out/capture.log`。
