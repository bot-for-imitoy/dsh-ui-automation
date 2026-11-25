#!/usr/bin/env python3
"""numbering.py — numbered screenshot + index-driven targeting for dsh-ui-automation.

Adapted from the "Voice Access style" probe (voice-access-style-numbering):
AT-SPI tree -> actionable filter -> ancestor de-dup -> reading order -> 1..N ->
crop to the windows -> ffmpeg x11grab with drawtext badges + thin outlines.

The plugin's whole contract is "number = pixel": the sidecar JSON records each
target's screen rectangle and centre, and the Node side clicks those centres
with XTEST. No AT-SPI Action is used for click/double-click/scroll/drag.

Subcommands:
  shot       capture a numbered screenshot and write <out-dir>/<image-id>.png
             plus <out-dir>/<image-id>.json, and print the summary as JSON
  apps       list AT-SPI application names (used by the test harness)
  set-text   EditableText.SetTextContents on one node, with readback
  get-text   read one node's text
  status     read the fixture's "clicks=..." status label (test helper)

Only Linux / X11 is supported.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)

try:
    import gi

    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception as error:  # pragma: no cover - environment failure is reported as JSON
    print(json.dumps({'ok': False, 'code': 'E_NO_ATSPI',
                      'error': 'python-gobject/Atspi is unavailable: %s' % error}))
    sys.exit(1)

FONT_DEFAULT = '/usr/share/fonts/TTF/Hack-Bold.ttf'
FONT_FALLBACKS = (
    '/usr/share/fonts/TTF/Hack-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
)

INTERACTIVE_ROLES = {
    'push button', 'button', 'toggle button', 'check box', 'radio button',
    'combo box', 'text', 'entry', 'password text', 'list item', 'menu item',
    'check menu item', 'radio menu item', 'page tab', 'tab', 'slider',
    'spin button', 'link', 'tree item', 'table cell', 'switch',
}
EXCLUDED_ROLES = {
    'application', 'frame', 'window', 'dialog', 'panel', 'filler', 'scroll pane',
    'viewport', 'separator', 'label', 'static', 'icon', 'image', 'menu bar',
    'status bar', 'tool bar', 'tooltip', 'alert', 'drawing area', 'page tab list',
    'list', 'list box', 'grouping', 'layered pane', 'scroll bar', 'document frame',
    'redundant object', 'unknown', 'menu', 'table', 'tree', 'tree table',
    'section', 'heading', 'paragraph', 'article', 'form', 'landmark',
}
OPERATE_ACTIONS = {
    'press', 'click', 'toggle', 'activate', 'check', 'uncheck', 'expand',
    'collapse', 'increment', 'decrement', 'increase', 'decrease', 'show menu',
}
# Plain surfaces that are still intentional drag/click targets when the app
# gives them an accessible name (the test fixtures' drag/double-click/wheel
# areas are Qt/GTK "filler"/"panel" nodes). A region that merely wraps other
# candidates is dropped below, so a window's root filler never gets a number.
REGION_ROLES = {'filler', 'panel', 'drawing area', 'canvas'}
FOCUS_IS_ENOUGH = {
    'text', 'entry', 'password text', 'combo box', 'spin button', 'slider',
    'list item', 'page tab', 'tab', 'tree item', 'table cell', 'check box',
    'radio button', 'link',
}
STATE_NAMES = ('showing', 'visible', 'enabled', 'focusable', 'focused', 'checked',
               'selected', 'editable', 'expanded', 'pressed', 'sensitive')
BADGE_W, BADGE_H = 22, 20


# --------------------------------------------------------------------------
# AT-SPI helpers
# --------------------------------------------------------------------------

def extents(acc):
    try:
        comp = acc.get_component()
        if comp is None:
            return None
        e = comp.get_extents(Atspi.CoordType.SCREEN)
        if e is None:
            return None
        return (int(e.x), int(e.y), int(e.width), int(e.height))
    except Exception:
        return None


def action_names(acc):
    try:
        act = acc.get_action()
        if act is None:
            return []
        return [act.get_action_name(i) or '' for i in range(act.get_n_actions())]
    except Exception:
        return []


def state_set(acc):
    out = set()
    try:
        ss = acc.get_state_set()
    except Exception:
        return out
    for name in STATE_NAMES:
        try:
            if ss.contains(getattr(Atspi.StateType, name.upper())):
                out.add(name)
        except Exception:
            pass
    return out


def text_of(acc):
    try:
        t = acc.get_text()
        if t is None:
            return ''
        return (Atspi.Text.get_text(acc, 0, t.get_character_count()) or '').strip()
    except Exception:
        return ''


def description_of(acc):
    try:
        return (acc.get_description() or '').strip()
    except Exception:
        return ''


def labelled_by(acc):
    names = []
    try:
        rels = acc.get_relation_set()
    except Exception:
        return names
    for rel in rels:
        try:
            rtype = rel.get_relation_type()
        except Exception:
            continue
        if rtype not in (Atspi.RelationType.LABELLED_BY, Atspi.RelationType.DESCRIPTION_FOR):
            continue
        for i in range(rel.get_n_targets()):
            try:
                tgt = rel.get_target(i)
                if tgt is None:
                    continue
                nm = (tgt.get_name() or '').strip() or text_of(tgt)
                if nm:
                    names.append(nm)
            except Exception:
                pass
    return names


def walk(acc, depth=0, max_depth=24, max_nodes=4000, path=''):
    """Yield (acc, depth, path) with a stable child-index path ("0/1/2")."""
    if depth > max_depth or max_nodes <= 0:
        return
    yield acc, depth, path
    try:
        count = acc.get_child_count()
    except Exception:
        return
    for i in range(count):
        try:
            child = acc.get_child_at_index(i)
        except Exception:
            continue
        if child is None:
            continue
        child_path = ('%s/%d' % (path, i)) if path else str(i)
        yield from walk(child, depth + 1, max_depth, max_nodes, child_path)


def desktop_apps():
    desktop = Atspi.get_desktop(0)
    return [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]


def find_app_by_pid(pid):
    for app in desktop_apps():
        try:
            if int(app.get_process_id()) == int(pid):
                return app
        except Exception:
            continue
    return None


def find_app_by_name(needle):
    for app in desktop_apps():
        try:
            if needle.lower() in (app.get_name() or '').lower():
                return app
        except Exception:
            continue
    return None


def frame_rect(app):
    candidates = []
    for acc, depth, _path in walk(app, max_depth=2):
        if depth != 1:
            continue
        rect = extents(acc)
        if rect and rect[2] > 40 and rect[3] > 40 and rect[2] < 100000:
            candidates.append(rect)
    if candidates:
        return max(candidates, key=lambda r: r[2] * r[3])
    return None


def child_labels(acc, max_depth=2):
    out = []
    for sub, depth, _path in walk(acc, max_depth=max_depth):
        if sub is acc:
            continue
        try:
            role = sub.get_role_name()
        except Exception:
            role = ''
        if role not in ('label', 'static', 'text'):
            continue
        nm = (sub.get_name() or '').strip() or text_of(sub)
        if nm and nm not in out:
            out.append(nm)
    return ' '.join(out)


def classify(acc):
    try:
        role = acc.get_role_name() or ''
    except Exception:
        role = ''
    name = ''
    try:
        name = (acc.get_name() or '').strip()
    except Exception:
        pass
    label, source = name, 'name'
    if not label:
        label, source = text_of(acc), 'text'
    if not label:
        label, source = description_of(acc), 'description'
    if not label:
        label, source = child_labels(acc), 'child-text'
    if not label:
        rel = labelled_by(acc)
        if rel:
            label, source = ' '.join(rel), 'labelled-by'
    if not label:
        source = 'none'

    actions = action_names(acc)
    states = state_set(acc)
    bounds = extents(acc)
    lowered = {a.lower() for a in actions}
    actionable = role in INTERACTIVE_ROLES or bool(lowered & OPERATE_ACTIONS)
    if not actionable and 'set focus' in lowered and role in FOCUS_IS_ENOUGH:
        actionable = True
    if not actionable and 'focusable' in states and role in FOCUS_IS_ENOUGH:
        actionable = True
    if role in EXCLUDED_ROLES:
        actionable = False
    return role, label, source, bounds, actions, states, actionable


def inside(rect, frame, tol=2):
    x, y, w, h = rect
    fx, fy, fw, fh = frame
    if w < 2 or h < 2:
        return False
    if x < -100000 or y < -100000:
        return False
    return (x + tol >= fx and y + tol >= fy
            and x + w <= fx + fw + tol and y + h <= fy + fh + tol)


def sort_reading_order(items):
    if not items:
        return items
    heights = [it['rect'][3] for it in items]
    median_h = sorted(heights)[len(heights) // 2]
    tol = max(8, int(median_h * 0.6))
    ordered = sorted(items, key=lambda it: (it['rect'][1], it['rect'][0]))
    bands = []
    for it in ordered:
        cy = it['rect'][1] + it['rect'][3] / 2
        placed = False
        for band in bands:
            if abs(band['cy'] - cy) <= tol:
                band['items'].append(it)
                band['cy'] = sum(i['rect'][1] + i['rect'][3] / 2 for i in band['items']) / len(band['items'])
                placed = True
                break
        if not placed:
            bands.append({'cy': cy, 'items': [it]})
    bands.sort(key=lambda b: min(i['rect'][1] for i in b['items']))
    result = []
    for band in bands:
        result.extend(sorted(band['items'], key=lambda it: it['rect'][0]))
    return result


def intersects(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return not (ax + aw <= bx or bx + bw <= ax or ay + ah <= by or by + bh <= ay)


def place_badges(items, frame):
    """Badge near the element's top-left, never on top of another badge."""
    fx, fy, fw, fh = frame
    placed = []
    for it in items:
        x, y, w, h = it['rect']
        candidates = [(x + 3, y + 3)]
        for dy in range(16, max(16, h - BADGE_H), 16):
            candidates.append((x + 3, y + dy))
        for dx in range(24, max(24, w - BADGE_W), 28):
            candidates.append((x + dx, y + 3))
        candidates.extend([(x + w - BADGE_W - 3, y + 3),
                           (x + 3, y + h - BADGE_H - 3),
                           (x + 3, y - BADGE_H - 2),
                           (x - BADGE_W - 2, y + 3)])
        chosen = None
        for cx, cy in candidates:
            rect = (cx, cy, BADGE_W, BADGE_H)
            if cx < fx + 2 or cy < fy + 2 or cx + BADGE_W > fx + fw - 2 or cy + BADGE_H > fy + fh - 2:
                continue
            if any(intersects(rect, p) for p in placed):
                continue
            chosen = rect
            break
        if chosen is None:
            cy = fy + 4
            while cy + BADGE_H < fy + fh - 2 and any(
                    intersects((fx + 4, cy, BADGE_W, BADGE_H), p) for p in placed):
                cy += BADGE_H + 2
            chosen = (fx + 4, cy, BADGE_W, BADGE_H)
        it['badge'] = [int(v) for v in chosen]
        placed.append(chosen)


