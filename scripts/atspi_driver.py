#!/usr/bin/env python3
"""atspi_driver.py — long-lived AT-SPI + XTEST driver for dsh-ui-automation.

Started inside a managed headless shell (private D-Bus session + private
XDG_RUNTIME_DIR + one Xvfb display). It serves newline-delimited JSON requests
on a Unix socket; one request in, one response out, handled sequentially so
AT-SPI/GTK calls never race each other.

Two independent channels:
  * semantic — AT-SPI tree / Action / EditableText (names, roles, paths);
  * pointer/keyboard — XTEST through xdotool (coordinates, chords, CJK text).

The driver never decides whether an action "worked": it reports raw results and
readback values. The Node side applies pacing and asserts application state.
"""
import argparse
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)

import gi  # noqa: E402

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi  # noqa: E402

STATE_NAMES = (
    'enabled', 'visible', 'showing', 'focused', 'focusable', 'checked',
    'selected', 'editable', 'sensitive', 'expanded', 'pressed', 'active',
    'single_line', 'multi_line', 'selectable', 'defunct', 'busy',
)
# States that change just because a pointer/keyboard event landed somewhere.
# Excluded from the readback digest so "focus moved" is not mistaken for
# "the application state changed".
VOLATILE_STATES = {'focused', 'active'}

TOOLKIT_PATTERNS = (
    ('libQt6Core', 'qt6'),
    ('libQt5Core', 'qt5'),
    ('libgtk-4', 'gtk4'),
    ('libgtk-3', 'gtk3'),
    ('libelectron', 'electron'),
    ('libnode', 'node'),
    ('libwx_base', 'wx'),
)

LOG_FILE = None


def log(message):
    if LOG_FILE is None:
        return
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as handle:
            handle.write('%s %s\n' % (time.strftime('%H:%M:%S'), message))
    except Exception:
        pass


class DriverError(Exception):
    def __init__(self, message, code='E_DRIVER'):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- AT-SPI walk

def children(acc):
    try:
        return [acc.get_child_at_index(i) for i in range(acc.get_child_count())]
    except Exception:
        return []


def walk(app, max_depth=24, max_nodes=4000):
    """Yield (path, accessible, depth), depth-first. Path is '0/2/1'."""
    counter = {'n': 0}
    order = {'i': 0}

    def visit(acc, path, depth):
        if counter['n'] >= max_nodes or depth > max_depth:
            return
        counter['n'] += 1
        yield path, acc, depth
        for index, child in enumerate(children(acc)):
            yield from visit(child, ('%s/%d' % (path, index)) if path else str(index), depth + 1)

    yield from visit(app, '', 0)


def text_of(acc):
    try:
        text = acc.get_text()
        if text is None:
            return None
        return Atspi.Text.get_text(acc, 0, text.get_character_count())
    except Exception:
        return None


def value_of(acc):
    try:
        value = acc.get_value()
        if value is None:
            return None
        return round(float(value.get_current_value()), 4)
    except Exception:
        return None


def actions_of(acc):
    try:
        action = acc.get_action()
        if action is None:
            return []
        return [action.get_action_name(i) for i in range(action.get_n_actions())]
    except Exception:
        return []


def states_of(acc):
    out = []
    try:
        state_set = acc.get_state_set()
    except Exception:
        return out
    for name in STATE_NAMES:
        try:
            if state_set.contains(getattr(Atspi.StateType, name.upper())):
                out.append(name)
        except Exception:
            pass
    return out


def role_of(acc):
    try:
        return acc.get_role_name()
    except Exception:
        return 'unknown'


def name_of(acc):
    try:
        return acc.get_name() or ''
    except Exception:
        return ''


def rect_of(acc):
    try:
        component = acc.get_component()
        if component is None:
            return None
        ext = component.get_extents(Atspi.CoordType.SCREEN)
        if ext is None or ext.width <= 1 or ext.height <= 1:
            return None
        return {'x': int(ext.x), 'y': int(ext.y), 'width': int(ext.width), 'height': int(ext.height)}
    except Exception:
        return None


