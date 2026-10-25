#!/bin/bash
# Pre-release smoke test for a packaged Chat2Local.app.
#
# Covers the failure modes that made previous builds look fine but ship dead:
#   A. the bundled Node.js starts on its own
#   B. local-devd starts in an isolated directory and answers GET /health with 200
#   C. every dynamic dependency resolves from Apple system paths or the bundle
#   D. the bundle and its nested binaries carry valid signatures
#   E. previously fixed tunnel regressions still hold
#
# Any failure exits non-zero so packaging and deployment stop here.
#
# Usage: scripts/smoke-test-macos-app.sh [path/to/Chat2Local.app]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/dist/Chat2Local.app}"
NODE="$APP/Contents/Resources/node"
DAEMON="$APP/Contents/Resources/local-devd.mjs"
PRODUCTION_PORT=43127
# Host Node.js for repo tooling; the bundled runtime is what the app uses.
HOST_NODE="$(command -v node 2>/dev/null || true)"
[[ -x "$HOST_NODE" ]] || HOST_NODE="$NODE"

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf ' FAIL  %s\n' "$1"; failures=$((failures + 1)); }
info() { printf ' info  %s\n' "$1"; }

cleanup_paths=()
daemon_pid=""
cleanup() {
  if [[ -n "$daemon_pid" ]] && kill -0 "$daemon_pid" 2>/dev/null; then
    kill -TERM "$daemon_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$daemon_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$daemon_pid" 2>/dev/null || true
  fi
  for path in "${cleanup_paths[@]:-}"; do
    [[ -n "$path" && -d "$path" ]] && rm -rf "$path"
  done
}
trap cleanup EXIT

echo "Smoke testing $APP"
echo

if [[ ! -d "$APP" ]]; then
  echo "App bundle not found: $APP" >&2
  exit 1
fi

# --- A. Bundled Node.js runs on its own ------------------------------------
echo "Test A: bundled Node.js starts independently"
if [[ ! -x "$NODE" ]]; then
  fail "bundled Node.js missing or not executable at $NODE"
else
  node_output="$(env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="${HOME:-/tmp}" "$NODE" --version 2>&1)"
  node_status=$?
  if [[ $node_status -eq 0 && "$node_output" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    pass "node --version printed $node_output (exit 0)"
  else
    fail "node --version failed (exit $node_status): $node_output"
  fi
  # Prove the runtime does not need the builder's Homebrew tree.
  deps_output="$(otool -L "$NODE" 2>&1)"
  if printf '%s' "$deps_output" | grep -Eq '/opt/homebrew|/usr/local/(opt|Cellar)|/Users/'; then
    fail "bundled Node.js still links against a developer-only path:"
    printf '%s\n' "$deps_output" | grep -E '/opt/homebrew|/usr/local/(opt|Cellar)|/Users/' | sed 's/^/         /'
  else
    pass "node has no Homebrew or developer-directory dependencies"
  fi
fi
echo

# --- B. local-devd answers /health in an isolated environment --------------
echo "Test B: local-devd starts in an isolated directory"
if [[ ! -f "$DAEMON" ]]; then
  fail "bundled daemon missing at $DAEMON"
else
  test_port="$("$NODE" -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => process.stdout.write(String(port)));
    });
  ' 2>/dev/null)"

  if [[ -z "$test_port" ]]; then
    fail "could not allocate a free test port"
  elif [[ "$test_port" == "$PRODUCTION_PORT" ]]; then
    fail "test port collided with the production port $PRODUCTION_PORT; refusing to run"
  else
    sandbox="$(mktemp -d "${TMPDIR:-/tmp}/chat2local-smoke.XXXXXX")"
    cleanup_paths+=("$sandbox")
    mkdir -p "$sandbox/data" "$sandbox/home" "$sandbox/workspace"
    info "isolated data dir: $sandbox/data"
    info "test port: $test_port (production $PRODUCTION_PORT untouched)"

    env -i \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      HOME="$sandbox/home" \
      TMPDIR="$sandbox" \
      LOCAL_DEV_PORT="$test_port" \
      LOCAL_DEV_DATA_DIR="$sandbox/data" \
      LOCAL_DEV_CHAT_FOLDERS_DATABASE="$sandbox/data/chat-folders.sqlite" \
      LOCAL_DEV_TUNNEL_CLIENT="$sandbox/absent-tunnel-client" \
      "$NODE" "$DAEMON" >"$sandbox/daemon.log" 2>&1 &
    daemon_pid=$!

    health_status=""
    for _ in $(seq 1 150); do
      if ! kill -0 "$daemon_pid" 2>/dev/null; then break; fi
      health_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
        --max-time 2 "http://127.0.0.1:$test_port/health" 2>/dev/null)"
      [[ "$health_status" == "200" ]] && break
      sleep 0.1
    done

    if [[ "$health_status" == "200" ]]; then
      pass "GET /health returned HTTP 200"
      health_body="$(curl --silent --max-time 2 "http://127.0.0.1:$test_port/health" 2>/dev/null)"
      if printf '%s' "$health_body" | grep -q '"ok":true'; then
        pass "health payload reports ok:true"
      else
        fail "unexpected health payload: $health_body"
      fi
    else
      fail "GET /health did not return 200 (last status: ${health_status:-none})"
      if [[ -s "$sandbox/daemon.log" ]]; then
        echo "         daemon output:"
        sed 's/^/         /' "$sandbox/daemon.log" | head -20
      fi
    fi

    if kill -0 "$daemon_pid" 2>/dev/null; then
      pass "local-devd is still running after the health check"
      kill -TERM "$daemon_pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$daemon_pid" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 "$daemon_pid" 2>/dev/null; then
        fail "local-devd ignored SIGTERM"
      else
        pass "local-devd exited cleanly on SIGTERM"
      fi
      daemon_pid=""
    else
      fail "local-devd exited before the health check completed"
      daemon_pid=""
    fi

    leftover="$("$NODE" -e '
      const net = require("node:net");
      const server = net.createServer();
      server.once("error", () => process.exit(1));
      server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(() => process.exit(0)));
    ' "$test_port" 2>/dev/null && echo free || echo held)"
    if [[ "$leftover" == "free" ]]; then
      pass "test port released; no orphaned daemon"
    else
      fail "test port is still held after shutdown (orphaned daemon)"
    fi
  fi
