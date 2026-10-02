#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"

cd "$ROOT"
NODE_BIN="${LOCAL_DEV_NODE_BINARY:-$(command -v node)}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "A Node.js 24+ executable is required to package Chat2Local." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 24 )); then
  echo "A Node.js 24+ executable is required to package Chat2Local; found $("$NODE_BIN" --version)." >&2
  exit 1
fi

APP="$("$NODE_BIN" "$ROOT/scripts/build-app-output.mjs" "${LOCAL_DEV_APP_OUTPUT:-}")"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
VERSION="$("$NODE_BIN" -p 'require("./package.json").version')"

npm run bundle:daemon

SWIFT_SDK="${LOCAL_DEV_SWIFT_SDK:-$(xcrun --sdk macosx --show-sdk-path)}"
SWIFT_SDK="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$SWIFT_SDK")"
if [[ "$SWIFT_SDK" == *"/MacOSX26.2.sdk" ]] \
  && [[ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk" ]]; then
  # The installed CommandLineTools Swift compiler predates the 26.2 SDK
  # interface on this machine. Use the compatible 15.4 SDK; the app itself
  # still targets macOS 14+.
  SWIFT_SDK="/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk"
fi

SWIFT_CACHE_ROOT="$ROOT/.tmp/swift-build-support"
mkdir -p \
  "$SWIFT_CACHE_ROOT/clang-module-cache" \
  "$SWIFT_CACHE_ROOT/swiftpm-module-cache" \
  "$SWIFT_CACHE_ROOT/build"

SWIFT_ENV=(
  "SDKROOT=$SWIFT_SDK"
  "CLANG_MODULE_CACHE_PATH=$SWIFT_CACHE_ROOT/clang-module-cache"
  "SWIFTPM_MODULECACHE_OVERRIDE=$SWIFT_CACHE_ROOT/swiftpm-module-cache"
)
SWIFT_ARGS=(
  --disable-sandbox
  --package-path apps/macos
  --scratch-path "$SWIFT_CACHE_ROOT/build"
  -c release
)

env "${SWIFT_ENV[@]}" swift build "${SWIFT_ARGS[@]}"

SWIFT_BIN="$(
  env "${SWIFT_ENV[@]}" swift build \
    "${SWIFT_ARGS[@]}" \
    --show-bin-path
)"
# Always build a fresh app bundle so removed resources cannot survive from
# earlier development/smoke builds.
APP="$("$NODE_BIN" "$ROOT/scripts/build-app-output.mjs" "$APP")"
python3 -c 'import os, shutil, sys; p=sys.argv[1]; shutil.rmtree(p) if os.path.exists(p) else None' "$APP"

mkdir -p "$MACOS" "$RESOURCES"

cp "$SWIFT_BIN/LocalDevMenuBar" "$MACOS/LocalDevMenuBar"
# Swift release binaries retain debugging symbols with the builder's local
# paths. Remove them before the app is signed and packaged.
/usr/bin/strip -S "$MACOS/LocalDevMenuBar"
cp "$DIST/local-devd.mjs" "$RESOURCES/local-devd.mjs"

# Ship only the architecture this app build targets. The Node installer on
# development Macs is commonly universal, and embedding both slices doubles
# bundle/signing space for no benefit in a single-architecture release.
ARCH="$(uname -m)"
if command -v lipo >/dev/null 2>&1 && lipo -info "$NODE_BIN" 2>/dev/null | grep -q "Architectures in the fat file"; then
  lipo "$NODE_BIN" -thin "$ARCH" -output "$RESOURCES/node"
else
  cp "$NODE_BIN" "$RESOURCES/node"
fi

chmod +x "$MACOS/LocalDevMenuBar" "$RESOURCES/node"

# Download a pinned official runtime, verify it, and retain upstream notices.
# This is a build-time operation; installed users receive the ready bundle.
TUNNEL_ARCH="$ARCH"
if [[ "$TUNNEL_ARCH" == "x86_64" ]]; then TUNNEL_ARCH="x64"; fi
TUNNEL_RESOURCES="$ROOT/.tmp/tunnel-client-$TUNNEL_ARCH"
node scripts/fetch-tunnel-client.mjs --arch "$TUNNEL_ARCH" --output-dir "$TUNNEL_RESOURCES"
TUNNEL_LICENSE_REPORTS=("$TUNNEL_RESOURCES"/licenses/*-licenses.txt)
TUNNEL_DEPENDENCY_LICENSES="$ROOT/.tmp/tunnel-client-dependency-licenses-$TUNNEL_ARCH"
node scripts/collect-tunnel-licenses.mjs --report "${TUNNEL_LICENSE_REPORTS[0]}" --output-dir "$TUNNEL_DEPENDENCY_LICENSES"
cp "$TUNNEL_RESOURCES/tunnel-client" "$RESOURCES/tunnel-client"
cp "$TUNNEL_RESOURCES/tunnel-client-provenance.json" "$RESOURCES/tunnel-client-provenance.json"
mkdir -p "$RESOURCES/licenses/tunnel-client"
cp -R "$TUNNEL_RESOURCES/licenses/." "$RESOURCES/licenses/tunnel-client/"
cp -R "$TUNNEL_DEPENDENCY_LICENSES" "$RESOURCES/licenses/tunnel-client/dependencies"
chmod +x "$RESOURCES/tunnel-client"
cp "$ROOT/LICENSE" "$RESOURCES/LICENSE"

# Preserve the exact embedded Node release's complete license text, including
# the notices for its built-in dependencies. An explicit local copy also works.
NODE_VERSION="$("$NODE_BIN" -p 'process.version')"
NODE_LICENSE="${LOCAL_DEV_NODE_LICENSE:-$ROOT/.tmp/licenses/node-$NODE_VERSION-LICENSE.txt}"
if [[ ! -f "$NODE_LICENSE" ]]; then
  mkdir -p "$(dirname "$NODE_LICENSE")"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 60 \
    "https://raw.githubusercontent.com/nodejs/node/$NODE_VERSION/LICENSE" \
    --output "$NODE_LICENSE.download"
  mv "$NODE_LICENSE.download" "$NODE_LICENSE"
fi
mkdir -p "$RESOURCES/licenses/node"
cp "$NODE_LICENSE" "$RESOURCES/licenses/node/LICENSE.txt"

# The daemon bundles these runtime packages. Fail if a required license is
# missing instead of distributing binaries without their copyright notices.
for dependency in @modelcontextprotocol/core @modelcontextprotocol/node @modelcontextprotocol/server @hono/node-server hono zod; do
  if [[ -d "$ROOT/node_modules/$dependency" ]]; then
    mkdir -p "$RESOURCES/licenses/dependencies/$dependency"
    cp "$ROOT/node_modules/$dependency/LICENSE" "$RESOURCES/licenses/dependencies/$dependency/LICENSE.txt"
  fi
done
cat > "$RESOURCES/THIRD_PARTY_NOTICES.txt" <<NOTICES
Chat2Local's source is distributed under the MIT license in Resources/LICENSE.

This bundle includes Node.js $NODE_VERSION. Its full license and third-party
notices are in licenses/node/LICENSE.txt. Daemon dependency licenses are in
licenses/dependencies/.

The official OpenAI tunnel-client runtime is packaged as tunnel-client. Its
LICENSE, NOTICE, dependency report, and SPDX document are retained in
licenses/tunnel-client/. Full dependency copyright and license texts, with a
source and hash index, are in licenses/tunnel-client/dependencies/.
The executable was renamed for discovery and may be
re-signed when packaging this app. Original upstream download and binary
hashes are recorded in tunnel-client-provenance.json. The final app signature
belongs to the Chat2Local build, not OpenAI.
NOTICES

mkdir -p "$RESOURCES/local-dev-plugin"
rsync -a --exclude='.DS_Store' --exclude='*.test.mjs' "$ROOT/plugin/local-dev/" "$RESOURCES/local-dev-plugin/"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>LocalDevMenuBar</string>
    <key>CFBundleIdentifier</key>
    <string>dev.localdev.localdev</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Chat2Local</string>
    <key>CFBundleDisplayName</key>
    <string>Chat2Local</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleVersion</key>
    <string>3</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Ad hoc signing works on a fresh checkout without private signing material.
# Set LOCAL_DEV_SIGNING_IDENTITY to use an existing certificate explicitly.
"$ROOT/scripts/sign-local-dev-app.sh" "$APP"

echo "$APP"