def node_info(acc, path):
    rect = rect_of(acc)
    return {
        'path': path,
        'role': role_of(acc),
        'name': name_of(acc),
        'text': text_of(acc),
        'value': value_of(acc),
        'actions': actions_of(acc),
        'states': states_of(acc),
        'rect': rect,
    }


def toolkit_of(pid):
    """Infer the GUI toolkit from the process's mapped libraries.

    AT-SPI itself does not expose ToolkitName/Version through the Python
    bindings, and /proc is authoritative for what the process actually loaded.
    """
    key = 'unknown'
    try:
        try:
            maps = open('/proc/%d/maps' % int(pid), encoding='utf-8', errors='replace').read()
        except Exception:
            return {'name': 'unknown', 'pid': int(pid)}
    except Exception:
        return {'name': 'unknown', 'pid': int(pid)}
    for pattern, label in TOOLKIT_PATTERNS:
        if pattern in maps:
            key = label
            break
    version = None
    match = re.search(r'/libQt6Core\.so\.6\.(\d+\.\d+\.\d+)', maps)
    if match:
        version = match.group(1)
    return {'name': key, 'pid': int(pid), 'version': version}


def pie_actions():
    return ['press', 'click', 'activate', 'toggle', 'check', 'set focus', 'show menu']


def is_descendant(pid, ancestor):
    try:
        current = int(pid)
        target = int(ancestor)
    except Exception:
        return False
    if current == target:
        return True
    for _ in range(16):
        try:
            status = open('/proc/%d/status' % current, encoding='utf-8', errors='replace').read()
            parent = 0
            for line in status.splitlines():
                if line.startswith('PPid:'):
                    parent = int(line.split()[1])
                    break
        except Exception:
            return False
        if parent in (0, 1):
            return False
        if parent == target:
            return True
        current = parent
    return False


def desktop_apps():
    desktop = Atspi.get_desktop(0)
    out = []
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        out.append(app)
    return out


def find_app(path=None, name=None, pid=None, name_match='exact'):
    """Resolve one application object, by pid (preferred) or accessible name."""
    apps = desktop_apps()
    if pid:
        for app in apps:
            try:
                app_pid = app.get_process_id()
            except Exception:
                continue
            if is_descendant(app_pid, pid):
                return app
    if name:
        for app in apps:
            app_name = name_of(app)
            if name_match == 'contains':
                if name.lower() in app_name.lower():
                    return app
            else:
                if app_name.lower() == name.lower() or name.lower() in app_name.lower():
                    return app
    if path:
        return None
    return None


def app_descriptor(app, launch_pid=None):
    pid = None
    try:
        pid = int(app.get_process_id())
    except Exception:
        pass
    info = toolkit_of(pid) if pid else {'name': 'unknown', 'pid': None}
    return {
        'name': name_of(app),
        'pid': pid,
        'toolkit': info['name'],
        'version': info.get('version'),
        'launchPid': launch_pid,
    }


def resolve_node(app, spec):
    """Resolve one node. spec: {path?, name?, role?, index?, match?}."""
    path = spec.get('path')
    if path not in (None, ''):
        acc = app
        for part in str(path).split('/'):
            if part == '':
                continue
            try:
                acc = acc.get_child_at_index(int(part))
            except Exception:
                acc = None
            if acc is None:
                raise DriverError('no node at path %r' % path, 'E_NO_NODE')
        return str(path), acc

    wanted_name = spec.get('name')
    wanted_role = (spec.get('role') or '').strip().lower() or None
    match = spec.get('match') or 'exact'
    index = max(0, int(spec.get('index') or 0))
    hits = []
    for node_path, acc, _depth in walk(app):
        if wanted_role is not None and role_of(acc).lower() != wanted_role:
            continue
        if wanted_name is not None:
            actual = name_of(acc)
            if match == 'contains':
                if wanted_name.lower() not in actual.lower():
                    continue
            elif match == 'regex':
                try:
                    if re.search(wanted_name, actual) is None:
                        continue
                except re.error as error:
                    raise DriverError('bad regex: %s' % error, 'E_BAD_SPEC')
            else:
                if actual != wanted_name:
                    continue
        elif wanted_role is None:
            raise DriverError('target needs name, role or path', 'E_BAD_SPEC')
        hits.append((node_path, acc))
    if not hits:
        raise DriverError(
            'no node matched %s' % json.dumps({k: v for k, v in spec.items() if v is not None}, ensure_ascii=False),
            'E_NO_NODE',
        )
    if index >= len(hits):
        raise DriverError('index %d out of range (%d matches)' % (index, len(hits)), 'E_NO_NODE')
    return hits[index]


