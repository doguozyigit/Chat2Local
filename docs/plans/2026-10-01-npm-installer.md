# npm Installer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Install a prebuilt Local Dev Mac app, including its tunnel client, through an explicit npm command without compiling on the user's machine.

**Architecture:** A small dependency-free npm CLI downloads an architecture-specific app ZIP whose URL, size, and SHA-256 are pinned in its packaged manifest. It validates and stages the bundle before installing into the user's Applications directory and opening setup. A separate release builder creates the ZIP and manifest from a verified app bundle; account credentials stay in the native setup screen.

**Tech Stack:** Node.js 24, macOS app bundles, Swift, OpenAI tunnel-client runtime, ZIP, npm, GitHub release assets.

---

## Decisions

- One archive contains the native UI, bundled Node runtime, tool service, workflow skill, and pinned official tunnel runtime. Existing user credentials and selected folders are preserved.
- The npm package runs only when its command is invoked; no install lifecycle scripts run code or download binaries.
- Production downloads require HTTPS and a matching checksum and size. Local fixture tests explicitly supply both a manifest and archive.
- Installation rejects unsupported systems, malformed archives, escaping paths, symlinks, invalid signatures, and a different existing app. It does not kill a running app, overwrite user projects, or change Gatekeeper settings.
- Default installation is `~/Applications/Local Dev.app`; explicit destinations must be absolute directories.
- Apple Silicon is validated on the current Mac. Intel artifacts require an Intel build and checks before being advertised.
- GitHub repository and npm package ownership must be supplied before publishing. Draft metadata does not pretend that hosted downloads exist.
- Ad hoc signatures are suitable for local developer tests. A public download needs a separate Developer ID signing and notarization gate for normal macOS distribution.

## Task 1: Installer package

**Files:** `packages/installer/package.json`, CLI/library, tests, README, license.

1. Write tests for unsupported platforms, integrity failures, safe ZIP extraction, existing-app preservation, and an isolated real app install.
2. Run the tests and observe the missing installer fail.
3. Implement the CLI and bounded download/extraction validation.
4. Run focused tests, then exercise the package through `npm pack` and npm's command execution.

## Task 2: Official tunnel runtime in the app

**Files:** `scripts/tunnel-client-release.json`, downloader and tests, `scripts/build-macos-app.sh`, signing script, daemon configuration tests/source.

1. Verify the official release version, runtime flags, SHA-256 values, and license/notice files.
2. Write failing tests for pinned download integrity and bundled-client discovery.
3. Add a build-time downloader for the pinned runtime and preserve its license and provenance. Include bundled runtime licenses in the app.
4. Resolve the bundled executable by default, retaining explicit user paths.
5. Verify nested signatures, actual runtime help/version, and app packaging.

## Task 3: Release ZIP and manifest

**Files:** `scripts/package-desktop-release.mjs`, tests.

1. Write failing release tests using a signed isolated app fixture.
2. Validate app ID, version, all binary architectures, resources, and signatures.
3. Create an archive compatible with the installer's strict extraction and write versioned download metadata and checksums.
4. Validate a real app archive and install it into a temporary destination without opening or connecting it.

## Task 4: Integration and sharing

**Files:** root package scripts/lockfile, source export allowlist, CI, README, installation/release/security guides, changelog.

1. Add installer and packaging tests to the relevant verification gates.
2. Document user setup separately from maintainer publishing and Apple distribution requirements.
3. Add a workflow that builds release assets without silently publishing packages.
4. Run the full robustness gate, fresh-state service checks, source export scan, and package-content review.
5. Prepare local app ZIP, npm tarball, manifest, and a verification report. Publish only to the user-supplied destinations after the artifacts are concrete and reviewable.

## Acceptance

An isolated npm command installs the real packaged app with its tunnel client, without accessing saved credentials, changing folders, invoking a model, or interrupting the running Local Dev service. Corrupted and unsafe downloads fail before installation. Fresh-account ChatGPT setup, hosted downloads, hosted CI, notarization, and Intel installation remain separately identified until verified.
