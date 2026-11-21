# Design

## One backend

Version 0.1 uses one browser backend: Playwright MCP driving an isolated headless Chrome. Earlier private iterations routed between a lightweight reader and Chrome. That split was useful for the author's local setup, but it made the public first run depend on a second, non-public binary.

The public cut keeps the capability model and drops backend selection. `browser_route_open` still accepts `intent` because it describes the task and appears in the audit ledger; it no longer chooses a different engine.

## Process shape

```text
MCP client
  -> src/cli.cjs (stdio server)
     -> BrowserGuard
        -> CapabilityPolicy
        -> PublicEgressProxy
        -> McpChildClient -> Playwright MCP -> Chrome
```

The guard is a stdio MCP server. It opens no network port except the loopback proxy, which listens on `127.0.0.1` with an ephemeral port.

## Request path

1. `browser_route_open` validates the URL statically, checks the active grant for `navigate`, starts the proxy and Chrome, and calls `browser_navigate`.
2. The proxy resolves the hostname and rejects non-public addresses before opening a socket.
3. Chrome loads the page through the proxy. Redirects and subresources re-enter the same proxy.
4. `browser_route_call` checks that the tool exists on the backend and is in the operation map, re-reads the accessibility snapshot for interactive calls, authorizes the capability, validates uploads, and dispatches.
5. After interactive calls the guard re-reads the snapshot and updates the active URL, so a click-driven redirect cannot leave the guard pointing at the previous origin.
6. Every call writes one enumerated ledger entry, including failures.

## Capability grants

A grant is created when a profile is activated. It contains the profile id, allowed host patterns, allowed operations, an expiry, and a random id. The default profile is activated at process start. Grants are held in memory. A new activation replaces the active grant; an open page adopts the new grant id.

The egress proxy asks the guard whether a host is allowed under the pending or active grant. This is why a profile applies to redirects and subresources, not only to the first URL.

## Confirmation

`browser_action_prepare` computes the argument digest before awaiting the native dialog. The confirmation stores the grant id, exact origin, tool, digest, sensitivity flag, and expiry. `browser_route_call` consumes the confirmation once and checks every bound field. A changed argument, origin, tool, grant, or a reused id fails closed.

## Evidence

`EvidenceStore` keeps at most eight bundles, each bounded to 32,000 characters of snapshot and markdown, 50 links, 50 interactive entries, and 25 console entries. A bundle expires no later than the grant. `content_hash` hashes the markdown if present, otherwise the snapshot.

## Ledger

`CompatibilityLedger` rewrites an atomically replaced JSONL file with at most 200 entries and mode `0600`. Each entry is built from allow-listed fields. Unknown values fall back to a safe enum. Uploads add only a file count.

## Deliberate omissions

- No direct `browser_*` tools. A direct tool surface would bypass capability checks.
- No `browser_evaluate`, `browser_run_code_unsafe`, cookies, storage, tabs, network inspection, screenshots, or downloads.
- No persistent Chrome profile. Persistent cookies would turn the guard into a session-bearing browser.
- No second backend. One supported path keeps the public configuration reproducible.
- No attempt to be an OS sandbox. The README and threat model say so explicitly.