# ---------------------------------------------------------------------- XTEST

def run(cmd, timeout=20):
    started = time.perf_counter()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise DriverError('%s is not installed' % cmd[0], 'E_NO_BINARY')
    except subprocess.TimeoutExpired:
        raise DriverError('%s timed out after %ss' % (cmd[0], timeout), 'E_TIMEOUT')
    elapsed = (time.perf_counter() - started) * 1000
    if proc.returncode != 0:
        raise DriverError(
            '%s failed (exit %d): %s' % (cmd[0], proc.returncode, (proc.stderr or proc.stdout).strip()[:400]),
            'E_XDO',
        )
    return proc.stdout.strip(), elapsed


def xdo(*args, timeout=20):
    return run(['xdotool', *[str(a) for a in args]], timeout=timeout)


def window_info(wid):
    out, _ = run(['xwininfo', '-id', str(wid)])
    info = {'id': int(wid), 'pid': None}
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('Absolute upper-left X:'):
            info['x'] = int(line.split(':')[1])
        elif line.startswith('Absolute upper-left Y:'):
            info['y'] = int(line.split(':')[1])
        elif line.startswith('Width:'):
            info['width'] = int(line.split(':')[1])
        elif line.startswith('Height:'):
            info['height'] = int(line.split(':')[1])
    try:
        info['title'], _ = xdo('getwindowname', wid)
    except DriverError:
        info['title'] = ''
    try:
        pid_text, _ = xdo('getwindowpid', wid)
        if pid_text.strip().isdigit():
            info['pid'] = int(pid_text.strip())
    except DriverError:
        pass
    return info


def windows(pid=None):
    """Viewable windows first: focusing an unmapped window raises BadMatch."""
    result = []
    seen = set()
    for visible_only in (True, False):
        args = ['search']
        if visible_only:
            args.append('--onlyvisible')
        if pid:
            args += ['--pid', str(pid)]
        else:
            args += ['--name', '.']
        try:
            out, _ = xdo(*args)
        except DriverError:
            continue
        for line in out.splitlines():
            wid = line.strip()
            if not wid.isdigit() or wid in seen:
                continue
            seen.add(wid)
            try:
                result.append(window_info(wid))
            except DriverError:
                continue
        if result:
            break
    result.sort(key=lambda info: (info.get('width') or 0) * (info.get('height') or 0), reverse=True)
    return result


def focus_info():
    info = {'windowId': None, 'pid': None, 'current': False}
    try:
        out, _ = xdo('getwindowfocus')
        wid = out.strip()
        if wid.isdigit():
            info['windowId'] = int(wid)
            pid, _ = xdo('getwindowpid', wid)
            if pid.strip().isdigit():
                info['pid'] = int(pid.strip())
    except DriverError:
        pass
    return info


def ensure_a11y():
    """Turn AT-SPI on for this private session bus (Qt only reports when true)."""
    for _ in range(10):
        try:
            import dbus
            bus = dbus.SessionBus()
            obj = bus.get_object('org.a11y.Bus', '/org/a11y/bus')
            props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties')
            props.Set('org.a11y.Status', 'IsEnabled', dbus.Boolean(True))
            try:
                props.Set('org.a11y.Status', 'ScreenReaderEnabled', dbus.Boolean(True))
            except Exception:
                pass
            return True
        except Exception as error:
            last = error
            time.sleep(0.1)
    log('enable_a11y failed: %r' % last)
    return False


# ------------------------------------------------------------------- commands

