#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
app_path="${1:-$repo_root/dist/Chat2Local.app}"
signing_identity="${LOCAL_DEV_SIGNING_IDENTITY:--}"

if [[ ! -d "$app_path" ]]; then
  echo "Chat2Local app bundle not found: $app_path" >&2
  exit 1
fi
if ! command -v codesign >/dev/null 2>&1; then
  echo "macOS codesign is required to sign Chat2Local." >&2
  exit 1
fi

# Fresh source builds use an ad hoc signature. An existing certificate can be
# selected explicitly; no signing certificate, trust setting, or Keychain is
# created or changed by this script.
signing_args=(--force --sign "$signing_identity")
if [[ "$signing_identity" == "-" ]]; then
  signing_args+=(--timestamp=none)
else
  signing_args+=(--options runtime --timestamp)
fi

# Sign the nested runtime first, preserving the permissions V8 needs for JIT.
# The outer bundle signature then seals all resources and its native executable.
codesign "${signing_args[@]}" \
  --entitlements "$repo_root/scripts/node-entitlements.plist" \
  "$app_path/Contents/Resources/node"
if [[ -f "$app_path/Contents/Resources/tunnel-client" ]]; then
  codesign "${signing_args[@]}" "$app_path/Contents/Resources/tunnel-client"
fi
codesign "${signing_args[@]}" "$app_path"
codesign --verify --deep --strict "$app_path"

if [[ "$signing_identity" == "-" ]]; then
  echo "Signed Chat2Local ad hoc for local use."
else
  echo "Signed Chat2Local with the selected certificate."
fi
