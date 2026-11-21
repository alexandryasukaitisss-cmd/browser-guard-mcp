# Security policy

## Report a problem

Do not open a public issue for a vulnerability. Use GitHub's private
[security advisory](https://github.com/alexandryasukaitisss-cmd/browser-guard-mcp/security/advisories/new)
form, or contact the maintainer through the address on the GitHub profile.

Include:

- the guard version and commit;
- the host operating system, Node version, Chrome version, and Playwright MCP version;
- the smallest configuration and sequence that reproduces the issue;
- the observed result and the result you expected;
- whether the issue crosses the documented boundary in `README.md` or `docs/threat-model.md`.

Do not include live cookies, credentials, private page content, or confirmation IDs. Redact them before sending. A synthetic reproduction is more useful than a real secret.

## Scope

In scope:

- bypass of the URL, DNS, or egress-proxy checks for a public navigation target;
- a forbidden operation reaching the browser;
- a sensitive-input action that dispatches without a valid one-use confirmation;
- a secret file that the upload check should block but does not;
- a ledger entry that contains a URL, page text, argument, credential, or confirmation ID;
- an evidence bundle that outlives its grant or is written to a guard-managed file.

Out of scope by design:

- a Chromium or Playwright engine vulnerability (report it upstream);
- a malicious public page that misleads the agent;
- a field with an unusual label that the heuristic does not classify as sensitive;
- the absence of operating-system isolation;
- side channels outside HTTP(S) proxying, such as WebRTC or QUIC.

## Response

The maintainer will acknowledge a report, reproduce it, and publish a fix and advisory when the issue is confirmed. This is a single-maintainer project; no bounty is offered.