def cmd_ping(args):
    return {
        'ok': True,
        'display': os.environ.get('DISPLAY'),
        'pid': os.getpid(),
        'xdotool': bool(subprocess.run(['which', 'xdotool'], capture_output=True).returncode == 0),
        'apps': [name_of(a) for a in desktop_apps()],
    }


def cmd_apps(args):
    launch_pid = args.get('launchPid')
    apps = []
    for app in desktop_apps():
        desc = app_descriptor(app, launch_pid)
        if launch_pid and not is_descendant(desc['pid'] or 0, launch_pid):
            continue
        apps.append(desc)
    return {'ok': True, 'apps': apps}


def cmd_wait_app(args):
    launch_pid = args.get('launchPid')
    name = args.get('name')
    timeout = min(180.0, max(0.2, float(args.get('timeoutMs') or 20000) / 1000.0))
    started = time.perf_counter()
    last_error = None
    while time.perf_counter() - started < timeout:
        try:
            app = find_app(name=name, pid=launch_pid, name_match='contains' if name else 'exact')
        except Exception as error:  # AT-SPI can throw while an app is starting
            last_error = error
            app = None
        if app is not None:
            desc = app_descriptor(app, launch_pid)
            if name and launch_pid is None and name.lower() not in desc['name'].lower():
                app = None
            if app is not None:
                return {
                    'ok': True,
                    'app': desc,
                    'waitedMs': round((time.perf_counter() - started) * 1000, 1),
                    'windows': windows(desc['pid'] or launch_pid),
                }
        time.sleep(0.05)
    detail = '' if last_error is None else ' (last error: %r)' % last_error
    return {
        'ok': False,
        'code': 'E_NO_APP',
        'error': 'application did not appear in AT-SPI within %dms%s' % (int(timeout * 1000), detail),
        'appsSeen': [name_of(a) for a in desktop_apps()],
    }


def require_app(args):
    launch_pid = args.get('launchPid')
    name = args.get('name')
    app = find_app(name=name, pid=launch_pid, name_match='contains' if name else 'exact')
    if app is None:
        raise DriverError(
            'application is not visible in AT-SPI (pid=%s name=%r)' % (launch_pid, name),
            'E_NO_APP',
        )
    return app


def cmd_tree(args):
    app = require_app(args)
    max_depth = max(1, min(32, int(args.get('maxDepth') or 10)))
    max_nodes = max(1, min(5000, int(args.get('maxNodes') or 400)))
    include_text = args.get('includeText', True)
    nodes = []
    truncated = False
    for path, acc, depth in walk(app, max_depth=max_depth, max_nodes=max_nodes + 1):
        if len(nodes) >= max_nodes:
            truncated = True
            break
        info = node_info(acc, path)
        info['depth'] = depth
        if not include_text:
            info.pop('text', None)
        nodes.append(info)
    return {'ok': True, 'app': app_descriptor(app, args.get('launchPid')), 'nodes': nodes, 'truncated': truncated}


def cmd_find(args):
    app = require_app(args)
    path, acc = resolve_node(app, args)
    info = node_info(acc, path)
    return {'ok': True, 'app': app_descriptor(app, args.get('launchPid')), 'node': info}


def cmd_press(args):
    app = require_app(args)
    path, acc = resolve_node(app, args)
    actions = actions_of(acc)
    if not actions:
        return {
            'ok': False,
            'code': 'E_NO_ACTION',
            'error': 'node has no Action interface',
            'node': node_info(acc, path),
        }
    preferred = args.get('action')
    action = acc.get_action()
    index = None
    if preferred:
        lowered = [a.lower() for a in actions]
        if preferred.lower() in lowered:
            index = lowered.index(preferred.lower())
    if index is None:
        lowered = [a.lower() for a in actions]
        for candidate in ('press', 'click', 'activate', 'toggle', 'check', 'set focus'):
            if candidate in lowered:
                index = lowered.index(candidate)
                break
    if index is None:
        index = 0
    started = time.perf_counter()
    returned = bool(action.do_action(index))
    elapsed = (time.perf_counter() - started) * 1000
    return {
        'ok': True,
        'action': actions[index],
        'actionIndex': index,
        'returned': returned,
        'elapsedMs': round(elapsed, 2),
        'node': node_info(acc, path),
    }


