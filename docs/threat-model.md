# Threat model

## Assets

1. The user's authenticated browser sessions, cookies, saved passwords, and extensions.
2. The local network and services reachable from the host.
3. Files outside the selected upload set.
4. Page content and evidence that may contain private data.
5. The integrity of the audit record.

## Trust boundaries

```text
MCP client / agent
        |
        |  nine guard tools, allow-listed operations
        v
Browser Guard MCP (Node process)
        |
        |  capability profile + URL/DNS checks
        v
Loopback egress proxy  ---> public HTTP(S) only
        |
        v
Isolated Chromium (Playwright MCP, private profile)
```

The agent is untrusted. It may be confused, prompt-injected by page content, or simply wrong. Page content is untrusted. The guard treats both as inputs to policy, never as authority.

## What the guard guarantees

- A navigation target must be an absolute, credential-free HTTP(S) URL on port 80 or 443.
- Literal private, loopback, link-local, multicast, and special-use addresses are rejected before the browser starts.
- Chromium uses the loopback proxy for HTTP(S). The proxy resolves the hostname, rejects non-public results, reapplies the active capability host patterns, and forwards only standard web ports.
- Redirects and subresources use the same proxy.
- Chromium starts with an isolated profile, no storage state, no service workers, and a minimal environment.
- Only the allow-listed operations reach the browser.
- A card, password, or one-time-code entry needs a one-use approval bound to the grant, origin, tool, and exact arguments.
- Known secret files are rejected before an upload reaches the browser.
- Evidence lives in process memory and expires with the grant.
- The ledger records enumerated fields only.

## Non-goals and residual risk

### Browser-engine compromise

Chromium is not sandboxed by this project beyond its normal process model. A renderer exploit can reach anything the user can reach. Use a dedicated OS account or a disposable machine for hostile pages.

### Content trust

A public page can phish, mislead, or prompt-inject the agent. The guard limits reachability, not meaning. The agent must still treat page text as untrusted data.

### Network side channels

The proxy covers HTTP(S). It does not prove that no other protocol or browser feature can contact a local service. WebRTC, QUIC, DNS prefetch, and browser bugs are outside the guarantee. The guard disables service workers and loads no extensions, which removes common persistence paths, not every path.

### Sensitive-field heuristic

Detection uses the accessibility snapshot and the arguments the agent supplies. A field labeled “Verification code” without a matching token, or a custom widget with no accessible name, may not be classified. The dialog is a guard against accidental entry, not a DLP control. Do not give the agent real card data.

### Upload inspection

The upload check resolves paths and blocks known secret locations and filename patterns. It does not inspect file contents. A renamed copy of a secret outside those locations can pass.

### Isolated profile

There is no existing login. Sites that require the user's session will not work. This is deliberate: sharing the desktop browser would inherit its cookies and extensions.

### Native dialog

The confirmation uses `osascript` on macOS. On other systems it cannot be shown, so sensitive input is denied. The dialog text names the site and the scope. It does not prove that the page is honest.

### Logs

The guard's ledger is content-free. Chromium, Playwright, and the operating system keep their own logs and crash data outside this project's control. The transient Playwright output directory is removed on close, but a crash can leave files behind.

## Abuse cases considered

| Attempt | Result |
| --- | --- |
| Navigate to `http://127.0.0.1` | `NETWORK_DENIED` before browser |
| Navigate to a public hostname resolving to `127.0.0.1` | Egress proxy rejects; browser reports a tool failure |
| Navigate to `https://example.com:8443` | `NETWORK_DENIED` |
| Use `user:pass@example.com` | `NETWORK_DENIED` |
| Call `browser_evaluate` | `TOOL_DENIED` |
| Read cookies or storage | `TOOL_DENIED` |
| Click without an interact profile | `CAPABILITY_DENIED` |
| Type a password without approval | `CONFIRMATION_REQUIRED` |
| Reuse an approval ID | `CONFIRMATION_DENIED` |
| Upload `~/.ssh/id_ed25519` | `UPLOAD_SECRET_DENIED` |
| Read a ledger entry for a URL | No URL is stored |
| Read evidence after the grant expires | Bundle is gone |
