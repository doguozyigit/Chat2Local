# Chat2Local installer

This package provides a small npm command that installs the prebuilt
macOS Chat2Local app, including its Node runtime and OpenAI tunnel client. Node.js
20 or later is needed to run this installer; no Xcode or Swift build is needed.

The package does not install anything through npm lifecycle scripts. The
`chat2local install` command is always explicit. A published package will include
the release's public manifest. The source draft has no hosted release configured;
its manifest is populated when the publisher prepares a package.

## Local release check

After producing a signed desktop ZIP and public release manifest:

```sh
node packages/installer/bin/chat2local.mjs install \
  --manifest-file /absolute/path/release-manifest-darwin-arm64.json \
  --archive-file /absolute/path/chat2local-0.3.0-darwin-arm64.zip \
  --destination /absolute/path/existing/test-applications \
  --no-open
```

For a hosted release, use `--manifest-url` with the publisher's HTTPS manifest.
The manifest and archive are public files and must never contain API keys.
Only use a manifest supplied by a publisher you trust: its checksums detect
changed downloads; they do not independently prove who published the release.

## Installation behavior

- Supports macOS 14 or later on Apple Silicon (`arm64`) and Intel (`x64`) when
  the manifest supplies a matching release.
- Defaults to `~/Applications`; an explicit destination must already exist.
- Verifies size and SHA-256 before extracting. Rejects unsafe ZIP paths,
  symlinks, duplicate paths, and unsupported archive formats.
- Checks the bundle identifier, release version, processor architecture, and
  macOS code signature before installing.
- Preserves existing applications, local project files, credentials and folder
  connections. Repeating the same verified installation succeeds without
  replacing the app. Different releases require moving the old app aside first.
- A legacy **Local Dev.app** with the same bundle identity must also be closed
  and moved out of the destination before installing Chat2Local. Both names use
  the same local service and saved state; the installer holds this collision.
- Does not disable Gatekeeper or change permissions for other applications.
  Ad hoc signatures validate bundle integrity; this preview is not notarized.

After installation, open **ChatGPT connection → Connection settings** in
Chat2Local, enter your tunnel ID and runtime API key, and connect. The client is already
bundled; no second client download is needed. Then select each chat's folder.

## Publisher status

The source uses `chat2local-installer` as a draft package name. It stays private until a
public name and GitHub release location are selected, verified release assets
are hosted, and its manifest is populated. No npm or GitHub publication occurs
when running local checks or creating a package archive.