def cmd_set_text(args):
    app = require_app(args)
    path, acc = resolve_node(app, args)
    editable = None
    try:
        editable = acc.get_editable_text()
    except Exception:
        editable = None
    if editable is None:
        return {
            'ok': False,
            'code': 'E_NO_EDITABLE',
            'error': 'node has no EditableText interface',
            'node': node_info(acc, path),
        }
    value = args.get('text')
    started = time.perf_counter()
    returned = bool(editable.set_text_contents(value))
    elapsed = (time.perf_counter() - started) * 1000
    time.sleep(0.02)
    return {
        'ok': True,
        'returned': returned,
        'elapsedMs': round(elapsed, 2),
        'after': text_of(acc),
        'node': node_info(acc, path),
    }


def cmd_get_text(args):
    app = require_app(args)
    path, acc = resolve_node(app, args)
    return {'ok': True, 'text': text_of(acc), 'node': node_info(acc, path)}


def cmd_focus(args):
    app = require_app(args)
    path, acc = resolve_node(app, args)
    via = None
    focused = False
    try:
        component = acc.get_component()
        if component is not None:
            focused = bool(component.grab_focus())
            via = 'component.grab_focus'
    except Exception:
        pass
    if not focused:
        actions = actions_of(acc)
        lowered = [a.lower() for a in actions]
        if 'set focus' in lowered:
            try:
                focused = bool(acc.get_action().do_action(lowered.index('set focus')))
                via = 'action:set focus'
            except Exception:
                pass
    states = states_of(acc)
    return {
        'ok': True,
        'focused': bool(focused) or ('focused' in states),
        'via': via,
        'node': node_info(acc, path),
    }


def stable_key(acc):
    states = [s for s in states_of(acc) if s not in VOLATILE_STATES]
    return [role_of(acc), name_of(acc), text_of(acc), value_of(acc), ','.join(states)]


def snapshot(app, max_nodes):
    nodes = []
    for path, acc, _depth in walk(app, max_depth=24, max_nodes=max_nodes):
        if role_of(acc) == 'application':
            continue
        nodes.append(stable_key(acc))
    return nodes


def cmd_snapshot(args):
    app = require_app(args)
    max_nodes = max(1, min(5000, int(args.get('maxNodes') or 600)))
    nodes = snapshot(app, max_nodes)
    digest = __import__('hashlib').sha256(json.dumps(nodes, ensure_ascii=False).encode()).hexdigest()[:16]
    return {'ok': True, 'digest': digest, 'count': len(nodes), 'nodes': nodes}


def cmd_windows(args):
    return {'ok': True, 'windows': windows(args.get('pid'))}


def cmd_focus_window(args):
    pid = args.get('pid')
    wid = args.get('windowId')
    if not wid:
        found = windows(pid)
        if not found:
            return {'ok': False, 'code': 'E_NO_WINDOW', 'error': 'no X11 window found for the application'}
        info = found[0]
        wid = info['id']
    else:
        info = window_info(wid)
    out, elapsed = xdo('windowfocus', str(wid))
    time.sleep(0.03)
    focused = focus_info()
    return {
        'ok': True,
        'window': info,
        'focused': focused,
        'matchesApp': bool(pid) and focused.get('pid') is not None and is_descendant(focused['pid'], pid),
        'elapsedMs': round(elapsed, 1),
    }


def cmd_focus_info(args):
    pid = args.get('pid')
    info = focus_info()
    info['ok'] = True
    info['matchesApp'] = bool(pid) and info.get('pid') is not None and is_descendant(info['pid'], pid)
    return info


