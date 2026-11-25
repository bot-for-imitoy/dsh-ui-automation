#!/usr/bin/env python3
"""dump.py — walk the AT-SPI tree on the probe's private a11y bus and print,
for every accessible, the geometry the various APIs report.

Raw D-Bus only (no libatspi) so pyatspi/libatspi behaviour cannot mask what the
application itself sends. `--gi` selects the libatspi/gi path the plugin uses.

  python3 dump.py                 # raw: role/name/interfaces + all geometry
  python3 dump.py --gi            # gi.repository.Atspi, like numbering.py
  python3 dump.py --cache         # raw + org.a11y.atspi.Cache.GetItems rects
  python3 dump.py --json out.json
"""
import argparse
import json
import os
import sys

import dbus
import dbus.bus

ROOT_PATH = '/org/a11y/atspi/accessible/root'
REGISTRY = 'org.a11y.atspi.Registry'
IFACE = 'org.a11y.atspi.Accessible'
COMP = 'org.a11y.atspi.Component'
COORD = {'SCREEN': 0, 'WINDOW': 1, 'PARENT': 2}
COMP_METHODS = ['GetExtents', 'GetPosition', 'GetSize', 'GetLayer', 'GetMDIZOrder']


def conn():
    addr = os.environ.get('AT_SPI_BUS_ADDRESS')
    if not addr:
        sys.exit('AT_SPI_BUS_ADDRESS is not set (source env.sh first)')
    return dbus.bus.BusConnection(addr)


def props(bus, dest, path):
    p = dbus.Interface(bus.get_object(dest, path), 'org.freedesktop.DBus.Properties')
    out = {}
    for key in ('Name', 'Role', 'Description'):
        try:
            out[key] = str(p.Get(IFACE, key))
        except dbus.DBusException as error:
            out[key] = '<%s>' % error.get_dbus_name()
    try:
        out['Interfaces'] = [str(x) for x in bus.get_object(dest, path).GetAll(IFACE).keys()]
    except dbus.DBusException:
        pass
    return out


def introspect_ifaces(bus, dest, path):
    try:
        xml = dbus.Interface(bus.get_object(dest, path),
                             'org.freedesktop.DBus.Introspectable').Introspect()
    except dbus.DBusException as error:
        return ['<%s>' % error.get_dbus_name()]
    names = []
    for line in str(xml).splitlines():
        line = line.strip()
        if line.startswith('<interface name='):
            names.append(line.split('"')[1])
    return names


def comp_probe(bus, dest, path, methods=COMP_METHODS):
    """Return {method: value} for the Component interface, or an error marker."""
    out = {}
    obj = bus.get_object(dest, path)
    iface = dbus.Interface(obj, COMP)
    for method in methods:
        try:
            if method in ('GetExtents', 'GetPosition'):
                vals = []
                for label, code in COORD.items():
                    try:
                        r = iface.GetExtents(dbus.UInt32(code))
                        vals.append('%s=(%d,%d,%d,%d)' % (label, r[0], r[1], r[2], r[3]))
                    except dbus.DBusException as error:
                        vals.append('%s=<%s>' % (label, error.get_dbus_name()))
                out[method] = ' '.join(vals)
            elif method == 'GetSize':
                r = iface.GetSize()
                out[method] = 'w=%d h=%d' % (r[0], r[1])
            else:
                out[method] = str(getattr(iface, method)())
        except dbus.DBusException as error:
            out[method] = '<%s>' % error.get_dbus_name()
    return out


def children(bus, dest, path):
    try:
        obj = bus.get_object(dest, path)
        result = dbus.Interface(obj, IFACE).GetChildren()
        return [(str(pair[0]), str(pair[1])) for pair in result]
    except dbus.DBusException:
        return []


def cache_items(bus, dest, paths):
    """org.a11y.atspi.Cache.GetItems on the app's cache object."""
    result = {}
    if not paths:
        return result
    try:
        obj = bus.get_object(dest, '/org/a11y/atspi/cache')
        items = dbus.Interface(obj, 'org.a11y.atspi.Cache').GetItems(
            dbus.Array([dbus.ObjectPath(p) for p in paths], signature='o'))
    except dbus.DBusException as error:
        return {'_error': error.get_dbus_name()}
    for item in items:
        fields = dict(zip(('path', 'ref', 'interfaces', 'name', 'role', 'description',
                           'states', 'children', 'text', 'attrs'),
                          [x for x in item]))
        result[fields['path']] = fields
    return result


def walk_raw(bus, app_name, dest, path, depth, max_depth, out, with_cache, cache):
    node = {'path': path, 'depth': depth}
    node.update(props(bus, dest, path))
    node['ifaces'] = introspect_ifaces(bus, dest, path)
    node['component'] = comp_probe(bus, dest, path)
    if with_cache and path in cache:
        item = cache[path]
        node['cache'] = {
            'role': item.get('role'),
            'states': sorted(item.get('states') or []),
            'attrs': [(str(a[0]), str(a[1])) for a in (item.get('attrs') or [])],
        }
    out.append(node)
    if depth >= max_depth:
        return
    for _, child in children(bus, dest, path):
        walk_raw(bus, app_name, dest, child, depth + 1, max_depth, out, with_cache, cache)