# --------------------------------------------------------------------------
# Collection
# --------------------------------------------------------------------------

def collect_app(app, max_depth):
    frame = frame_rect(app)
    if frame is None:
        return None, []
    raw = []
    total = 0
    for acc, depth, path in walk(app, max_depth=max_depth):
        total += 1
        role, label, source, bounds, actions, states, actionable = classify(acc)
        is_region = role in REGION_ROLES and bool((acc.get_name() or '').strip())
        if not actionable and not is_region:
            continue
        if 'showing' not in states and 'visible' not in states:
            continue
        if 'defunct' in states:
            continue
        if bounds is None or not inside(bounds, frame):
            continue
        if is_region and not actionable and (bounds[2] < 24 or bounds[3] < 24):
            continue
        raw.append({
            'role': role, 'name': (acc.get_name() or ''), 'label': label,
            'labelSource': source, 'rect': list(bounds), 'actions': actions,
            'states': sorted(states), 'path': path, 'depth': depth,
            'kind': 'region' if (is_region and not actionable) else 'control',
            'appName': (app.get_name() or ''), 'appPid': int(app.get_process_id() or 0),
        })

    # exact duplicates (same role/label/rect exposed twice by a toolkit)
    seen = {}
    deduped = []
    for it in raw:
        key = (it['role'], it['label'], tuple(it['rect']))
        if key in seen:
            seen[key]['dupes'] += 1
            continue
        it['dupes'] = 0
        seen[key] = it
        deduped.append(it)

    # drop layout wrappers fully covered by an actionable ancestor
    def has_candidate_child(node):
        return any(o is not node and o['depth'] > node['depth'] for o in deduped)

    deduped = [it for it in deduped
               if it['label'] or ({a.lower() for a in it['actions']} & OPERATE_ACTIONS)
               or not has_candidate_child(it)]

    # A named region is a real target only if it does not wrap other candidates
    # (window root fillers, panels around buttons, ...).
    def contains_other(node):
        nx, ny, nw, nh = node['rect']
        for other in deduped:
            if other is node:
                continue
            ox, oy, ow, oh = other['rect']
            if ox >= nx and oy >= ny and ox + ow <= nx + nw and oy + oh <= ny + nh:
                if ow * oh < nw * nh:
                    return True
        return False

    deduped = [it for it in deduped
               if it.get('kind') != 'region' or not contains_other(it)]

    kept = []
    for it in deduped:
        covered = False
        ax, ay, aw, ah = it['rect']
        area = max(1, aw * ah)
        for other in deduped:
            if other is it:
                continue
            ox, oy, ow, oh = other['rect']
            if not (ox <= ax and oy <= ay and ox + ow >= ax + aw and oy + oh >= ay + ah):
                continue
            inter = max(0, min(ax + aw, ox + ow) - max(ax, ox)) * max(0, min(ay + ah, oy + oh) - max(ay, oy))
            if inter / area < 0.95:
                continue
            if other['depth'] >= it['depth']:
                continue
            if not ({a.lower() for a in it['actions']} & OPERATE_ACTIONS):
                covered = True
                break
        if not covered:
            kept.append(it)

    return frame, {'nodes': total, 'raw': len(raw), 'kept': kept,
                   'dupes': len(raw) - len(deduped)}


