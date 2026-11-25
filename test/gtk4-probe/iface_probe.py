#!/usr/bin/env python3
"""iface_probe.py — exercise every AT-SPI interface on one node that can carry
geometry, to see which of them reports usable screen coordinates for GTK4.

  python3 iface_probe.py --dest :1.1 --path /org/gtk/.../5b53... --label input
"""
import argparse
import os
import sys

import dbus
import dbus.bus

A = 'org.a11y.atspi.'
COORDS = {0: 'SCREEN', 1: 'WINDOW', 2: 'PARENT'}


def connect():
    return dbus.bus.BusConnection(os.environ['AT_SPI_BUS_ADDRESS'])


def safe(label, fn):
    try:
        print('  %-34s %s' % (label + ':', fn()))
    except dbus.DBusException as error:
        print('  %-34s <%s>' % (label + ':', error.get_dbus_name()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dest', required=True)
    ap.add_argument('--path', required=True)
    ap.add_argument('--label', default='')
    ap.add_argument('--point', default='')
    args = ap.parse_args()
    bus = connect()
    obj = bus.get_object(args.dest, args.path)
    print('== %s  %s' % (args.label, args.path))

    comp = dbus.Interface(obj, A + 'Component')
    for code, name in COORDS.items():
        safe('Component.GetExtents(%s)' % name,
             lambda code=code: tuple(int(v) for v in comp.GetExtents(dbus.UInt32(code))))
    for code, name in COORDS.items():
        safe('Component.GetPosition(%s)' % name,
             lambda code=code: tuple(int(v) for v in comp.GetPosition(dbus.UInt32(code))))
    safe('Component.GetSize', lambda: tuple(int(v) for v in comp.GetSize()))
    if args.point:
        x, y = [int(v) for v in args.point.split(',')]
        for code, name in COORDS.items():
            safe('Component.Contains(%d,%d,%s)' % (x, y, name),
                 lambda code=code: bool(comp.Contains(x, y, dbus.UInt32(code))))
            safe('Component.GetAccessibleAtPoint(%d,%d,%s)' % (x, y, name),
                 lambda code=code: [str(v) for v in
                                    comp.GetAccessibleAtPoint(x, y, dbus.UInt32(code))])

    text = dbus.Interface(obj, A + 'Text')
    for code, name in COORDS.items():
        safe('Text.GetCharacterExtents(0,%s)' % name,
             lambda code=code: tuple(int(v) for v in
                                     text.GetCharacterExtents(dbus.Int32(0), dbus.UInt32(code))))
    for code, name in COORDS.items():
        safe('Text.GetRangeExtents(0,1,%s)' % name,
             lambda code=code: tuple(int(v) for v in
                                     text.GetRangeExtents(dbus.Int32(0), dbus.Int32(1),
                                                          dbus.UInt32(code))))
    safe('Text.GetCharacterCount', lambda: int(text.GetCharacterCount()))

    for name in ('Hypertext', 'Value', 'Selection', 'Action', 'Application'):
        iface = dbus.Interface(obj, A + name)
        try:
            xml = dbus.Interface(obj, 'org.freedesktop.DBus.Introspectable').Introspect()
            present = (A + name) in str(xml)
        except dbus.DBusException:
            present = False
        print('  %-34s %s' % (name + ' present:', present))


if __name__ == '__main__':
    main()
