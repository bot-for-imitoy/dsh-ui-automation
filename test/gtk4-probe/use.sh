#!/bin/bash
# use.sh — re-attach to the environment started by env.sh (each tool call is a
# fresh shell, so the exported variables have to be reconstructed).
#   . /tmp/gtk4-probe/use.sh 151
NUM="${1:-151}"
ROOT="/tmp/gtk4-probe/run-$NUM"
[ -f "$ROOT/bus.info" ] || { echo "no env for :$NUM (run env.sh $NUM)" >&2; return 1 2>/dev/null || exit 1; }
export DBUS_SESSION_BUS_ADDRESS="$(sed -n 1p "$ROOT/bus.info")"
export AT_SPI_BUS_ADDRESS="$(sed -n 1p "$ROOT/a11y.info")"
export XDG_RUNTIME_DIR="$ROOT/runtime"
export DISPLAY=":$NUM"
export NO_AT_BRIDGE=0
export GTK_A11Y=atspi
export GDK_BACKEND=x11
export GTK4_PROBE_ROOT="$ROOT"
