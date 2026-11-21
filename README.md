# Browser Guard MCP

**Give your agent a browser, not your browser.**

An MCP server that gives a coding agent a controlled Chromium session: public pages only, explicit capability profiles, one-use approval for card/password/one-time-code entry, and evidence that stays in process memory.

The guard starts its own isolated headless Chrome. It does not attach to your desktop browser, inherit your cookies, load your extensions, or expose a general-purpose browser API. Every action goes through one narrow, auditable surface.

Version 0.1.0. macOS-first; the sensitive-input dialog currently uses `osascript`.

Русская версия: [README.ru.md](README.ru.md).

## Why

Coding agents increasingly need to click, fill, and read real pages. Handing them the user's browser also hands them sessions, saved passwords, extensions, and the local network. This guard exposes the useful part and keeps the rest out of reach.

## Quick start

Requirements:

- Node.js 20 or newer.
- Google Chrome.
- [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) 0.0.76 or newer.

```sh
git clone https://github.com/alexandryasukaitisss-cmd/browser-guard-mcp.git
cd browser-guard-mcp
npm test
```

Install Playwright MCP and note the absolute path to its CLI:

```sh
npm install -g @playwright/mcp
npm root -g
# <npm-root>/@playwright/mcp/cli.js
```

Create a guard configuration:

```sh
mkdir -p ~/.config/browser-guard-mcp
cp examples/config.example.json ~/.config/browser-guard-mcp/config.json
```

Edit these values:

- `runtimeDir`: a private state directory. The guard creates it with mode `0700`.
- `chrome.nodeCommand`: the Node binary that starts Playwright MCP. Defaults to the current Node process if omitted.
- `chrome.playwrightCli`: the absolute path printed by `npm root -g`.
- `capabilities`: the profiles described below.

Check that the configuration loads:

```sh
node src/cli.cjs --check --config ~/.config/browser-guard-mcp/config.json
```

Add the server to your MCP client. See [`examples/mcp-client.json`](examples/mcp-client.json):

```json
{
  "mcpServers": {
    "browser-guard": {
      "command": "/usr/local/bin/node",
      "args": [
        "/Users/you/src/browser-guard-mcp/src/cli.cjs",
        "--config",
        "/Users/you/.config/browser-guard-mcp/config.json"
      ]
    }
  }
}
```

Restart the client and ask:

> Open `https://example.com` and summarize it. Use `browser_route_open` with `intent: "read"`.

For interaction, activate a profile that permits it first:

> Call `browser_capability_activate` with `profile_id: "public-interact"`, open `https://github.com`, and click the search field.

## Tools

The server exposes nine guard tools. It does not expose raw `browser_*` tools.

| Tool | Purpose |
| --- | --- |
| `browser_route_open` | Open a public HTTP(S) URL. `intent` is `read`, `extract`, `visual`, or `interactive`. |
| `browser_route_call` | Call an allow-listed operation on the active page. |
| `browser_capability_activate` | Activate a configured profile for a bounded lifetime. |
| `browser_capability_status` | Show the active profile and expiry. No page data. |
| `browser_action_prepare` | Create a one-use action ID; ask for native approval only for sensitive input. |
| `browser_evidence_bundle` | Capture a bounded snapshot and console output into memory. |
| `browser_evidence_get` | Read an unexpired in-memory bundle. |
| `browser_guard_status` | Show backend and capability state. No page data. |
| `browser_compatibility_summary` | Show the content-free local ledger summary. |

`browser_route_call` accepts only these operations:

| Operation | Profile permission |
| --- | --- |
| `browser_navigate`, `browser_navigate_back` | `navigate` |
| `browser_snapshot` | `read` |
| `browser_console_messages`, `browser_wait_for`, `browser_close` | `observe` |
| `browser_click`, `browser_hover`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_fill_form`, `browser_file_upload` | `interact` |

Everything else is denied. That includes JavaScript evaluation, arbitrary code, cookies, storage, tabs, network-request inspection, and screenshots.

## Capability profiles

A profile names DNS host patterns, allowed operations, and a maximum lifetime. The default profile is `public-read`: navigation and reading, no interaction.

```json
{
  "defaultProfile": "public-read",
  "profiles": [
    {
      "id": "public-interact",
      "hosts": ["github.com", "*.github.com"],
      "operations": ["navigate", "read", "extract", "observe", "interact"],
      "maxTtlSeconds": 900
    }
  ]
}
```

Host patterns support `*`, an exact host, or `*.subdomain`. IP addresses are rejected as patterns. A grant is held in memory and expires; restarting the guard clears it.

## Sensitive input

Before typing into a card number, password, or one-time-code field, the agent must:

1. Call `browser_action_prepare` with the exact tool and arguments.
2. The guard shows a native macOS dialog with **Deny** as the default. Approval returns a one-use ID.
3. Pass that ID to `browser_route_call` with the same tool and arguments.

The ID is bound to the grant, exact origin, tool name, and a SHA-256 digest of the arguments. It expires after 60 seconds by default. Reuse, argument changes, or an origin change fail closed. On non-macOS systems the dialog cannot be shown, so sensitive input is denied.

Detection uses explicit field metadata: `type=password`, card/OTP `autocomplete` tokens, and labels such as “Card number”, “CVV”, “Password”, “One-time code”, “Номер карты”, or “Пароль”.

**It can miss a field.** A custom widget, a field labeled only “Verification code”, or an incomplete agent description may not trigger the dialog. Treat the approval as a guard against accidental entry, not as a data-loss-prevention control. Do not give the agent real card data. The full boundary is below.

## Evidence and local audit

- `browser_evidence_bundle` keeps a bounded snapshot and console output in process memory. It expires with the capability grant and never becomes a file managed by the guard.
- The compatibility ledger is a local JSONL file with mode `0600`. It records only: timestamp, operation, backend, intent, success/failure, error category, operation class, duration bucket, coarse client class, and upload file count. It does not record URLs, domains, page text, arguments, screenshots, cookies, or confirmation IDs.
- Playwright may write transient snapshot files under the private runtime output directory. The guard removes that directory when it closes. The ledger is separate and content-free.

## Demo

```sh
PLAYWRIGHT_MCP_CLI="$(npm root -g)/@playwright/mcp/cli.js" node demo/blocked.cjs
```

Expected shape:

```text
public page: https://example.com/ via chrome
loopback: NETWORK_DENIED
local server requests: 0
```

The local server is real. The last line is the point: the request never arrived.

## Security boundary

What the guard enforces:

- HTTP(S) only, standard ports 80/443, no credentials in the URL.
- Literal private, loopback, link-local, multicast, and special-use addresses are rejected before navigation.
- All Chromium traffic goes through a loopback egress proxy. The proxy resolves each hostname, rejects non-public results, reapplies the active capability host patterns, and covers redirects and subresources.
- Chrome runs with `--isolated`, a private profile, no storage state, no service workers, and a minimal environment without ambient proxy variables or credentials.
- Only the allow-listed operations above reach the browser.
- Known secret files cannot be uploaded: `.env*` (except examples), private keys, Keychain data, `auth.json`, `.ssh`, `.aws`, `.kube`, and similar locations, after `realpath`.
- Card, password, and one-time-code input needs a one-use native approval.

What it does not enforce:

- It is not an operating-system sandbox. Chromium runs with your user privileges. A browser-engine exploit is outside this design.
- Public pages can still be malicious, misleading, or hostile. The guard controls reachability, not content.
- The egress proxy is a boundary for HTTP(S) traffic, not proof against every side channel (for example WebRTC, QUIC, or browser bugs).
- Sensitive-field detection is heuristic. A field with an unusual label can be missed. Do not treat the dialog as a guarantee that no secret can ever be typed.
- Upload checks inspect paths and names, not file contents.
- The isolated profile has no logged-in sessions. Sites that require your existing login will not work; that is intentional.
- Playwright and Chromium keep their own behavior and output. This project does not audit or patch them.

The full boundary and residual risks are in [docs/threat-model.md](docs/threat-model.md). The architecture is in [docs/design.md](docs/design.md).

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Development

```sh
npm test          # 45 deterministic tests, no browser
npm run check     # validate the example configuration
npm run smoke -- --config /path/to/config.json
```

The live smoke needs Chrome, Playwright MCP, and outbound network access. It opens a public page, captures in-memory evidence, and verifies that a loopback route is denied.

## License

MIT. See [LICENSE](LICENSE).
