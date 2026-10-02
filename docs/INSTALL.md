# Install Chat2Local

This preview requires developer setup. A GitHub download does not automatically connect to ChatGPT or install skills.

## npm installer status

The installer is implemented under `packages/installer`, but this preview has not been published to npm and hosted app downloads are not configured yet. After publication, run `npx <published-package-name> install` with Node.js 20+ on macOS 14+. This is a command template until the actual package name is selected.

The installer places the prebuilt app in `~/Applications` and opens it for setup. The app includes its own Node runtime and tunnel client. No Xcode, compilation, or separate tunnel-client download is needed on the installing Mac. It preserves existing apps and local state; a different existing release must be moved aside explicitly. Ad hoc preview builds have not passed the public Apple signing/notarization gate. See [release preparation](NPM_RELEASE.md).

## 1. Build the Mac app

Install Node.js 24+ and Xcode or a Swift 6.2 toolchain with a compatible macOS SDK. Chat2Local targets macOS 14+. Extract the source and open a terminal in that folder:

```sh
npm ci
npm run robustness
npm run macos:package
open "dist/Chat2Local.app"
```

The app bundles the Node runtime used for packaging. Browser tools additionally require Brave Browser at `/Applications/Brave Browser.app`; file tools and skills work without it.

Builds use ad hoc signing by default. No certificate, trusted root, or private signing key is created. This is a locally built app, not a notarized public binary. If you already have a signing identity, you may supply it:

```sh
LOCAL_DEV_SIGNING_IDENTITY="Your existing signing identity" npm run macos:package
```

If Swift reports an SDK/compiler mismatch, select a compatible Xcode toolchain or SDK.

## 2. Create the ChatGPT connection

Prefer pictures? Follow the [visual connection guide](CONNECTION_SCREENS.md), with OpenAI's sanitized screenshots and a placeholder runtime-key diagram.

Chat2Local already includes the local MCP API server. You do not need to build another API server. The tunnel lets ChatGPT reach it through an outbound connection from your Mac.

OpenAI account access is separate from installing Chat2Local. This preview uses a private developer connection; it is not a public plugin-directory installation.

### A. Create a tunnel and obtain its runtime API key

1. Sign in to [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) and select the organization that will own the tunnel. For personal use, use your personal Platform organization.
2. Create a Secure MCP Tunnel. Copy its **tunnel ID**.
3. Associate the tunnel with your target ChatGPT workspace.
4. Obtain a **runtime API key** authorized to use that tunnel in the selected organization. Follow the setup offered in your tunnel settings, or ask your organization owner or RBAC administrator. The key-creation controls may vary; creating a tunnel does not necessarily issue a key.
5. Chat2Local's packaged app includes the official tunnel runtime for your Mac's processor. A separate download is needed only when running the daemon directly or choosing an external client: use the settings page or [OpenAI's official releases](https://github.com/openai/tunnel-client/releases/latest).

Creating or editing a tunnel requires organization-level **Tunnels Read + Manage** permissions. Running the client and selecting the tunnel requires **Read + Use**. See [OpenAI's Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

### B. Save the connection in Chat2Local

1. Open Chat2Local's **ChatGPT connection** section and expand **Connection settings**.
2. Paste the tunnel ID into **Tunnel ID** and its runtime API key into **Runtime key**.
3. Leave the optional client location empty to use the bundled tunnel client. Use **Choose executable…** only if you prefer an external official client.
4. Choose **Save and connect**. Chat2Local launches the tunnel client and connects it to its local MCP server. Wait for **Connected**. You do not need to run a second tunnel client in a terminal.

The runtime key is an OpenAI API key used by the tunnel client for transport. Chat2Local does not send model-inference API requests with it. Enter it only in Chat2Local's masked field; it is stored in Keychain. No additional model-inference API key is needed for this ChatGPT workflow.

Chat2Local also generates its own **local API token** for communication with the service on your Mac. The app manages that token automatically. It is different from the tunnel runtime key. Never paste either credential into a chat, issue, or repository. Manually saved connection settings take precedence over legacy migration.

### C. Add Chat2Local in ChatGPT

1. In ChatGPT, enable **Developer mode** under **Settings → Security and login**, if available. Your workspace administrator may need to allow it.
2. Open **Plugins**, select **+**, and enter a name and description for Chat2Local.
3. Set **Connection → Tunnel**, then select your tunnel or enter its ID.
4. Create the connection and review its discovered tools. This version exposes 15 Chat2Local tools, including `local_dev_work_log` for reading history and saving checkpoints.
5. Open a chat and select Chat2Local from its tools menu. Ask **Use Chat2Local for this project**, then follow the folder-selection steps below.

Account and workspace policy can limit these controls. See [OpenAI's ChatGPT connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt). After updating Chat2Local's tools, open **ChatGPT → Plugins → Chat2Local → Refresh**, confirm that its discovered tools include `local_dev_work_log`, then test in a new chat with that connection selected. The Chat2Local window's Refresh button updates local status; it does not update ChatGPT's saved tool catalog. If a new chat still lacks the helper, verify the selected connection or installed plugin mapping before project changes.

## 3. Choose a chat's folder

Ask: **Use Chat2Local for this project.** The setup action returns a code such as `LD-1234ABCD`. Open Chat2Local, match that code, and choose a folder. Return to the chat and reply **connected**.

The chat should confirm its selected folder and list skills before changing files. Project guides live in `.agents/skills/<name>/SKILL.md` or `.codex/skills/<name>/SKILL.md`. The catalog also discovers guides already installed on your Mac. This repository bundles a Chat2Local workflow under `plugin/local-dev/skills/`.

Existing connections may still be labeled **Local Dev** in ChatGPT until you rename them there. The `local_dev_*` tool names, `LD-` setup codes, and private `.local-dev` state path remain compatible with earlier previews.

## Optional: install the bundled workflow plugin

Registering the tunnel makes tools available. Bundled workflow instructions require a plugin installation too. The portable source package is `plugin/local-dev`; its `mcp.json` uses a stdio bridge for hosts that run local MCP servers. That file alone does not configure an ordinary ChatGPT tunnel connection.

Use ChatGPT's plugin creator to map your registered connection to this plugin. The connection's technical ID begins with `plugin_asdk_app`; keep that account-specific mapping in your local install. Ask the creator to include the bundled Chat2Local skill and a personal marketplace entry. Verify the mapping, install from that source, and test in a new chat. [OpenAI packaging instructions](https://developers.openai.com/plugins/build/plugins).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No chat appears | It must call a Chat2Local action once. Opening it does not register it. |
| `folder_required` | Match the setup code and manually choose the folder. |
| Missing chat identity | This client did not supply trusted per-chat metadata. Try a supported client and report the limitation. |
| Tools missing | Refresh the Chat2Local connection in ChatGPT Plugins, confirm the 15-tool list includes `local_dev_work_log`, then test in a new chat with the correct connection selected. |
| Checkpoint helper missing | The running service and ChatGPT's imported tool list may differ. Refresh the connection and verify the helper is actually callable. Reading a file named `local_dev_work_log` or saving a manual checkpoint file does not satisfy the recovery gate. |
| Tunnel disconnected | Check the ID, key, executable, and workspace association. Redact credentials from diagnostic output before sharing. |
| Cannot change folder | Let the active tool finish, refresh, and try again. |
| Browser tool fails | Install Brave at the required location. |

Only one service should use the default port. Quit an earlier instance before running `npm run dev`. Closing the window leaves the menu and service running; choose **Quit** to stop them.
