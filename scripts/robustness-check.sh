#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

npm run check
node scripts/work-recovery-check.mjs

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Native checks require macOS; run this gate on a macOS CI runner."
  exit 0
fi

swift build --package-path apps/macos

check_dir="$(mktemp -d "${TMPDIR:-/tmp}/local-dev-robustness.XXXXXX")"
trap 'rm -rf "$check_dir"' EXIT
swiftc apps/macos/Sources/LocalDevApiAuth/LocalDevApiAuth.swift \
  apps/macos/Tests/LocalDevApiAuthCheck.swift -parse-as-library \
  -o "$check_dir/LocalDevApiAuthCheck"
"$check_dir/LocalDevApiAuthCheck"
swiftc apps/macos/Sources/LocalDevMenuBar/Models.swift \
  apps/macos/Tests/ChatFolderModelsCheck.swift -parse-as-library \
  -o "$check_dir/ChatFolderModelsCheck"
"$check_dir/ChatFolderModelsCheck"
swiftc apps/macos/Sources/LocalDevMenuBar/Models.swift \
  apps/macos/Tests/WorkRecoveryModelsCheck.swift -parse-as-library \
  -o "$check_dir/WorkRecoveryModelsCheck"
"$check_dir/WorkRecoveryModelsCheck"
swiftc apps/macos/Sources/LocalDevMenuBar/DaemonRecoveryPolicy.swift \
  apps/macos/Tests/DaemonRecoveryPolicyCheck.swift -parse-as-library \
  -o "$check_dir/DaemonRecoveryPolicyCheck"
"$check_dir/DaemonRecoveryPolicyCheck"
swiftc apps/macos/Sources/LocalDevMenuBar/TunnelReconnectPolicy.swift \
  apps/macos/Tests/TunnelReconnectPolicyCheck.swift -parse-as-library \
  -o "$check_dir/TunnelReconnectPolicyCheck"
"$check_dir/TunnelReconnectPolicyCheck"
swiftc apps/macos/Sources/LocalDevMenuBar/TunnelConnectionSettings.swift \
  apps/macos/Tests/TunnelConnectionSettingsCheck.swift -parse-as-library \
  -o "$check_dir/TunnelConnectionSettingsCheck"
"$check_dir/TunnelConnectionSettingsCheck"

echo "Robustness checks passed: service, authenticated bridge, native build, and API token checks."
