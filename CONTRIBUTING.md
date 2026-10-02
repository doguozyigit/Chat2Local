# Contributing to Chat2Local

Chat2Local is a macOS developer preview. Contributions that make folder access, tools, recovery, or setup easier to understand are welcome.

## Run the checks

Use Node.js 24+ and npm. Native checks also require macOS 14+, Swift 6.2, and a compatible SDK.

```sh
npm ci
npm run robustness
npm run macos:package
npm run release:check
```

`npm run robustness` covers the service, bridge, and release/installer behavior. The native packaging step builds the Mac app. Use disposable folders and isolated state for tests; do not connect a private project just to reproduce a bug.

## Keep the scope focused

The product connects each chat to a manually selected folder. Several chats may choose the same folder. Tools and skills work within that access model, with checkpoints and history to help recover from interruptions.

Changes should preserve the boundaries described in [SECURITY.md](SECURITY.md), retain the compatible `local_dev_*` tool identifiers, and avoid silently granting access or replaying actions. Existing internal state and package names may still use `local-dev` for compatibility.

## Report a bug

Include the app version, macOS version, affected action, expected result, and a small reproduction using synthetic data. Redact error output before posting it. Do not attach runtime databases, tunnel keys, API tokens, browser profiles, or private project files. For a possible security issue, follow [security reporting](SECURITY.md#reporting-a-problem).

## Prepare a change

- Explain the problem and how the change affects users.
- Add a meaningful regression check when behavior or an access boundary changes.
- Update relevant setup, tool, recovery, or privacy documentation.
- Run the relevant checks and state what remains unverified.
- Run the source release check before sharing new files.

The [release checklist](docs/RELEASE_CHECK.md) and [npm release guide](docs/NPM_RELEASE.md) describe distribution gates. Tests against local archives do not prove successful public downloads or first launch on another Mac.
