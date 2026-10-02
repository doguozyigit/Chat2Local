#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Chat2Local.app"
RELAUNCH_LOG="$ROOT/.tmp/relaunch.log"

"$ROOT/scripts/sign-local-dev-app.sh" "$APP"

# Never terminate Chat2Local from a Chat2Local scoped shell. Any detached child
# inherits that sandbox, and macOS LaunchServices can reject the subsequent
# open request (for example with error -54), leaving Chat2Local closed.
if [[ -n "${LOCAL_DEV_PROJECT_ROOT:-}" ]]; then
  echo "Chat2Local was signed. Relaunch skipped inside the Chat2Local shell; reopen it manually or run this script from Terminal."
  exit 0
fi

old_pids="$(pgrep -x LocalDevMenuBar 2>/dev/null || true)"

# If Chat2Local is not running, simply launch it and fail without harming
# anything if LaunchServices cannot open the app.
if [[ -z "$old_pids" ]]; then
  /usr/bin/open -n "$APP"
  echo "Chat2Local was signed and launched."
  exit 0
fi

mkdir -p "$ROOT/.tmp"
relauncher="$ROOT/.tmp/relaunch-local-dev.sh"

cat > "$relauncher" <<'SCRIPT'
#!/bin/bash
set -u
app="$1"
shift

# Wait until only the exact processes that existed before the update have
# exited. A replacement process is never matched or killed by this relauncher.
for pid in "$@"; do
  for _ in {1..80}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
done

sleep 0.5
exec /usr/bin/open -n "$app"
SCRIPT

chmod +x "$relauncher"

# Prepare and verify the detached relauncher before terminating anything.
nohup "$relauncher" "$APP" $old_pids >"$RELAUNCH_LOG" 2>&1 </dev/null &
relauncher_pid=$!
sleep 0.2

if ! kill -0 "$relauncher_pid" 2>/dev/null; then
  echo "Could not prepare the Chat2Local relauncher; leaving the running app untouched." >&2
  exit 1
fi

# Terminate only the processes captured before the relauncher was started.
for pid in $old_pids; do
  kill "$pid" 2>/dev/null || true
done

replacement_running() {
  local candidate old matched
  for candidate in $(pgrep -x LocalDevMenuBar 2>/dev/null || true); do
    matched=false
    for old in $old_pids; do
      if [[ "$candidate" == "$old" ]]; then
        matched=true
        break
      fi
    done
    if [[ "$matched" == false ]]; then
      return 0
    fi
  done
  return 1
}

# LaunchServices can silently ignore a detached open request just after the old
# bundle exits. Confirm a replacement process appeared and retry from this
# unscoped caller once the detached relauncher has finished its bounded wait.
for _ in {1..130}; do
  if replacement_running; then
    echo "Chat2Local was signed and relaunched."
    exit 0
  fi
  sleep 0.1
done

/usr/bin/open -n "$APP"
for _ in {1..50}; do
  if replacement_running; then
    echo "Chat2Local was signed and relaunched after a retry."
    exit 0
  fi
  sleep 0.1
done

echo "Chat2Local was signed, but no replacement app process started." >&2
exit 1