def cmd_click(args):
    x, y = int(args['x']), int(args['y'])
    button = int(args.get('button') or 1)
    count = max(1, int(args.get('count') or 1))
    # `click --repeat N --delay D` inserts extra per-pair latency (observed
    # ~245ms end-to-end for D=120), which lands right on GTK's 250ms
    # double-click threshold. Emit the clicks in one process with an explicit
    # sleep so the gap is exactly what the caller asked for.
    interval = max(1, min(390, int(args.get('intervalMs') or 120))) if count > 1 else 0
    cmd = ['mousemove', '--sync', x, y]
    if count == 1:
        cmd += ['click', button]
    else:
        for index in range(count):
            if index > 0:
                cmd += ['sleep', '%.3f' % (interval / 1000.0)]
            cmd += ['mousedown', button, 'mouseup', button]
    out, elapsed = xdo(*cmd)
    return {
        'ok': True,
        'point': {'x': x, 'y': y},
        'count': count,
        'button': button,
        'intervalMs': interval,
        'elapsedMs': round(elapsed, 1),
    }


def cmd_drag(args):
    x1, y1 = int(args['x1']), int(args['y1'])
    x2, y2 = int(args['x2']), int(args['y2'])
    steps = max(1, min(120, int(args.get('steps') or 12)))
    step_ms = max(1, min(200, int(args.get('stepMs') or 15)))
    button = int(args.get('button') or 1)
    command = ['mousemove', '--sync', x1, y1, 'mousedown', button, 'sleep', '%.3f' % (step_ms / 1000.0)]
    for index in range(1, steps + 1):
        xi = int(round(x1 + (x2 - x1) * index / steps))
        yi = int(round(y1 + (y2 - y1) * index / steps))
        command += ['mousemove', '--sync', xi, yi, 'sleep', '%.3f' % (step_ms / 1000.0)]
    command += ['mouseup', button]
    out, elapsed = xdo(*command, timeout=30)
    loc, _ = xdo('getmouselocation', '--shell')
    final = {}
    for line in loc.splitlines():
        if '=' in line:
            key, val = line.split('=', 1)
            if key in ('X', 'Y'):
                final[key.lower()] = int(val)
    return {
        'ok': True,
        'from': {'x': x1, 'y': y1},
        'to': {'x': x2, 'y': y2},
        'steps': steps,
        'stepMs': step_ms,
        'elapsedMs': round(elapsed, 1),
        'finalPointer': final,
    }


def cmd_scroll(args):
    x, y = int(args['x']), int(args['y'])
    direction = (args.get('direction') or 'down').lower()
    amount = max(1, min(50, int(args.get('amount') or 1)))
    buttons = {'up': 4, 'down': 5, 'left': 6, 'right': 7}
    if direction not in buttons:
        raise DriverError('direction must be up/down/left/right', 'E_BAD_SPEC')
    out, elapsed = xdo('mousemove', '--sync', x, y, 'click', '--repeat', amount, '--delay', 15, buttons[direction])
    return {
        'ok': True,
        'point': {'x': x, 'y': y},
        'direction': direction,
        'amount': amount,
        'button': buttons[direction],
        'angle': -120 * amount if direction == 'down' else (120 * amount if direction == 'up' else 0),
        'elapsedMs': round(elapsed, 1),
    }


def cmd_type(args):
    text = args.get('text')
    if not isinstance(text, str) or text == '':
        raise DriverError('text required', 'E_BAD_SPEC')
    delay = max(0, min(200, int(args.get('delayMs') if args.get('delayMs') is not None else 12)))
    out, elapsed = xdo('type', '--delay', delay, '--clearmodifiers', '--', text, timeout=60)
    return {'ok': True, 'chars': len(text), 'delayMs': delay, 'elapsedMs': round(elapsed, 1)}


def cmd_key(args):
    keys = args.get('keys')
    if not isinstance(keys, str) or keys == '':
        raise DriverError('keys required', 'E_BAD_SPEC')
    out, elapsed = xdo('key', '--clearmodifiers', keys, timeout=30)
    return {'ok': True, 'keys': keys, 'elapsedMs': round(elapsed, 1)}


