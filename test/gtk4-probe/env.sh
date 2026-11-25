#!/bin/bash
# env.sh — throw-away X11 + private session bus + private a11y bus for GTK4 probes.
#
#   source /tmp/gtk4-probe/env.sh 151     # start :151, export DISPLAY/buses
#   /tmp/gtk4-probe/env.sh stop 151       # tear it down
#
# A *private* a11y bus is used on purpose: the real desktop session shares
# ~/.cache/at-spi/bus, and probing there would mix our fixtures with the live
# desktop apps (and race the real registry daemon). GTK4 and libatspi both
# honor AT_SPI_BUS_ADDRESS.
set -u

if [ "${1:-}" = "stop" ]; then
  NUM="${2:-151}"
else
  NUM="${1:-151}"
fi
ROOT="/tmp/gtk4-probe/run-$NUM"

if [ "${1:-}" = "stop" ]; then
  pkill -f "Xvfb :$NUM " 2>/dev/null
  for f in "$ROOT/bus.info" "$ROOT/a11y.info"; do
    [ -f "$f" ] && kill "$(sed -n 2p "$f")" 2>/dev/null
  done
  exit 0
fi

rm -rf "$ROOT"
mkdir -p "$ROOT/runtime"
chmod 700 "$ROOT/runtime"

Xvfb ":$NUM" -screen 0 1024x768x24 -nolisten tcp >"$ROOT/xvfb.log" 2>&1 &
for _ in $(seq 1 100); do
  xdpyinfo -display ":$NUM" >/dev/null 2>&1 && break
  sleep 0.05
done

dbus-daemon --session --fork --print-address=1 --print-pid=1 --nopidfile \
  --address="unix:path=$ROOT/bus" >"$ROOT/bus.info"
dbus-daemon --config-file=/usr/share/defaults/at-spi2/accessibility.conf \
  --fork --print-address=1 --print-pid=1 \
  --address="unix:path=$ROOT/a11y-bus" >"$ROOT/a11y.info"

export DBUS_SESSION_BUS_ADDRESS="$(sed -n 1p "$ROOT/bus.info")"
export AT_SPI_BUS_ADDRESS="$(sed -n 1p "$ROOT/a11y.info")"
export XDG_RUNTIME_DIR="$ROOT/runtime"
export DISPLAY=":$NUM"
export NO_AT_BRIDGE=0
export GTK_A11Y=atspi
export GDK_BACKEND=x11
# The private a11y bus needs its registry; D-Bus activation of
# org.a11y.atspi.Registry is unreliable here, so start it directly.
/usr/lib/at-spi2-registryd --use-gnome-session >"$ROOT/registryd.log" 2>&1 &
export GTK4_PROBE_ROOT="$ROOT"
echo "DISPLAY=$DISPLAY"
echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"
echo "AT_SPI_BUS_ADDRESS=$AT_SPI_BUS_ADDRESS"