fi
echo

# --- C. Dynamic dependency closure ----------------------------------------
echo "Test C: dynamic dependency closure"
if "$NODE" "$ROOT/scripts/verify-macos-bundle.mjs" --app "$APP" --quiet >/dev/null 2>&1; then
  pass "all Mach-O dependencies resolve from Apple system paths or the bundle"
else
  fail "bundle verification failed; run scripts/verify-macos-bundle.mjs for details"
  "$NODE" "$ROOT/scripts/verify-macos-bundle.mjs" --app "$APP" 2>&1 | grep -E 'FAIL|problem' | sed 's/^/         /' || true
fi
echo

# --- D. Signatures --------------------------------------------------------
echo "Test D: signature validity"
if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
  pass "codesign --verify --deep --strict succeeded"
else
  fail "codesign --verify --deep --strict failed"
fi
for binary in "$NODE" "$APP/Contents/Resources/tunnel-client" "$APP/Contents/MacOS/LocalDevMenuBar"; do
  [[ -f "$binary" ]] || continue
  label="$(basename "$binary")"
  if codesign --verify --strict "$binary" >/dev/null 2>&1; then
    pass "$label signature valid"
  else
    fail "$label signature invalid"
  fi
done
echo

# --- E. Tunnel regression checks -----------------------------------------
echo "Test E: tunnel regression checks"
check_dir="$(mktemp -d "${TMPDIR:-/tmp}/chat2local-regress.XXXXXX")"
cleanup_paths+=("$check_dir")
regression_ok=true
compile_check() {
  local name="$1"; shift
  local -a sources=("$@")
  if ! swiftc "${sources[@]}" -parse-as-library -o "$check_dir/$name" 2>"$check_dir/$name.build.log"; then
    fail "$name failed to compile"
    sed 's/^/         /' "$check_dir/$name.build.log" | head -10
    regression_ok=false
    return
  fi
  if "$check_dir/$name" >"$check_dir/$name.log" 2>&1; then
    pass "$name passed"
  else
    fail "$name failed"
    sed 's/^/         /' "$check_dir/$name.log" | head -10
    regression_ok=false
  fi
}

compile_check TunnelReconnectPolicyCheck \
  apps/macos/Sources/LocalDevMenuBar/TunnelReconnectPolicy.swift \
  apps/macos/Tests/TunnelReconnectPolicyCheck.swift
compile_check TunnelConnectionSettingsCheck \
  apps/macos/Sources/LocalDevMenuBar/TunnelConnectionSettings.swift \
  apps/macos/Tests/TunnelConnectionSettingsCheck.swift
compile_check DaemonRecoveryPolicyCheck \
  apps/macos/Sources/LocalDevMenuBar/DaemonRecoveryPolicy.swift \
  apps/macos/Tests/DaemonRecoveryPolicyCheck.swift

# The "fake Connected" fix lives in the daemon's tunnel manager. These cases
# assert that local readiness alone can never be reported as a remote
# connection, and that a confirmed control-plane poll is required.
if [[ -d "$ROOT/node_modules/tsx" ]]; then
  if "$HOST_NODE" --import tsx --test "$ROOT/apps/daemon/src/tunnel-manager.test.ts" \
    >"$check_dir/tunnel-manager.log" 2>&1; then
    pass "tunnel-manager regression suite passed (fake-Connected, control-plane poll, reconnect)"
  else
    fail "tunnel-manager regression suite failed"
    sed 's/^/         /' "$check_dir/tunnel-manager.log" | tail -20
    regression_ok=false
  fi
else
  info "tsx is not installed; skipping the tunnel-manager unit suite"
fi
echo

# --- Summary --------------------------------------------------------------
if [[ $failures -gt 0 ]]; then
  echo "Smoke test FAILED with $failures problem(s). Do not install this build."
  exit 1
fi
echo "Smoke test passed: runtime, service, dependency closure, signatures, and tunnel regressions are all healthy."
