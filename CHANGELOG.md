# Changelog

## 0.3.0 — Developer preview (2026-10-02)

- Renamed the public app and guides to Chat2Local, with a `chat2local` installer command. Existing tool identifiers and local state paths remain compatible.
- Added private work history and checkpoints for each chat and folder selection, with inspection required before resuming uncertain changes.
- Added a native recovery view, deliberate copying of recovery summaries, safe history clearing, and a guarded manual service restart.
- Made direct text saves atomic and recorded their staging evidence; interruptions keep complete old or new destination contents.
- Prevented a second service using the same state from disturbing the first service's recovery records.
- Simplified Chat2Local to manual folder selection for each chat.
- Several chats can connect independently to the same folder.
- Kept scoped file, search, shell, background browser, web reading, image import, and skill tools.
- Replaced the dashboard with chat connections and folder controls.
- Folder selection is completed in the native app; a chat URL or exact title is no longer required.
- Kept existing local project folders and older local state untouched. New connections begin with a manual folder selection.
- Added a private ChatGPT tunnel setup form and bundled the pinned official OpenAI tunnel runtime with its licenses and provenance.
- Added an explicit npm installer for prebuilt Mac apps, with checked downloads and staged installation that preserves existing apps and local credentials.
- Added desktop ZIP/checksum manifests, a staged npm package builder, and a reproducible source export with an explicit inventory and secret-pattern scan.
- Removed personal build paths from native debug symbols before signing, and blocked desktop packaging when the app executable still contains a personal home path.
- Added installation, skills, recovery, privacy, and release guides under the MIT license, and extended macOS CI to verify the app package.

### Verified workflow

An ordinary ChatGPT chat saved recovery checkpoints through Chat2Local and continued using scoped tools after refreshing the connection. The native app displayed its saved history. Automated interruption checks verified persisted checkpoints, uncertain outcomes, and explicit review before further changes.

### Distribution status

This is a source-sharing developer preview. The npm installer and Apple Silicon app archive have been tested locally; neither has been published. The app uses ad hoc developer signing. Public app downloads still require a selected release destination, Developer ID signing/notarization, and a separate Mac check. See [release verification](docs/RELEASE_CHECK.md) and [npm release preparation](docs/NPM_RELEASE.md).