def run_raw(args):
    bus = conn()
    root_obj = bus.get_object(REGISTRY, ROOT_PATH)
    apps = [(str(p[0]), str(p[1])) for p in
            dbus.Interface(root_obj, IFACE).GetChildren()]
    apps = [a for a in apps if a[0].startswith(':')]
    report = {'a11y_bus': os.environ['AT_SPI_BUS_ADDRESS'], 'apps': []}
    for app_name, app_path in apps:
        nodes = []
        cache = {}
        if args.cache:
            # prime the cache with a full walk first, then re-read rects from it
            probe = []
            walk_raw(bus, app_name, app_name, app_path, 0, args.depth, probe, False, {})
            cache = cache_items(bus, app_name, [n['path'] for n in probe])
        walk_raw(bus, app_name, app_name, app_path, 0, args.depth, nodes, args.cache, cache)
        report['apps'].append({'bus_name': app_name, 'path': app_path, 'nodes': nodes})
    return report


def run_gi(args):
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi

    def describe(acc, depth, out):
        rect = {}
        for label, code in (('SCREEN', Atspi.CoordType.SCREEN),
                            ('WINDOW', Atspi.CoordType.WINDOW),
                            ('PARENT', Atspi.CoordType.PARENT)):
            try:
                e = acc.get_component().get_extents(code)
                rect['extents_' + label] = [int(e.x), int(e.y), int(e.width), int(e.height)]
            except Exception as error:
                rect['extents_' + label] = 'ERR:%s' % error
            try:
                p = acc.get_component().get_position(code)
                rect['pos_' + label] = [int(p.x), int(p.y)]
            except Exception as error:
                rect['pos_' + label] = 'ERR:%s' % error
        try:
            s = acc.get_component().get_size()
            rect['size'] = [int(s.x), int(s.y)]
        except Exception as error:
            rect['size'] = 'ERR:%s' % error
        try:
            rect['roles'] = [acc.get_role_name(), acc.get_name()]
        except Exception:
            pass
        entry = {'depth': depth, 'name': acc.get_name(), 'role': acc.get_role_name()}
        entry.update(rect)
        out.append(entry)
        if depth >= args.depth:
            return
        for i in range(acc.get_child_count()):
            child = acc.get_child_at_index(i)
            if child is not None:
                describe(child, depth + 1, out)

    report = {'mode': 'gi', 'apps': []}
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        nodes = []
        describe(app, 0, nodes)
        report['apps'].append({'app': app.get_name(), 'nodes': nodes})
    return report


def summarise(report, mode):
    lines = []
    for app in report['apps']:
        label = app.get('bus_name') or app.get('app')
        nodes = app['nodes']
        lines.append('')
        lines.append('== %s  (%d nodes)' % (label, len(nodes)))
        if mode == 'gi':
            for n in nodes:
                lines.append('%s%-18s %-14s %s' % (
                    '  ' * n['depth'], n['role'][:14], str(n['name'])[:22],
                    json.dumps({k: v for k, v in n.items()
                                if k not in ('depth', 'name', 'role', 'roles')},
                               ensure_ascii=False)))
            continue
        for n in nodes:
            lines.append('%s%s  role=%s name=%r' % (
                '  ' * n['depth'], n['path'].rsplit('/', 1)[-1], n.get('Role'),
                n.get('Name')))
            lines.append('%s   ifaces: %s' % ('  ' * n['depth'],
                                              ', '.join(i.replace('org.a11y.atspi.', '')
                                                        for i in n.get('ifaces', []))))
            for key, value in n['component'].items():
                lines.append('%s   %s: %s' % ('  ' * n['depth'], key, value))
            if 'cache' in n:
                lines.append('%s   cache: role=%s attrs=%s' % (
                    '  ' * n['depth'], n['cache']['role'],
                    [a for a in n['cache']['attrs'] if 'rect' in a[0] or 'pos' in a[0]
                     or 'size' in a[0]] or n['cache']['attrs'][:6]))
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gi', action='store_true')
    ap.add_argument('--cache', action='store_true')
    ap.add_argument('--depth', type=int, default=6)
    ap.add_argument('--json')
    args = ap.parse_args()
    mode = 'gi' if args.gi else 'raw'
    report = run_gi(args) if args.gi else run_raw(args)
    report['mode'] = mode
    print(summarise(report, mode))
    if args.json:
        with open(args.json, 'w') as handle:
            json.dump(report, handle, ensure_ascii=False, indent=1)
        print('\n[wrote %s]' % args.json)


if __name__ == '__main__':
    main()
