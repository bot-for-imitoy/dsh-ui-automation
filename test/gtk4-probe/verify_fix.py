#!/usr/bin/env python3
"""verify_fix.py — prove the fallback this report recommends actually works.

GTK4 always answers GetExtents(SCREEN) with (0,0,w,h). GetExtents(WINDOW) is
correct, so the screen rectangle is::

    screen = (toplevel X11 origin) + (WINDOW extents)

This script derives that for every target of one app, clicks the centre of the
requested widget with XTEST (the same primitive the plugin uses), and reads the
fixture's own status label back through AT-SPI to prove the click landed.

  python3 verify_fix.py --name panel_gtk4 --click 点击 Click [--display :151]
"""
import argparse
import json
import os
import re
import subprocess
import sys

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi  # noqa: E402


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=20)


def window_origin(display, pid, width, height):
    """X11 origin of the app's toplevel surface that matches the frame size."""
    found = []
    ids = sh('xdotool', 'search', '--pid', str(pid)).stdout.split()
    for wid in ids:
        out = sh('xwininfo', '-id', wid).stdout
        size = re.search(r'Width:\s+(\d+).*?Height:\s+(\d+)', out, re.S)
        pos = re.search(r'Absolute upper-left X:\s+(-?\d+).*?Absolute upper-left Y:\s+(-?\d+)', out, re.S)
        if not (size and pos):
            continue
        w, h = int(size.group(1)), int(size.group(2))
        if w == width and h == height:
            found.append((int(pos.group(1)), int(pos.group(2)), wid))
    if not found:
        return None
    return found[0]


def extents(acc, coord):
    try:
        e = acc.get_component().get_extents(coord)
        return (int(e.x), int(e.y), int(e.width), int(e.height))
    except Exception:
        return None


def find_app(name):
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is not None and (name.lower() in (app.get_name() or '').lower()):
            return app
    return None


def walk(acc, depth=0, path=''):
    yield acc, depth, path
    if depth >= 12:
        return
    for i in range(acc.get_child_count()):
        child = acc.get_child_at_index(i)
        if child is None:
            continue
        yield from walk(child, depth + 1, '%s/%d' % (path, i))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True)
    ap.add_argument('--click', default='')
    ap.add_argument('--display', default=os.environ.get('DISPLAY', ':151'))
    args = ap.parse_args()

    app = find_app(args.name)
    if app is None:
        sys.exit('app %s not on the AT-SPI bus' % args.name)
    pid = int(app.get_process_id())

    frame = None
    for acc, depth, _ in walk(app):
        if depth != 1:
            continue
        r = extents(acc, Atspi.CoordType.WINDOW)
        if r and r[2] >= 40 and r[3] >= 40 and (frame is None or r[2] * r[3] > frame[2] * frame[3]):
            frame = r
    origin = window_origin(args.display, pid, frame[2], frame[3])
    print('app=%s pid=%d frame(WINDOW)=%s' % (args.name, pid, frame))
    print('x11 toplevel origin = %s' % (origin,))
    if origin is None:
        sys.exit('could not match an X11 window to the frame size')

    rows = []
    for acc, depth, path in walk(app):
        if depth < 2:
            continue
        name = (acc.get_name() or '').strip()
        win = extents(acc, Atspi.CoordType.WINDOW)
        scr = extents(acc, Atspi.CoordType.SCREEN)
        if not win or win[2] < 4 or win[3] < 4:
            continue
        derived = (origin[0] + win[0], origin[1] + win[1], win[2], win[3])
        rows.append({'name': name, 'role': acc.get_role_name(), 'window': win,
                     'screen_reported': scr, 'screen_derived': derived})

    print('\n%-22s %-14s %-22s %-22s %s' % ('name', 'role', 'reported SCREEN', 'derived SCREEN', 'WINDOW'))
    for row in rows:
        print('%-22s %-14s %-22s %-22s %s' % (
            row['name'][:22], row['role'][:14], row['screen_reported'],
            row['screen_derived'], row['window']))
    print('\ndistinct derived positions: %d' % len({(r['screen_derived'][0], r['screen_derived'][1]) for r in rows}))
    print('distinct reported positions: %d' % len({(r['screen_reported'][0], r['screen_reported'][1])
                                                   for r in rows if r['screen_reported']}))

    if args.click:
        target = next((r for r in rows if r['name'] == args.click), None)
        if target is None:
            sys.exit('no target named %r' % args.click)
        x, y, w, h = target['screen_derived']
        cx, cy = x + w // 2, y + h // 2
        before = status(app)
        subprocess.run(['xdotool', 'mousemove', '--sync', str(cx), str(cy), 'click', '1'],
                       env={**os.environ, 'DISPLAY': args.display}, check=True, timeout=20)
        import time
        time.sleep(0.6)
        after = status(app)
        print('\nclick at derived centre (%d,%d)' % (cx, cy))
        print('  status before: %s' % before)
        print('  status after : %s' % after)
        print('  RESULT: %s' % ('CLICK LANDED' if before != after else 'NO CHANGE'))


def status(app):
    for acc, _depth, _path in walk(app):
        name = (acc.get_name() or '').strip()
        if 'clicks=' in name:
            return name
        if acc.get_role_name() in ('label', 'text'):
            try:
                txt = acc.get_text().get_text(0, -1) or ''
            except Exception:
                continue
            if 'clicks=' in txt:
                return txt.strip()
    return '<no status label>'


if __name__ == '__main__':
    main()
