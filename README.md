# auto-router

`auto-router` is a local model router for AI coding clients. It keeps a task on one
model when possible, moves harder work to stronger models, and lets you use several
provider accounts through one local endpoint.

This is an experimental release. It runs on your computer and does not host models or
provide API credits.

[View `@js4683/auto-router` on npm](https://www.npmjs.com/package/@js4683/auto-router)

## Requirements

- Node.js 22 or newer
- At least one provider account or API key
- A supported client: Claude Code, OpenCode, Codex, Cursor, or another compatible client

## Install

Install the published package globally:

```bash
npm install --global @js4683/auto-router
```

If you prefer not to install globally, use `npx` and prefix later commands with
`npx @js4683/auto-router` as well:

```bash
npx @js4683/auto-router
```

For contributors or current development work, run the source checkout instead:

```bash
git clone https://github.com/js4683/auto-router.git
cd auto-router
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node dist/cli.js
```

## Quick Start

1. Install the package globally, or use `npx` for each command.
2. Start the proxy with `auto-router`.
3. Open `http://127.0.0.1:8787` and add a provider account or API key.
4. Run `auto-router install` to configure your supported coding clients.
5. Keep the proxy running while your client sends requests through it.

## Start the Proxy

After installation, start the local proxy:

```bash
auto-router
```

The default address is `http://127.0.0.1:8787`. Open that address in a browser to see
provider status, connect accounts, add API keys, and view recent routes.

Keep the proxy running while your client uses it.

## Connect a Provider

You can connect accounts from the browser at `http://127.0.0.1:8787`, or use the CLI:

```bash
auto-router login claude
auto-router login codex
auto-router login gemini
auto-router login antigravity
auto-router login grok
auto-router login zen
```

The login names are aliases for Anthropic, OpenAI, Google, xAI, and OpenCode Zen. API
keys can be entered in the local settings page. They are stored locally with restricted
file permissions.

Google Antigravity login needs a Google Desktop OAuth client that you control. The
client ID is not bundled with auto-router.

## Configure Your Client

Let the installer update supported client settings:

```bash
auto-router install --opencode
auto-router install --claude
auto-router install --codex
auto-router install --cursor
```

To configure every supported client, omit the client flags:

```bash
auto-router install
```

Review existing settings before installing. Conflicting values are preserved rather
than overwritten. To remove unchanged auto-router settings:

```bash
auto-router install --uninstall
```

You can also configure a client manually:

```text
Claude Code: ANTHROPIC_BASE_URL=http://127.0.0.1:8787
Codex:       OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OpenAI API:  http://127.0.0.1:8787/v1
```

In OpenCode, select the `auto-router/auto` model after adding the provider.

## Safety

- The proxy listens on loopback by default.
- Do not expose it to your network unless you have secured the surrounding boundary.
- Credentials stay in your local configuration; do not commit `.env` or auth files.
- Provider credentials are not interchangeable. auto-router does not send an API key or
  OAuth token to a different provider.
- `auto-router --help` and `auto-router install --help` show the available commands.

## Troubleshooting

Check that the proxy is running, then visit:

```text
http://127.0.0.1:8787/health
```

If a client still uses its original provider, check its base URL and restart the client.
If the installer reports a conflict, keep the existing setting and configure the base
URL manually or remove only the setting you own.

## Current Limitations

The package is local and experimental. Live coverage for every provider, Google browser
OAuth, real-client installer behavior, and some account rotation paths still need
separate verification. Offline tests and package checks are not proof of successful live
inference or provider quota behavior.

## For Contributors

The [project plan](PLAN.md) contains the implementation status and evidence boundaries.
The [audit](docs/plans/2026-09-06-proxy-account-audit.md) records open release blockers.

Run the local checks from the repository root:

```bash
npm run build
npm test
npm run package:smoke
npm run release:check
git diff --check
```
