# GTK4 控件几何（AT-SPI extents）问题调查报告

> 版本：2026-11-25 · 对象：`dsh-ui-automation` v2.0.0（标号图片 + 索引契约）
> 关联：`scripts/numbering.py`、`test/fixtures/panel_gtk4`
> 实验脚本：`test/gtk4-probe/`（可复现，见文末附录）
> 待评审的最小补丁：`docs/gtk4-origin-fallback.patch`（**未应用**）

## 结论摘要

1. **不是环境特例，也不是插件调用方式的问题。** GTK4 的 AT-SPI 桥在
   `gtk_at_spi_translate_coordinates_{to,from}_accessible()` 里把
   `ATSPI_COORD_TYPE_SCREEN` 硬编码成 `(0,0)` 直接返回（`gtk-4.24.1`
   `gtk/a11y/gtkatspiutils.c:383` 与 `:437`）。于是 `Component.GetExtents(SCREEN)`
   对**任何** GTK4 控件都返回 `(0,0,w,h)`：x、y 恒为 0，**宽高是对的**。
   与 X11/Wayland、有无窗口管理器、Xvfb/Xorg/Xwayland 都无关。
2. `GetExtents(WINDOW)` 和 `GetExtents(PARENT)` **是正确的**，`GetSize()` 也正确。
   所以信息没丢，只是"屏幕原点"这一层没实现。
3. 同一环境下 GTK3（atk-bridge）与 Qt6 的 `SCREEN` extents 完全正确，且窗口移动
   后会跟随（见 §2 对比表）。因此这是 **GTK4 单方面的缺陷**。