def cmd_screenshot(args):
    path = args.get('path')
    if not path:
        raise DriverError('path required', 'E_BAD_SPEC')
    display = os.environ.get('DISPLAY') or ':0'
    width = int(args.get('width') or 0)
    height = int(args.get('height') or 0)
    if width <= 1 or height <= 1:
        resolution = subprocess.run(['xdpyinfo'], capture_output=True, text=True)
        match = re.search(r'dimensions:\s+(\d+)x(\d+)', resolution.stdout)
        if match is None:
            raise DriverError('cannot determine display size', 'E_NO_DISPLAY')
        width, height = int(match.group(1)), int(match.group(2))
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    started = time.perf_counter()
    out, elapsed = run([
        'ffmpeg', '-loglevel', 'error', '-f', 'x11grab',
        '-video_size', '%dx%d' % (width, height), '-i', display,
        '-frames:v', '1', '-y', path,
    ], timeout=30)
    if not os.path.exists(path):
        raise DriverError('screenshot was not written: %s' % out, 'E_SCREENSHOT')
    return {
        'ok': True,
        'path': path,
        'bytes': os.path.getsize(path),
        'width': width,
        'height': height,
        'elapsedMs': round((time.perf_counter() - started) * 1000, 1),
    }


def cmd_pointer(args):
    out, _ = xdo('getmouselocation', '--shell')
    point = {}
    for line in out.splitlines():
        if '=' in line:
            key, val = line.split('=', 1)
            if key in ('X', 'Y'):
                point[key.lower()] = int(val)
    return {'ok': True, 'pointer': point}


COMMANDS = {
    'ping': cmd_ping,
    'apps': cmd_apps,
    'wait_app': cmd_wait_app,
    'tree': cmd_tree,
    'find': cmd_find,
    'press': cmd_press,
    'set_text': cmd_set_text,
    'get_text': cmd_get_text,
    'focus': cmd_focus,
    'snapshot': cmd_snapshot,
    'windows': cmd_windows,
    'focus_window': cmd_focus_window,
    'focus_info': cmd_focus_info,
    'click': cmd_click,
    'drag': cmd_drag,
    'scroll': cmd_scroll,
    'type': cmd_type,
    'key': cmd_key,
    'screenshot': cmd_screenshot,
    'pointer': cmd_pointer,
}


def dispatch(request):
    command = request.get('cmd')
    handler = COMMANDS.get(command)
    if handler is None:
        return {'ok': False, 'code': 'E_UNKNOWN_CMD', 'error': 'unknown command %r' % command}
    try:
        result = handler(request)
        result.setdefault('ok', True)
        return result
    except DriverError as error:
        return {'ok': False, 'code': error.code, 'error': str(error)}
    except Exception as error:
        log('command %s failed: %r' % (command, error))
        return {'ok': False, 'code': 'E_DRIVER', 'error': '%s: %s' % (type(error).__name__, error)}


def serve(socket_path, ready_path=None):
    if os.path.exists(socket_path):
        os.unlink(socket_path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    server.listen(16)
    os.chmod(socket_path, 0o600)
    if ready_path:
        try:
            open(ready_path, 'w').write(str(os.getpid()))
        except Exception:
            pass
    log('driver listening on %s' % socket_path)
    while True:
        connection, _ = server.accept()
        try:
            buffer = b''
            while b'\n' not in buffer:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                buffer += chunk
            if b'\n' not in buffer:
                continue
            request = json.loads(buffer.split(b'\n', 1)[0].decode('utf-8'))
            if request.get('cmd') == 'quit':
                connection.sendall(b'{"ok": true, "bye": true}\n')
                connection.close()
                break
            response = dispatch(request)
            response['id'] = request.get('id')
            connection.sendall((json.dumps(response, ensure_ascii=False) + '\n').encode('utf-8'))
        except Exception as error:
            log('request failed: %r' % error)
            try:
                connection.sendall((json.dumps({'ok': False, 'code': 'E_PROTOCOL', 'error': str(error)}) + '\n').encode('utf-8'))
            except Exception:
                pass
        finally:
            try:
                connection.close()
            except Exception:
                pass
    server.close()
    try:
        os.unlink(socket_path)
    except Exception:
        pass


def main():
    global LOG_FILE
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--ready', default=None)
    parser.add_argument('--log', default=None)
    args = parser.parse_args()
    LOG_FILE = args.log
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    enabled = ensure_a11y()
    log('a11y enabled=%s display=%s' % (enabled, os.environ.get('DISPLAY')))
    serve(args.socket, args.ready)


if __name__ == '__main__':
    main()