def screen_size(display):
    out = subprocess.run(['xdpyinfo', '-display', display], capture_output=True, text=True)
    match = re.search(r'dimensions:\s+(\d+)x(\d+)', out.stdout)
    if match is None:
        raise RuntimeError('cannot read display size via xdpyinfo: %s' % (out.stderr or out.stdout).strip())
    return int(match.group(1)), int(match.group(2))


def union(rects):
    xs = [r[0] for r in rects]
    ys = [r[1] for r in rects]
    x2 = [r[0] + r[2] for r in rects]
    y2 = [r[1] + r[3] for r in rects]
    return (min(xs), min(ys), max(x2) - min(xs), max(y2) - min(ys))


def clamp_rect(rect, screen):
    x, y, w, h = rect
    sw, sh = screen
    x = max(0, min(x, sw - 1))
    y = max(0, min(y, sh - 1))
    w = max(1, min(w, sw - x))
    h = max(1, min(h, sh - y))
    return (x, y, w, h)


def identify(font):
    for candidate in (font, *FONT_FALLBACKS):
        if candidate and os.path.exists(candidate):
            return candidate
    return None


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def cmd_shot(args):
    started = time.time()
    display = args.display
    screen = screen_size(display)
    per_app = []
    app_frames = []
    total_nodes = 0
    exact_dupes = 0
    for app in desktop_apps():
        try:
            app_name = (app.get_name() or '')
            app_pid = int(app.get_process_id() or 0)
        except Exception:
            continue
        if app_pid == os.getpid() or app_name in ('at-spi2-registryd',):
            continue
        try:
            frame, info = collect_app(app, args.max_depth)
        except Exception:
            continue
        if frame is None:
            continue
        total_nodes += info['nodes']
        exact_dupes += info['dupes']
        if not [r for r in [frame] if r[2] > 40 and r[3] > 40]:
            continue
        app_frames.append(frame)
        for it in info['kept']:
            per_app.append(it)

    # global exact de-dup across applications
    seen = {}
    targets = []
    for it in per_app:
        key = (it['role'], it['label'], tuple(it['rect']))
        if key in seen:
            exact_dupes += 1
            continue
        seen[key] = it
        targets.append(it)

    # geometry sanity: GTK4 reports (0,0,w,h) for every widget, so a
    # coordinate contract must not pretend those targets are clickable.
    positions = {(t['rect'][0], t['rect'][1]) for t in targets}
    geometry_trusted = not (len(targets) >= 3 and len(positions) <= 1)

    targets.sort(key=lambda t: (t['rect'][1], t['rect'][0]))
    targets = sort_reading_order(targets)
    if len(targets) > args.max_targets:
        targets = targets[:args.max_targets]
    for index, it in enumerate(targets, 1):
        it['index'] = index

    # crop to the windows that actually contributed targets (no black desktop)
    if args.no_crop or not app_frames:
        crop = (0, 0, screen[0], screen[1])
    else:
        x0, y0, w0, h0 = union(app_frames)
        pad = max(0, args.padding)
        # pad symmetrically, but clamp each side independently: padding past the
        # root window edge used to leave a black strip on the right/bottom
        left = max(0, x0 - pad)
        top = max(0, y0 - pad)
        right = min(screen[0], x0 + w0 + pad)
        bottom = min(screen[1], y0 + h0 + pad)
        crop = clamp_rect((left, top, right - left, bottom - top), screen)
        if crop[2] * crop[3] >= screen[0] * screen[1] * 0.98:
            crop = (0, 0, screen[0], screen[1])

    ox, oy, cw, ch = crop
    for it in targets:
        x, y, w, h = it['rect']
        it['imageRect'] = [x - ox, y - oy, w, h]
        it['center'] = [x + w // 2, y + h // 2]

    # badges in image coordinates
    if geometry_trusted:
        badge_items = []
        for it in targets:
            badge_items.append({'rect': it['imageRect'], 'index': it['index']})
        place_badges(badge_items, (0, 0, cw, ch))
        for it, badge_item in zip(targets, badge_items):
            it['badge'] = badge_item['badge']
    else:
        for it in targets:
            it['badge'] = None

    image_id = args.image_id or ('shot-%d' % int(started * 1000))
    os.makedirs(args.out_dir, exist_ok=True)
    png_path = os.path.join(args.out_dir, image_id + '.png')
    json_path = os.path.join(args.out_dir, image_id + '.json')

    font = identify(args.font)
    capture_failed = None
    if geometry_trusted:
        filters = []
        for it in targets:
            x, y, w, h = it['imageRect']
            bx, by, _bw, _bh = it['badge']
            filters.append('drawbox=x=%d:y=%d:w=%d:h=%d:color=0x00A0FF@0.55:t=1' % (x, y, w, h))
            filters.append(
                "drawtext=fontfile=%s:text='%d':x=%d:y=%d:fontsize=13:"
                'fontcolor=0x0F0F0F:box=1:boxcolor=0xFFD400@0.95:boxborderw=4'
                % (font, it['index'], bx, by))
        vf = ','.join(filters) if filters else 'null'
    else:
        vf = 'null'

    source = '%s+%d,%d' % (display, ox, oy)
    command = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'x11grab', '-video_size', '%dx%d' % (cw, ch), '-i', source,
        '-vf', vf, '-frames:v', '1', png_path,
    ]
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=30)
        if proc.returncode != 0 or not os.path.exists(png_path):
            capture_failed = (proc.stderr or proc.stdout or 'ffmpeg failed').strip()[-500:]
    except Exception as error:
        capture_failed = str(error)

    sidecar = {
        'imageId': image_id,
        'display': display,
        'createdAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'screen': {'width': screen[0], 'height': screen[1]},
        'crop': {'x': ox, 'y': oy, 'width': cw, 'height': ch},
        'imagePath': png_path,
        'image': {'width': cw if not capture_failed else 0, 'height': ch if not capture_failed else 0},
        'geometryTrusted': geometry_trusted,
        'targets': targets,
        'stats': {
            'totalNodes': total_nodes,
            'targetsBeforeDedupe': len(per_app),
            'exactDuplicates': exact_dupes,
            'targets': len(targets),
            'distinctPositions': len(positions),
            'apps': len(desktop_apps()),
        },
    }
    with open(json_path, 'w') as handle:
        json.dump(sidecar, handle, ensure_ascii=False, indent=1)
        handle.write('\n')

    if capture_failed is not None:
        code, error = 'E_CAPTURE', capture_failed
    elif not geometry_trusted:
        code = 'E_NO_GEOMETRY'
        error = ('AT-SPI reports identical (x,y) rectangles for every target; '
                 'this toolkit (typically GTK4) cannot be numbered for a coordinate contract.')
    else:
        code, error = None, None
    result = {
        'ok': code is None,
        'code': code,
        'error': error,
        'imageId': image_id,
        'display': display,
        'imagePath': png_path,
        'sidecarPath': json_path,
        'screen': sidecar['screen'],
        'crop': sidecar['crop'],
        'image': sidecar['image'],
        'geometryTrusted': geometry_trusted,
        'targets': targets,
        'stats': sidecar['stats'],
        'elapsedMs': round((time.time() - started) * 1000, 1),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0 if code is None else 1


def cmd_apps(args):
    apps = []
    for app in desktop_apps():
        try:
            apps.append({'name': app.get_name() or '', 'pid': int(app.get_process_id() or 0)})
        except Exception:
            continue
    print(json.dumps({'ok': True, 'apps': apps}, ensure_ascii=False))
    return 0


def check_expect_name(acc, expected):
    if not expected:
        return None
    actual = (acc.get_name() or '').strip()
    if actual != expected:
        return 'node at this path is %r, expected %r (UI relayouted?)' % (actual, expected)
    return None


def resolve_node(app_pid, node_path):
    app = find_app_by_pid(app_pid)
    if app is None:
        return None, 'application pid %s is not on the AT-SPI bus' % app_pid
    acc = app
    for part in str(node_path).split('/'):
        if part == '':
            continue
        try:
            acc = acc.get_child_at_index(int(part))
        except Exception:
            acc = None
        if acc is None:
            return None, 'no node at path %s' % node_path
    return acc, None


def cmd_set_text(args):
    acc, error = resolve_node(args.app_pid, args.node_path)
    if acc is None:
        print(json.dumps({'ok': False, 'code': 'E_NO_NODE', 'error': error}, ensure_ascii=False))
        return 1
    moved = check_expect_name(acc, args.expect_name)
    if moved:
        print(json.dumps({'ok': False, 'code': 'E_NODE_MOVED', 'error': moved}, ensure_ascii=False))
        return 1
    editable = None
    try:
        editable = acc.get_editable_text()
    except Exception:
        editable = None
    if editable is None:
        print(json.dumps({'ok': False, 'code': 'E_NO_EDITABLE', 'error': 'node has no EditableText'},
                         ensure_ascii=False))
        return 1
    try:
        editable.set_text_contents(args.text)
    except Exception as error:
        print(json.dumps({'ok': False, 'code': 'E_SET_TEXT', 'error': str(error)}, ensure_ascii=False))
        return 1
    time.sleep(0.05)
    print(json.dumps({'ok': True, 'textAfter': text_of(acc), 'nodeName': (acc.get_name() or '')},
                     ensure_ascii=False))
    return 0


def cmd_get_text(args):
    acc, error = resolve_node(args.app_pid, args.node_path)
    if acc is None:
        print(json.dumps({'ok': False, 'code': 'E_NO_NODE', 'error': error}, ensure_ascii=False))
        return 1
    moved = check_expect_name(acc, args.expect_name)
    if moved:
        print(json.dumps({'ok': False, 'code': 'E_NODE_MOVED', 'error': moved}, ensure_ascii=False))
        return 1
    print(json.dumps({'ok': True, 'text': text_of(acc), 'nodeName': (acc.get_name() or '')},
                     ensure_ascii=False))
    return 0


def cmd_status(args):
    app = find_app_by_name(args.app_name) if args.app_name else None
    if app is None:
        print(json.dumps({'ok': False, 'code': 'E_NO_APP', 'error': 'application not found'},
                         ensure_ascii=False))
        return 1
    for acc, _depth, _path in walk(app, max_depth=32):
        try:
            name = acc.get_name() or ''
        except Exception:
            continue
        if 'clicks=' in name:
            print(json.dumps({'ok': True, 'status': name}, ensure_ascii=False))
            return 0
        text = text_of(acc)
        if 'clicks=' in text:
            print(json.dumps({'ok': True, 'status': text}, ensure_ascii=False))
            return 0
    print(json.dumps({'ok': False, 'code': 'E_NO_STATUS', 'error': 'no clicks= label found'},
                     ensure_ascii=False))
    return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['shot', 'apps', 'set-text', 'get-text', 'status'])
    parser.add_argument('--display', default=os.environ.get('DISPLAY', ':0'))
    parser.add_argument('--dbus-address', default='')
    parser.add_argument('--out-dir', default='.')
    parser.add_argument('--image-id', default='')
    parser.add_argument('--font', default=FONT_DEFAULT)
    parser.add_argument('--max-depth', type=int, default=24)
    parser.add_argument('--max-targets', type=int, default=60)
    parser.add_argument('--padding', type=int, default=0)
    parser.add_argument('--no-crop', action='store_true')
    parser.add_argument('--app-pid', type=int, default=0)
    parser.add_argument('--node-path', default='')
    parser.add_argument('--text', default='')
    parser.add_argument('--app-name', default='')
    parser.add_argument('--expect-name', default='')
    args = parser.parse_args()

    if args.dbus_address:
        os.environ['DBUS_SESSION_BUS_ADDRESS'] = args.dbus_address
    os.environ['DISPLAY'] = args.display

    handlers = {
        'shot': cmd_shot,
        'apps': cmd_apps,
        'set-text': cmd_set_text,
        'get-text': cmd_get_text,
        'status': cmd_status,
    }
    try:
        return handlers[args.command](args)
    except Exception as error:
        print(json.dumps({'ok': False, 'code': 'E_NUMBERING', 'error': '%s: %s' % (type(error).__name__, error)},
                         ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