4. 上行：GNOME GitLab 早在 GTK 4.10 起就有 issue（[#6343](https://gitlab.gnome.org/GNOME/gtk/-/work_items/6343)）；
   `main` 分支到本文写作时**仍然是** `*xo = 0; *yo = 0; return;`。第三方项目
   （trycua/cua、can1357/oh-my-pi）也各自实现了同一套 workaround：*WINDOW 坐标 + X11 顶层窗口原点*。
5. **如果只能选一条路**：用 `GetExtents(WINDOW)` + X11 顶层窗口（GTK4 一个 surface 就是一个
   X window）原点做偏移，即 `docs/gtk4-origin-fallback.patch`。对 fixture 是**逐像素精确**的
   （§6.3 像素验证），对真实 libadwaita 应用（nautilus）误差 5–11 px，仍然"点得中"（§6.4 实测点击成功）。
   改动量约 80 行 Python、一个文件，不涉及 Node 侧。

---

## 0. 环境

| 组件 | 版本 |
|---|---|
| 发行版 | Arch Linux rolling |
| GTK | 4.24.1（`/usr/lib/libgtk-4.so.1.2400.1`），GTK3 3.24.52 |
| at-spi2-core | 2.62.2（`pacman -Q`；任务描述里记的是 2.62.1）；`at-spi2-registryd`、`at-spi-bus-launcher` 在 `/usr/lib/` |
| 真实桌面 | KDE Plasma **Wayland**（kwin_wayland），Xwayland `:0`（`XAUTHORITY=/run/user/1000/xauth_inYFcf`） |
| 探针显示 | Xvfb 21.1.26：`:151`（无 WM）、`:152`（openbox 3.6）、`:153`（干净复现用） |
| Python | 3.14.10 + python-gobject 3.58.1（**无 pyatspi**，`gi.repository.Atspi` 可用） |
| 其它 | xdotool / xwininfo / gdbus / busctl / ffmpeg / tesseract（仅 `afr`、`osd` 语言包） |

真实桌面 `:0` 的 a11y 是**关闭**的（`org.a11y.Status.IsEnabled = false`），且其 a11y bus 是
`/run/user/1000/at-spi/bus_0`。为了既不改桌面设置、又不和真实 `at-spi2-registryd` 抢总线，
所有探针都用**私有 session bus + 私有 a11y bus**（`AT_SPI_BUS_ADDRESS`，GTK4 与 libatspi 都认）。
注意：默认走 `org.a11y.Bus` 时 a11y bus 是 `~/.cache/at-spi/bus` 这种**用户级单例**，
多个测试环境会互相踩，这也是仓库现有 `test/lib/env.mjs` 与真实桌面共享一条 a11y 总线的原因。

---

## 1. 复现

### 1.1 起环境

```bash
./test/gtk4-probe/env.sh 151                 # Xvfb :151 + 私有 session bus + 私有 a11y bus + registryd
. ./test/gtk4-probe/use.sh 151
./test/fixtures/panel_gtk4 &                 # GTK 4.24.1 fixture
python3 test/gtk4-probe/dump.py --depth 4    # 原始 D-Bus 遍历，不用 libatspi
```

### 1.2 GTK4 fixture 的原始输出（窗口未移动，位于 +0+0）

```
== :1.1  (11 nodes)
root  name='panel_gtk4'                     ifaces: Application, Accessible
  3d40ec7b_…  name='GTK4 Panel'             ifaces: Component, Accessible, Action
     GetExtents: SCREEN=(0,0,460,420) WINDOW=(0,0,460,420) PARENT=(0,0,460,420)
     GetSize: w=460 h=420
    c04e14e7_…  name=''                     ifaces: Component, Accessible, Action
       GetExtents: SCREEN=(0,0,444,412) WINDOW=(8,8,444,412) PARENT=(8,8,444,412)
      5b53c253_…  name='input'              ifaces: Text, EditableText, Component, Accessible, Action
         GetExtents: SCREEN=(0,0,444,34) WINDOW=(8,8,444,34) PARENT=(0,0,444,34)
      6aeab135_…  name='点击 Click'          ifaces: Component, Accessible, Action
         GetExtents: SCREEN=(0,0,444,34) WINDOW=(8,48,444,34) PARENT=(0,40,444,34)
      7534a260_…  name='check'              ifaces: Component, Accessible, Action
         GetExtents: SCREEN=(0,0,444,28) WINDOW=(8,88,444,28) PARENT=(0,80,444,28)
```

**关键点**：不是"全是 0"，而是 **x,y 恒为 0、w,h 正确**。所以插件看到的
`distinctPositions == 1` 是因为所有 x,y 都等于 `(0,0)`，而宽高各不相同。

### 1.3 绕开 pyatspi，直接用 gdbus 打 D-Bus

```console
$ gdbus introspect --address "$AT_SPI_BUS_ADDRESS" --dest :1.1 \
    --object-path /org/gtk/application/panel_gtk4/a11y/5b53c253_… | sed -n '/Component/,/};/p'
  interface org.a11y.atspi.Component {
    methods:
      …
      GetExtents(in  u coord_type, out (iiii) unnamed_arg1);
…
$ gdbus call --address "$AT_SPI_BUS_ADDRESS" --dest :1.1 \
    --object-path /org/gtk/application/panel_gtk4/a11y/5b53c253_… \
    --method org.a11y.atspi.Component.GetExtents 0
((0, 0, 444, 34))          # SCREEN
$ gdbus call … --method org.a11y.atspi.Component.GetExtents 1
((8, 8, 444, 34))          # WINDOW
```

结论：与 pyatspi/gi 完全一致 → **不是插件调用层级或 CoordType 转换写错**，
是应用端就返回了这个值。（顺带：`gtk_at_spi_translate_coordinates_to_accessible()`
`Contains()` 也一起坏了：无论坐标是多少，`SCREEN` 恒返回 `TRUE`、`WINDOW` 恒返回
`FALSE`，即 `gtkatspicomponent.c:107` 把 `width/height` 写成了 `bounds_x/bounds_y`。）

### 1.4 插件侧表现

```console
$ python3 scripts/numbering.py shot --display :153 --out-dir /tmp/o | tail -1
{"ok": false, "code": "E_NO_GEOMETRY",
 "error": "AT-SPI reports identical (x,y) rectangles for every target; …",
 "geometryTrusted": false,
 "stats": {"totalNodes": 11, "targets": 3, "distinctPositions": 1, "apps": 1}}
targets: [('input',[0,0,444,34]), ('点击 Click',[0,0,444,34]), ('check',[0,0,444,28])]
```

⚠️ **顺带发现一个比 `E_NO_GEOMETRY` 更危险的情况**：该守卫是**全局**的
（`len(targets) >= 3 and len(positions) <= 1`），只在"整个桌面只有 GTK4 一个贡献者"时触发。
在 `:151` 上同时跑 GTK4 fixture + GTK3 fixture + Qt fixture + nautilus 时，原始
`numbering.py` 返回 **`ok=true`**，其中 GTK4 的三个目标排在 `#1–#3` 且矩形是 `(0,0,w,h)`：

```
ok= True  distinctPositions= 13
 #1 text      input        [0, 0, 444, 34]     ← GTK4，点击会打到屏幕左上角
 #2 button    点击 Click     [0, 0, 444, 34]
 #3 check box check        [0, 0, 444, 28]
 …
 #18 text     input        [191, 101, 508, 25] ← Qt，正常
```

也就是说：**混合桌面上 GTK4 目标会被静默编号到错误坐标**，而不会报错。
（本次没有改插件行为，只记录。）

---

## 2. 对比矩阵

每组都先 `xdotool windowmove` 把窗口挪到已知位置，再读 extents。判定标准：
窗口移到 `(X,Y)` 后，控件的 `SCREEN` 是否等于 `(X,Y) + WINDOW`。

| 被测对象 | 后端 / 显示 | 窗口位置 | `GetExtents(SCREEN)` | `GetExtents(WINDOW)` | 判定 |
|---|---|---|---|---|---|
| `panel_gtk4` (GTK 4.24.1) | Xvfb `:151`，无 WM | +0+0 | `(0,0,444,34)` | `(8,8,444,34)` | ❌ x,y 恒 0 |
| `panel_gtk4` | Xvfb `:151`，无 WM | **+300+200** | `(0,0,444,34)` | `(8,8,444,34)` | ❌ 不跟随 |
| `panel_gtk4` | Xvfb `:152` + **openbox** | **+282+183** | `(0,0,444,34)` | `(8,8,444,34)` | ❌ 不跟随 |
| `panel_gtk4` | **Xwayland `:0`** + kwin | **+281+163** | `(0,0,444,34)` | `(8,8,444,34)` | ❌ 不跟随 |
| `nautilus`（真实 GTK4 应用） | Xvfb `:151`，无 WM | +0+0 | `(0,0,890,550)` | `(-5,-5,890,550)` | ❌ x,y 恒 0 |
| `panel_gtk3` (GTK 3.24.52) | Xvfb `:151`，无 WM | **+250+120** | `(258,128,560,444)` | `(8,8,560,444)` | ✅ 正确 |
| `panel_qt` (Qt 6) | Xvfb `:151`，无 WM | **+180+90** | `(191,101,508,25)` | `(11,11,508,25)` | ✅ 正确 |

原始片段（GTK3 / Qt 作为对照，同一 a11y bus、同一脚本）：

```console
# GTK3，窗口移到 +250+120 之后
 1  role=frame name='GTK3 Panel'
    GetExtents: SCREEN=(250,120,576,460) WINDOW=(0,0,576,460)
     …      name='input'
    GetExtents: SCREEN=(258,128,560,32)  WINDOW=(8,8,560,32)

# Qt6，窗口移到 +180+90 之后
 2147483649 role=20 name='Qt Panel'
    GetExtents: SCREEN=(180,90,530,460) WINDOW=(0,0,530,460)
 2147483650 role=61 name='input'
    GetExtents: SCREEN=(191,101,508,25) WINDOW=(11,11,508,25)
```

> 关于 `PARENT`：GTK4 的 `PARENT` 正确（父容器相对坐标），GTK3/Qt 的 `PARENT`
> 恰好等于 `SCREEN`（它们直接在屏幕坐标系里算）。所以 `PARENT` 只能用于 GTK4 场景下
> 自下而上累加，信息量与 `WINDOW` 等价，没有额外价值。

**回答"是不是所有 GTK4 都这样"**：是。凡是使用 GTK 自带 AT-SPI 后端的 GTK4 应用
（即全部 GTK4 应用；本机 `libgtk-4.so` 里 accesskit 后端是 "Disabled during GTK build"），
在任何后端/窗口管理器下都是这个行为，因为那是库里的硬编码。**没有环境变量能打开它**
（`GTK_A11Y` 只有 `atspi` / `test` / `none`），也没有"某个 GTK4 应用碰巧正常"的可能——
除非它自带别的 a11y 实现（见 §4 存疑）。

---

## 3. 根因（确定项）

### 3.1 硬编码的 `(0,0)`

`gtk-4.24.1/gtk/a11y/gtkatspiutils.c:373-388`（`to_accessible`，即"把屏幕坐标换算成
控件坐标系"，`Contains`/`GetAccessibleAtPoint` 用）与 `:427-442`（`from_accessible`，
即"把控件坐标换算成屏幕/窗口坐标"，`GetExtents`/`GetPosition`/`Text.GetCharacterExtents` 用）
各有一处完全相同的短路：

```c
void
gtk_at_spi_translate_coordinates_from_accessible (GtkAccessible *accessible,
                                                  AtspiCoordType coordtype,
                                                  int xi, int yi, int *xo, int *yo)
{
  if (coordtype == ATSPI_COORD_TYPE_SCREEN)
    {
      *xo = 0;          /* ← 从来不换算到屏幕，直接 0,0 */
      *yo = 0;
      return;
    }
  …
```

整个 `gtk/a11y/` 目录里 `ATSPI_COORD_TYPE_SCREEN` 只出现在这两个函数（以及
`gtkatspiprivate.h` 的枚举声明），即**GTK4 全库没有一处真正实现屏幕坐标**：

```console
$ grep -rn ATSPI_COORD_TYPE_SCREEN gtk-4.24.1/gtk/a11y/
gtk/a11y/gtkatspiutils.c:383:  if (coordtype == ATSPI_COORD_TYPE_SCREEN)
gtk/a11y/gtkatspiutils.c:437:  if (coordtype == ATSPI_COORD_TYPE_SCREEN)
gtk/a11y/gtkatspiprivate.h:256:  ATSPI_COORD_TYPE_SCREEN,
```

### 3.2 `GetExtents` 恰好把 `(0,0)` 写进 x,y

`gtk-4.24.1/gtk/a11y/gtkatspicomponent.c:140-152`：

```c
  else if (g_strcmp0 (method_name, "GetExtents") == 0)
    {
      AtspiCoordType coordtype;
      int x, y, width, height;

      gtk_accessible_get_bounds (accessible, &x, &y, &width, &height);

      g_variant_get (parameters, "(u)", &coordtype);

      gtk_at_spi_translate_coordinates_from_accessible (accessible, coordtype, 0, 0, &x, &y);

      g_dbus_method_invocation_return_value (invocation, g_variant_new ("((iiii))", x, y, width, height));
    }
```

注意它先用 `gtk_accessible_get_bounds()` 拿到了 `x,y,width,height`，随后**用
`translate(0,0)` 的返回值覆盖了 `x,y`**（`width/height` 保留）。所以：

* `WINDOW`/`PARENT`：`translate(0,0)` 往上是"控件自身原点 → 父级 → … → frame"的累加，
  得到的正是控件的窗口相对原点，**结果正确**（这是"歪打正着"，不是设计）。
* `SCREEN`：`translate()` 直接给 `(0,0)`，于是 extents 变成 `(0,0,w,h)`。

这解释了两个反常现象：
1. 为什么宽高始终正确 —— 宽高来自 `gtk_accessible_get_bounds()`，没被覆盖；
2. 为什么 x,y **既不等于 WINDOW 值、也不等于"WINDOW + 窗口原点"** —— 因为它压根不是从
   WINDOW 推导出来的，而是被替换成了字面量 0。

### 3.3 其它接口同样拿不到屏幕坐标

| 接口 | GTK4 行为（实测 + 源码） | 能否提供屏幕几何 |
|---|---|---|
| `org.a11y.atspi.Component.GetExtents(SCREEN)` | `(0,0,w,h)` | ❌ |
| `Component.GetPosition(SCREEN)` | `(0,0)` | ❌ |
| `Component.GetSize()` | `w,h` 正确 | 只有尺寸 |
| `Component.Contains(…)` | SCREEN 恒 `TRUE` | ❌ 且错误 |
| `Component.GetAccessibleAtPoint(…)` | SCREEN 返回固定节点，WINDOW 返回 null | ❌ 不可用 |
| `Text.GetCharacterExtents / GetRangeExtents` | **显式拒绝 `SCREEN`**（`gtkatspitext.c:445-450`：`"Unsupported coordinate space"`），只支持 `PARENT`/`WINDOW` | ❌（对 `panel_gtk4` 的 entry 直接 `NotSupported`） |
| `org.a11y.atspi.Cache.GetItems` | 签名 `a((so)(so)(so)iiassusau)` —— **结构里没有矩形字段** | ❌ |
| `org.a11y.atspi.Window` | GTK4 的 frame 只挂 `Component/Accessible/Action` | ❌ 接口不存在 |

Cache 的实测（`gdbus introspect` + `GetItems`）：

```console
$ gdbus introspect --address "$AT_SPI_BUS_ADDRESS" --dest :1.1 --object-path /org/a11y/atspi/cache
  interface org.a11y.atspi.Cache {
    methods:
      GetItems(out a((so)(so)(so)iiassusau) nodes);
    signals:
      AddAccessible(((so)(so)(so)iiassusau) nodeAdded);
      RemoveAccessible((so) nodeRemoved);
  };
```

11 个字段：object / parent / app / index / child_count / interfaces / name / role /
description / states / attributes。**没有 rect**，与 GTK 自带的 `atspi/Cache.xml`（= at-spi2-core 规范）一致，
所以"用 Cache 换成带 extents 的新版 GetItems"这条路不存在。

### 3.4 上游状态

* GNOME GitLab [#6343 "Atk screen coordinates of widgets regression since Gtk4.10"](https://gitlab.gnome.org/GNOME/gtk/-/work_items/6343)：
  复现程序就是"每个 widget 都返回 `(0,0)`"，2023 年就报了。
* 本文写作时下载的 **`main` 分支** `gtk/a11y/gtkatspiutils.c` 仍然是
  `if (coordtype == ATSPI_COORD_TYPE_SCREEN) { *xo = 0; *yo = 0; return; }`
  （两处都在，行号 522 / 576）。→ **短期内不会被修**。
* 旁证：另外两个项目独立撞上同一个坑并做了同一套 workaround——
  [trycua/cua 的 commit](https://github.com/trycua/cua/commit/53052c4f0ca44c1f9114018bf72c1682cd3a6ed1)（"GTK4's AT-SPI bridge reports
  GetExtents(Screen) as if it were GetExtents(Window)"）、
  [oh-my-pi PR #18643](https://github.com/can1357/oh-my-pi/pull/18643)。

---

## 4. 存疑 / 未解释（确定项之外的）

1. **libadwaita 应用的内部偏移**：`nautilus` 的 frame 报 `WINDOW=(-5,-5,890,550)`（尺寸与 X
   窗口一致），而其内容区在 X 窗口内从 `(0,0)` 开始。用"X 原点 − frame.WINDOW 原点"锚定后，
   实测同类控件的偏差在 **−4 … +11 px** 之间，且不同子树不一致（侧栏条目偏高 ~11 px、
   文件网格偏低 ~4 px）。确定的事实是"偏差小于控件尺寸、点得中"（§6.4 实测），
   但**"为什么是 5/11 px"没查清**（可能与该应用自绘 CSD 边距/滚动容器有关；Libadwaita
   窗口在 surface 内还有一层 margin）。
2. **popover / 二级 surface**：GTK4 的 `GtkPopover` 在 X11 上是独立 X window，但 AT-SPI 里
   它的 `WINDOW` 坐标是**相对父 toplevel** 的（实测 popover 节点 `WINDOW=(118,80,165,158)`，
   X 窗口在 `+119+543`，toplevel 在 `+0+470`）。因此同一套换算可用，实测偏差 ~8 px，
   点击落地成功（§6.4）。**是否所有二级 surface（`GtkPopoverMenu`、tooltip、
   `GtkPopover` 带 `has-arrow` 翻转）都成立未穷举。**
3. **WebKitGTK / 嵌入式 AT-SPI socket**（`GtkAtSpiSocket`，见
   `gtk_a11y` 里 `Embed`/`embedded` 逻辑）：Web 内容走另一套实现，可能自带正确的屏幕坐标。
   未测，也超出本插件范围。
4. **`gtk_at_spi_translate_coordinates_*` 对 `PARENT` 的语义**：`PARENT` 返回值看起来是
   "父容器相对"，但对某些容器（如 `GtkWindow`）语义模糊；本报告没有依赖 `PARENT`。

---

## 5. 替代路径逐条评估

### A. `org.a11y.atspi.Cache.GetItems`（新版带 rect？）— ❌ 死路

* 实测：GTK4 的 `GetItems` 结构 `a((so)(so)(so)iiassusau)` 无 rect；GTK 自带的
  `gtk/a11y/atspi/Cache.xml`（照抄 at-spi2-core 规范）就是这 11 个字段，没有矩形。
  libatspi 的本地 cache 同样不含 extents（它只缓存 role/name/state/attributes）。
* 代价：0（不可行）。

### B. 其它 AT-SPI 接口（Text/Hypertext/Value/Selection/Action/Window）— ❌ 拿不到位置

* `Text.GetCharacterExtents/GetRangeExtents` 对 `SCREEN` 直接返回
  `org.freedesktop.DBus.Error.NotSupported`（源码里是显式拒绝），只支持 `WINDOW`/`PARENT`；
  对 `panel_gtk4` 的 entry **连 `WINDOW` 也返回 NotSupported**（该 entry 不是
  `GtkText`，走的是另一条实现）。
* `Value`/`Selection`/`Hypertext` 不提供几何；`Action` 只提供"按名字触发"，不提供坐标
  （而且插件契约本来就是坐标点击，不走 Action）。
* `org.a11y.atspi.Window` 在 GTK4 里**不存在**——GTK4 的 frame 只挂 `Component/Accessible/Action`（GTK3 的 atk-bridge 才有 Window 相关方法）。
* 综上：**AT-SPI 这一侧不存在任何能给出屏幕坐标的接口**——这不是"没试对接口"，
  而是 GTK4 实现层整体缺失。

### C. GTK Inspector / DEBUG 接口 — ⚠️ 不可用于自动化

* 打开方式：`GTK_DEBUG=interactive` 启动应用（带该环境变量时，运行中可用 `Ctrl+Shift+D` 开关）。
* 它是**进程内 GUI**：没有 D-Bus、没有 socket、没有脚本控制台（GTK4 inspector 的页面是
  General / CSS / Visual / Objects / Actions / Recorder / Statistics / Logs / Magnifier）。
  `Objects` 页能看 widget 树与属性，但没有"把 allocation 导出来"的通道；
  内部用的是 `gtk_widget_compute_bounds(widget, native, …)`（surface 相对），
  和 AT-SPI 给的一样，也**没有屏幕坐标**。
* 要对一个已经在跑的应用用它：不可能（必须重启并带环境变量）。
* 想抓取它的 UI：它自己也是 GTK4 → 同样 `SCREEN=(0,0,w,h)`，绕回原点问题。
* 代价：高（无 API、要重启、脆弱）。**结论：只能当人工排查工具，不能作为生产路径。**

### D. X11 窗口几何 + 控件相对布局（`GetExtents(WINDOW)`）— ✅ 推荐

* 事实基础：GTK4 **一个 surface = 一个 X 顶层窗口**（`xwininfo` 里窗口树非常干净，
  没有每个控件一个 X window），控件在 surface 内的位置由 `WINDOW` 精确给出。
* 换算：`screen = (X 顶层窗口原点) + GetExtents(WINDOW)`；用 frame 自己的
  `WINDOW` 矩形锚定 X 窗口（见 §6.2 的 `delta`），可消掉 frame 非 `(0,0)` 的情况。
* 实测精度：fixture **逐像素精确**（§6.3）；nautilus 偏差 −4…+11 px 但点击成功（§6.4）；
  popover 偏差 ~8 px、点击成功。
* 代价：每次拍照多 1 次 `xdotool search` + 每候选窗口 1 次 `xwininfo`（实测 +37 ms，
  565 → 602 ms 中位数）；需要能把 AT-SPI 的 frame 对上 X 窗口（pid + 尺寸匹配足够）。
* 限制：只适用于 X11（本插件本来就只支持 X11）；Wayland 原生窗口拿不到别的应用窗口位置
  （但本插件在 Wayland 上本来也不工作）。

### E. 视觉兜底（截图 + OCR / 模板匹配）— ⚠️ 勉强，成本高

* 现状实测：本机 tessdata 只有 `afr`/`osd`（无 `eng`、无 `chi_sim`）。对 GTK4 fixture 窗口
  截图 → `tesseract -l afr`（0.34 s）输出：

  ```
  type here
  E Click          ← "点击 Click" 的中文丢了
  T Cheek          ← "勾选 Check" 误识别
  dicks-2 checked-false text—”   ← 状态行几乎全错
  ```

  即：**没有中文语言包时基本不可用**，且要精度就得装 `tesseract-ocr-data-chi_sim`（本环境无网/需加
  依赖），单帧 OCR 在 CJK 小字号上通常 1–2 s、准确率不稳；而且 OCR 给的是文本 bbox，
  不是控件 bbox（按钮/复选框边界要另做检测）。
* 模板匹配（图标/按钮样式）能绕开 OCR，但要为每个主题/DPI 维护模板库，且无法处理
  动态文本按钮。
* 代价：高（1–2 周才稳），准确率受主题/缩放/语言影响；**只适合当最后兜底**，
  比如"D 方案匹配不上 X 窗口"时用截图人工确认。

### F. 调试器注入（gdb attach / `gtk_widget_compute_bounds`）— ⚠️ 可行但代价极高

* 同用户可 `ptrace`；`gdb -p <pid>` 后调 `gtk_widget_get_native()` +
  `gdk_surface_get_...`/`gtk_widget_compute_point()` 可以算出**真正的**屏幕坐标。
* 但：要暂停进程（UI 冻结）、每个控件一次函数调用、GTK 内部符号/结构随版本变化、
  在 release 构建上调用可能立即崩、权限/安全策略（Yama `ptrace_scope`）会挡。
* 代价：极高，收益仅"比 D 方案准几像素"。**不推荐**，除非将来需要 1px 精度且能接受侵入。

### 汇总

| 路径 | 能否拿到控件位置/尺寸 | 精度 | 成本 | 结论 |
|---|---|---|---|---|
| A. Cache.GetItems | ❌ 无 rect 字段 | — | 0 | 死路 |
| B. 其它 AT-SPI 接口 | ❌ 全部缺屏幕坐标 | — | 0 | 死路 |
| C. GTK Inspector / DEBUG | ❌ 无 IPC，进程内 GUI | — | 高 | 仅人工排查 |
| **D. X11 原点 + WINDOW 坐标** | ✅ | fixture 逐像素；真实应用 ±4–11 px | 低（~80 行） | **推荐** |
| E. 截图 + OCR/模板 | ⚠️ 只能给文本 bbox | 低（缺语言包时不可用） | 高 | 兜底 |
| F. gdb 注入 | ✅（真值） | 1 px | 极高 | 不推荐 |

---

## 6. 推荐方案

### 6.1 结论

**选 D。** 在 `scripts/numbering.py` 里，当检测到"GTK4 特征"（所有 `SCREEN` 原点相同、
`WINDOW` 原点却不止一个）时，把每个目标矩形重算为
`(X11 顶层窗口原点 − frame.WINDOW 原点) + GetExtents(WINDOW)`。
其余路径（守卫、排序、编号、裁剪、Node 侧点击）**全都不用动**，因为插件契约本来就是
"sidecar 里给屏幕矩形，Node 侧用 XTEST 点中心"。

### 6.2 补丁

文件：`docs/gtk4-origin-fallback.patch`（147 行 diff，**未应用**，`git apply --check` 通过）。
改动 4 处、约 80 行：

| 位置 | 改动 |
|---|---|
| `extents()` 之后 | 新增 `extents_window()`：读 `GetExtents(WINDOW)` |
| `collect_app()` 之前 | 新增 `x11_window_origin(display, pid, w, h)`：`xdotool search --pid` + `xwininfo`，按"客户区尺寸 == AT-SPI frame 尺寸"匹配顶层窗口（区分多窗口/对话框） |
| 同上 | 新增 `fix_screen_rects()`：只在"屏幕原点唯一、窗口原点不唯一"时触发；按 frame 逐个求 `delta = X 原点 − frame.WINDOW 原点`，重写 `rect`，并打标 `rectSource='x11-origin+window'` |
| `collect_app()` 内 | 每个节点多存 `windowRect`、`frameKey`；收集结束后调用 `fix_screen_rects()`；`cmd_shot()` 把 `args.display` 传进来 |

为什么用 frame 的 `WINDOW` 原点做锚（而不是直接加 X 原点）：GTK4 的 frame 自身 `WINDOW`
不一定是 `(0,0)`（nautilus 是 `(-5,-5)`），锚定后能保证"frame 矩形 == X 窗口矩形"，
在两种情况下都对。

### 6.3 验证（像素级）

`:152`（openbox，窗口 `+282+183`）上，补丁给出的 `点击 Click` 推导矩形为
`(290, 231, 444, 34)`。fixture 的灰色 `GtkDrawingArea`（`WINDOW=(8,122,444,120)`）推导为
`(290, 305, 444, 120)`；直接数截图里 `rgb(217,217,217)` 的像素包围盒：

```
rows 305..424  x 290..733   ← 与推导值 290..733 / 305..424 完全一致
```

即 **逐像素精确**（无 WM / openbox 都一样，因为 GTK4 的 surface 原点就是 X 窗口原点）。

端到端点击（脚本 `test/gtk4-probe/verify_fix.py`，同一 XTEST 原语）：

```console
$ python3 test/gtk4-probe/verify_fix.py --name panel_gtk4 --click "点击 Click"
app=panel_gtk4 pid=133833 frame(WINDOW)=(0, 0, 460, 420)
x11 toplevel origin = (282, 183, '6291461')
name             role        reported SCREEN     derived SCREEN      WINDOW
input            text        (0, 0, 444, 34)     (290, 191, 444, 34) (8, 8, 444, 34)
点击 Click        button      (0, 0, 444, 34)     (290, 231, 444, 34) (8, 48, 444, 34)
check            check box   (0, 0, 444, 28)     (290, 271, 444, 28) (8, 88, 444, 28)
distinct derived positions: 7
distinct reported positions: 1
click at derived centre (512,248)
  status before: clicks=1 checked=false text=''
  status after : clicks=2 checked=false text=''
  RESULT: CLICK LANDED
```

打上补丁后插件自身输出（干净环境 `:153`）：

```console
# 原始
{"ok": false, "code": "E_NO_GEOMETRY", "stats": {"targets": 3, "distinctPositions": 1}}
# 补丁后
{"ok": true, "code": null, "geometryTrusted": true,
 "stats": {"targets": 3, "distinctPositions": 3}}
[('input', [8, 8, 444, 34]), ('点击 Click', [8, 48, 444, 34]), ('check', [8, 88, 444, 28])]
```

### 6.4 真实应用验证

* `nautilus`（真实 GTK4 + libadwaita）：混合桌面共 33 个目标（nautilus 约 17 个）全部得到互不相同的屏幕矩形；
  按推导中心点击侧栏"回收站" → **窗口真的导航到回收站**（截图确认路径栏变成"回收站"）。
* popover（`test/gtk4-probe/panel_gtk4_popover.c`）：打开菜单后 `popover item 1..3` 被编号，
  按推导中心点 `item2` → 应用自己打印 `clicks=1 last=item2`。偏差 ~8 px 不影响命中。
* 回归：`:151` 上 GTK3 + Qt 的目标矩形与打补丁前**完全一致**（补丁只对"屏幕原点唯一"的
  app 生效，GTK3/Qt 不满足该特征）。

### 6.5 工作量与注意事项

* 改动量：**0.5 人日**（代码 80 行 + 一个 fixture 级验证）。若要做细致化：
  * **0.5 人日**：用一次 `xwininfo -root -tree` 批量解析替代 N 次 `xwininfo`，把 +37 ms 压到 +10 ms 内；
  * **0.5 人日**：`_GTK_FRAME_EXTENTS` / libadwaita 边距校正，把 nautilus 的 ±11 px 收敛到 0–2 px（需要先搞清 §4.1）；
  * **0.5 人日**：给 `test/integration.mjs` 换成"GTK4 现在能被编号且点击生效"的正向断言。
* ⚠️ **必须同步改的测试**：`test/integration.mjs:176 runGtk4Limit()` 现在断言
  `code === 'E_NO_GEOMETRY'`，打补丁后该断言会失败——这是预期的，需要改成
  正向断言（本次按约定**没有**改任何测试/README/VERIFY）。
* 建议保留 `E_NO_GEOMETRY` 守卫作为兜底（匹配不到 X 窗口时仍然拒绝编号，不静默乱点）。
* 建议**顺手修混合会话的静默错误**（§1.4）：把守卫从"全局 distinctPositions"改成
  "按 app 判断"，否则 GTK4 目标在混合桌面上会被编到 `(0,0)`。

---

## 7. 附录：脚本与命令

```bash
# 环境
./test/gtk4-probe/env.sh 151            # 起 Xvfb + 私有 session bus + 私有 a11y bus
. ./test/gtk4-probe/use.sh 151

# 对比
python3 test/gtk4-probe/dump.py --depth 4            # 原始 D-Bus：SCREEN/WINDOW/PARENT
python3 test/gtk4-probe/dump.py --gi                 # 走 libatspi（插件同路径）
python3 test/gtk4-probe/dump.py --cache              # 读 org.a11y.atspi.Cache
python3 test/gtk4-probe/iface_probe.py --dest :1.1 \
        --path /org/gtk/application/panel_gtk4/a11y/<uuid> --label input --point 10,20

# 验证补丁思路
python3 test/gtk4-probe/verify_fix.py --name panel_gtk4 --click "点击 Click"

# 应用/回滚补丁
git apply docs/gtk4-origin-fallback.patch       # 应用
git apply -R docs/gtk4-origin-fallback.patch    # 回滚（或 git checkout scripts/numbering.py）
```

用到的上游源码（下载到 `/tmp`，未入库）：
`gtk-4.24.1.tar.xz`（`gtk/a11y/gtkatspiutils.c`、`gtkatspicomponent.c`、`gtkatspitext.c`、
`atspi/Cache.xml`）、`main` 分支的 `gtk/a11y/gtkatspiutils.c`。
