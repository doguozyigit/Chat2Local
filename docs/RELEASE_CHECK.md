# Developer preview release check

The source export is intended for GitHub. It is not a signed installer or a public ChatGPT-directory submission.

## Verified scope for 0.3.0

The automated, native, packaged-service, and interruption checks below were repeated for the Chat2Local rename on 2026-10-02 on macOS Apple Silicon. Source and package privacy were also audited, including removal of native build-path metadata. Earlier account-specific ChatGPT and UI observations are identified separately. These results describe this developer preview, not every Mac or ChatGPT account.

| Check | Observed result |
| --- | --- |
| Automated service, bridge, script, and installer tests | 224 passed; zero failures |
| Native build and standalone model/policy checks | Passed; six standalone checks |
| Fresh packaged service | 16 checks passed using the newly built app |
| Packed npm installer and installed service | Installed without opening the app; 16 service checks passed from the installed copy |
| Packaged crash and dropped-response recovery | Five checks passed |
| Direct-save interruption and storage failures | Complete destination contents preserved; uncertain outcomes require inspection |
| App signature and archive consistency | Verified locally with ad hoc developer signing |
| Ordinary ChatGPT recovery tools (earlier live trial) | A live chat saved checkpoints and executed scoped tools afterward |
| Native work-log view (earlier live trial) | Saved entries and details loaded successfully |
| Package privacy repair | Native debug paths removed; packaging tests reject a personal build path without disclosing it |
| Rename compatibility | Legacy installation collision and isolated build-output checks passed; existing storage and tool identifiers retained |

The live checks inspected history without clearing it, restarting the working service, or changing project files. Copy, clear, and restart controls were not exercised on the user's live state. Hosted downloads, npm registry installation, Intel hardware, first launch on a separate Mac, and a new ChatGPT account remain unverified.

## Repeatable checks

```sh
npm ci
npm run robustness
npm run macos:package
npm run install:check
"dist/Chat2Local.app/Contents/Resources/node" scripts/work-recovery-check.mjs \
  --daemon "dist/Chat2Local.app/Contents/Resources/local-devd.mjs"
npm run release:check
npm run release:export
```

- **robustness** checks service access rules, scopes, skills, browser operations, the authenticated bridge, recovery gates, interrupted saves, and native models/build.
- **macos:package** bundles the daemon, Node, pinned official tunnel runtime, and licenses; removes native debug symbols, signs locally, and verifies the signature.
- **install:check** starts the packaged service with an empty temporary data directory on a separate port. It exercises the packaged stdio bridge, two synthetic chats sharing a folder, project skills, writes/readback, disconnect, and restart persistence. It does not use saved credentials or alter real chat connections.
- **recovery:check** uses a disposable folder and separate service to drop a tool response, force a service crash, and inspect persisted checkpoints and uncertain outcomes after restart. It checks review before further changes and separate histories for chats sharing a folder. No action is automatically replayed.
- **release:check** lists and scans the exact source inventory proposed for upload. The export uses that inventory and requires a license.
- **release:export** writes a source archive, file/hash manifest, and scan report under `dist`. Review these before uploading.

To check a clean source extraction, extract the archive into a new directory and repeat the first four commands there. This verifies a clean checkout and empty service state on the test Mac. It cannot substitute for a separate Mac, different CPU architecture, or every ChatGPT client.

## Manual acceptance

Run the [demo](DEMO.md) through your ChatGPT account and confirm that its setup code selects the correct folder and a real file appears there. Repeat with a second chat sharing the folder. Check the folder chooser and private connection form visually.

In a disposable test instance, verify **View work log**, archived folder revisions, **Copy recovery summary**, and the confirmation for **Clear completed history**. Interrupt only that instance's owned service, then check **Restart Chat2Local service** and the recovery badge. Model and policy checks do not replace this visual acceptance.

ChatGPT developer-mode access, workspace associations, OpenAI-issued credentials, and actual client metadata must be checked with that user's account. Automated tests use synthetic host metadata; they cannot prove these account-specific conditions.

## Release status

See the generated check reports in `dist` for results from the current preparation. Hosted GitHub Actions run after upload; local checks do not confirm a hosted CI run. Packaging is tested for the build Mac's architecture, not as a universal binary.

The robustness gate also covers installer archives, preservation of existing apps, tunnel download pins, desktop packaging, and npm package manifests. See [npm release preparation](NPM_RELEASE.md) for real bundle acceptance and publication order. Local tests use an explicit archive/manifest pair; they do not confirm downloads from a GitHub release or an npm registry installation. Public first launch also needs Apple's signing/notarization gate and a separate Mac check.
