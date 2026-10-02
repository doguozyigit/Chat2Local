# Chat2Local npm installer and desktop releases

The installer is built and can be exercised locally. Nothing in these scripts publishes to npm or GitHub. The source package remains private until a public package name, account, and repository are selected. The root workspace remains private permanently.

## What users install

A small npm package provides a `chat2local` command. Its pinned manifest points to one prebuilt app ZIP per supported processor. The ZIP contains the Mac interface, Node.js runtime, tool service, workflow skill, official OpenAI tunnel runtime, licenses, and provenance. The installer runs on Node.js 20+; the app carries Node.js 24+ independently.

After publication, the command is:

```sh
npx <published-package-name> install
```

This is a template, not a package that already exists in the registry. Users supply their own tunnel ID and runtime key through the native setup screen, then select each chat's folder. No credentials are included in either archive.

## Build an app archive

From the source checkout, using Node.js 24+ and a compatible Swift toolchain:

```sh
npm ci
npm run robustness
npm run macos:package
npm run install:check
npm run release:desktop -- --repository YOUR_GITHUB_ACCOUNT/YOUR_REPOSITORY
```

The repository argument is required and must identify the actual release destination. The builder produces a versioned architecture-specific ZIP, `release-manifest-darwin-<arch>.json`, and a checksum file under `dist/releases`. It validates app identity, version, all binary architectures, resources, and signatures before archiving. Build each processor's release on that architecture and test it before advertising it. Current live verification covers Apple Silicon.

The tunnel client is downloaded at build time from a pinned official runtime release. Its archive size and SHA-256 are checked before extraction. Upstream LICENSE, NOTICE, dependency report, SPDX metadata, and original binary/archive hashes are retained inside the app. Full dependency copyright and license texts come from the exact Go module versions in that report, with their own source and hash index. Node's full version-specific license and the daemon's dependency licenses are also included. Build-time downloads can use their verified local cache on subsequent runs.

## Test the packed installer locally

Pack the private source package without lifecycle scripts:

```sh
npm pack ./packages/installer --ignore-scripts --pack-destination dist
mkdir -p .tmp/installer-acceptance/Applications
```

Use absolute paths for these test inputs, substituting the architecture you built:

```sh
npm exec --yes --package=/absolute/path/chat2local-installer-0.3.0.tgz -- chat2local install \
  --manifest-file /absolute/path/release-manifest-darwin-arm64.json \
  --archive-file /absolute/path/chat2local-0.3.0-darwin-arm64.zip \
  --destination /absolute/path/installer-acceptance/Applications \
  --no-open
```

The explicit local manifest/archive pair exercises installation without contacting a hosted release. `--no-open` avoids starting the app during acceptance. Do not choose your real Applications folder for a disposable test. Repeating the identical verified installation succeeds; a different existing app is held without replacement. User projects, Keychain credentials, and folder connections are not part of the installer inputs or outputs.

## Apple distribution gate

Local builds use ad hoc signatures for development. A matching SHA-256 and valid ad hoc signature establish artifact consistency; they do not establish Apple developer trust or successful first launch on another Mac.

For normal public Mac distribution, use an existing Developer ID Application signing identity through `LOCAL_DEV_SIGNING_IDENTITY`. The signing script signs the nested runtimes before the app, uses hardened runtime and a secure timestamp for that identity, and verifies the bundle. Then complete Apple's notarization workflow and staple the accepted ticket before producing the final ZIP. Validate the final app and first launch on a separate Mac. Follow [Apple's notarization instructions](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

The installer does not disable Gatekeeper, remove quarantine, or install certificates. No Developer ID credentials or notarization submission have been configured in this preview. Do not describe its ad hoc ZIP as a notarized one-command public release.

## Prepare the public npm package

After generating the final app assets, select the package name you control:

```sh
npm run release:npm -- \
  --name @YOUR_NPM_ACCOUNT/chat2local \
  --manifest dist/releases/release-manifest-darwin-arm64.json \
  --output-dir dist/npm-release
```

Repeat `--manifest` for a separately tested Intel release if available. The script merges matching manifests, creates a staged publishable package, and packs it. It does not change the private source package or publish anything. Inspect the packed inventory and verify its version, public URLs, hashes, and architectures. Test the packed package against the final app before uploading.

## Publish in order

1. Upload the verified app ZIPs, manifests, and checksums to the selected GitHub release whose tag matches the manifest, such as `v0.3.0`.
2. Check that each exact public URL downloads the expected bytes without credentials. A private GitHub release cannot serve ordinary unauthenticated installer downloads.
3. Test the staged npm package against the real hosted downloads on a separate Mac.
4. Authenticate to the selected npm account and publish the inspected staged tarball. Public scoped packages require `--access public`.
5. Put the actual `npx` command in the README and test it from npm's registry.

See [npm package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/), [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/), and [publishing public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/). Publication requires the user's chosen destinations and account access; they cannot be inferred from a local folder name.
