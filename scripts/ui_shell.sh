#!/usr/bin/env bash
# ui_shell.sh — one isolated, headless, AT-SPI-drivable X session per launch.
#
# The outer half only sets up the private session bus and re-executes itself
# inside it:
#   private D-Bus session bus   (dbus-run-session)   -> never touches the user bus
#   private XDG_RUNTIME_DIR                          -> no socket collisions
#   private Xvfb display (:N)                        -> one app, no occlusion
#   org.a11y.Status.IsEnabled = true                  -> set by the driver before
#                                                       the app starts (Qt needs it)
#
# The inner half starts Xvfb, starts the AT-SPI driver, launches the requested
# command, and tears everything down when that command exits.
#
# Usage (from lib/shell.js):
#   ui_shell.sh --display 130 --width 1024 --height 768 \
#     --run-dir DIR --log-dir DIR --socket PATH --driver PATH --cwd DIR \
#     -- command args...
set -uo pipefail

NUM=""
WIDTH=1024
HEIGHT=768
RUN_DIR=""
LOG_DIR=""
SOCKET=""
DRIVER=""
CWD="."
MODE="outer"
CMD=()

while [ $# -gt 0 ]; do
    case "$1" in
        --outer|--inner) MODE="${1#--}"; shift ;;
        --display) NUM="$2"; shift 2 ;;
        --width) WIDTH="$2"; shift 2 ;;
        --height) HEIGHT="$2"; shift 2 ;;
        --run-dir) RUN_DIR="$2"; shift 2 ;;
        --log-dir) LOG_DIR="$2"; shift 2 ;;
        --socket) SOCKET="$2"; shift 2 ;;
        --driver) DRIVER="$2"; shift 2 ;;
        --cwd) CWD="$2"; shift 2 ;;
        --) shift; CMD=("$@"); break ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ -z "$NUM" ] || [ -z "$RUN_DIR" ] || [ -z "$SOCKET" ] || [ ${#CMD[@]} -eq 0 ]; then
    echo "ui_shell.sh: missing required arguments" >&2
    exit 2
fi

mkdir -p "$RUN_DIR" "$LOG_DIR"
chmod 700 "$RUN_DIR"

# DISPLAY and XDG_RUNTIME_DIR must exist before dbus-run-session starts: D-Bus
# activated services inherit the bus daemon's environment, not the payload's.
export XDG_RUNTIME_DIR="$RUN_DIR"
export DISPLAY=":$NUM"

if [ "$MODE" = "outer" ]; then
    exec dbus-run-session -- bash "$0" --inner \
        --display "$NUM" --width "$WIDTH" --height "$HEIGHT" \
        --run-dir "$RUN_DIR" --log-dir "$LOG_DIR" --socket "$SOCKET" \
        --driver "$DRIVER" --cwd "$CWD" -- "${CMD[@]}"
fi

# ---------------------------------------------------------------- inner half
export DISPLAY=":$NUM"
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export NO_AT_BRIDGE=0
export QT_QUICK_BACKEND="${QT_QUICK_BACKEND:-software}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"

echo "shell: display=:$NUM size=${WIDTH}x${HEIGHT} pid=$$ bus=$DBUS_SESSION_BUS_ADDRESS" >>"$LOG_DIR/wrapper.log"

Xvfb ":$NUM" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp >"$LOG_DIR/xvfb.log" 2>&1 &
XPID=$!
APP_PID=""
DRIVER_PID=""

# D-Bus activated daemons (gvfsd, gvfsd-fuse, at-spi registryd, dconf) are
# children of the private bus, not of this shell. They keep the runtime dir
# busy — a surviving gvfsd-fuse leaves a fuse mount behind and makes the
# directory undeletable — so sweep every process that inherited this instance's
# unique XDG_RUNTIME_DIR.
sweep_by_runtime_dir() {
    local signal="$1" entry pid
    for entry in /proc/[0-9]*; do
        pid="${entry#/proc/}"
        [ "$pid" = "$$" ] && continue
        [ -r "$entry/environ" ] || continue
        if tr '\0' '\n' <"$entry/environ" 2>/dev/null | grep -qxF "XDG_RUNTIME_DIR=$RUN_DIR"; then
            kill -"$signal" "$pid" 2>/dev/null || true
        fi
    done
}

cleanup() {
    # SIGTERM first, but never wait forever: the driver can be parked inside a
    # libatspi D-Bus call (its signal handler only runs between C calls), which
    # used to leave the whole shell — and its Xvfb — alive after the app died.
    if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
        kill -TERM "$APP_PID" 2>/dev/null || true
    fi
    if [ -n "$DRIVER_PID" ]; then
        kill -TERM "$DRIVER_PID" 2>/dev/null || true
    fi
    if kill -0 "$XPID" 2>/dev/null; then
        kill -TERM "$XPID" 2>/dev/null || true
    fi
    sweep_by_runtime_dir TERM
    for _ in $(seq 1 40); do
        if [ -z "$DRIVER_PID" ] || ! kill -0 "$DRIVER_PID" 2>/dev/null; then
            break
        fi
        sleep 0.05
    done
    kill -KILL "$APP_PID" "$DRIVER_PID" "$XPID" 2>/dev/null || true
    sweep_by_runtime_dir KILL
    wait 2>/dev/null || true
}

trap 'cleanup; exit 0' TERM INT HUP
trap cleanup EXIT

for _ in $(seq 1 200); do
    xdpyinfo >/dev/null 2>&1 && break
    sleep 0.02
done
if ! xdpyinfo >/dev/null 2>&1; then
    echo "shell: Xvfb failed to start" >&2
    cat "$LOG_DIR/xvfb.log" >&2 || true
    exit 3
fi
echo "shell: Xvfb ready pid=$XPID" >>"$LOG_DIR/wrapper.log"

python3 -u "$DRIVER" --socket "$SOCKET" --ready "$RUN_DIR/driver.pid" \
    --log "$LOG_DIR/driver.log" >"$LOG_DIR/driver.out" 2>&1 &
DRIVER_PID=$!

for _ in $(seq 1 400); do
    [ -S "$SOCKET" ] && break
    sleep 0.02
done
if [ ! -S "$SOCKET" ]; then
    echo "shell: AT-SPI driver failed to start" >&2
    tail -n 40 "$LOG_DIR/driver.out" >&2 || true
    exit 4
fi
echo "shell: driver ready pid=$DRIVER_PID" >>"$LOG_DIR/wrapper.log"

cd "$CWD" || exit 5

"${CMD[@]}" >>"$LOG_DIR/app.log" 2>&1 &
APP_PID=$!
echo "$APP_PID" >"$RUN_DIR/app.pid"
echo "shell: app started pid=$APP_PID cmd=${CMD[*]}" >>"$LOG_DIR/wrapper.log"

wait "$APP_PID"
RC=$?
echo "shell: app exited rc=$RC" >>"$LOG_DIR/wrapper.log"
exit 0
