# Chat2Local GitHub Preview Implementation Plan

> **For implementers:** Execute the approved release preparation in this session and verify each output before publication.

**Goal:** Prepare a consistently named, privacy-checked Chat2Local developer preview for GitHub.

**Architecture:** Keep existing tool identifiers, local state paths, Keychain service names, and bundle identity compatible. Rename public app/plugin labels, documentation, installer command and archive names. Build a separate app bundle and publish only an allowlisted source checkout; preserve the running development app and private state.

**Tech Stack:** SwiftUI, TypeScript/Node.js, MCP, standalone npm installer, macOS packaging, GitHub CLI.

---

### Task 1: Public branding and release compatibility

- Update visible Swift UI text under `apps/macos/Sources/LocalDevMenuBar` to Chat2Local; retain Swift target/module names and storage identifiers.
- Update build/release and installer scripts/tests to `Chat2Local.app`, `chat2local` command and archive stems; preserve bundle identity and legacy installed-app protection.
- Make Mac build outputs selectable so a fresh build cannot replace the current running bundle.
- Update root package metadata and plugin display/name/skill text while preserving callable `local_dev_*` tools and bridge keys.

### Task 2: Public presentation

- Rewrite `README.md` with the current purpose, prerequisites, setup, a small real-work example, a privacy explanation, and honest developer-preview limits.
- Update `docs`, installer guide, example guides, troubleshooting, security, and changelog for consistent naming.
- Include a privacy-safe interface image; identify a real screenshot or clearly label an illustration.
- Check public links and avoid claiming npm publication or notarized downloads.

### Task 3: Verify artifacts

- Run automated service/bridge/release/installer tests and native build/model checks.
- Build a separate branded app, strip native debug metadata, verify signature, package ZIP, and check the packaged service with empty isolated state.
- Regenerate source archive/inventory and inspect source, ZIP, and installer package for private state or personal identifiers.

### Task 4: GitHub preparation and publication

- Inspect authenticated GitHub account and resolve destination with the user.
- Extract only the approved source export into a clean publishing checkout and verify its inventory, local links, and ignored private/build files.
- Prepare concrete repository description, README and release files before publication; publish only to a resolved user-selected destination.
- Report repository URL and exact distribution status. Never include runtime keys, chat histories, profiles, temporary diagnostics, or the entire development folder.
