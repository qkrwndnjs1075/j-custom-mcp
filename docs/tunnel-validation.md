# Cloudflare Tunnel and VOOY validation

Observed on 2026-10-25 (Asia/Seoul).

Public endpoint: https://downloaded-improving-compensation-customise.trycloudflare.com/mcp

The current VOOY account connection uses the same origin at `/mcp/account`.

The actual `src/index.ts` application runs in Terminal on 127.0.0.1:8787.
A second Terminal process runs Cloudflare Quick Tunnel. The application uses
the public HTTPS origin for MCP_BASE_URL and includes its hostname in
MCP_ALLOWED_HOSTS. GO_APP_RESOURCES points to the locally prepared resource XML;
its contents were not printed.

## Verified

- Cloudflare registered a QUIC tunnel connection at the icn06 edge.
- Public `/health`: HTTP 200, `status: ok`.
- OAuth resource and authorization-server metadata: HTTP 200, public HTTPS URLs.
- MCP `initialize`: HTTP 200, server `tmoney-go-bus` version 0.1.0.
- MCP `tools/list`: HTTP 200, 17 tools.
- Public `get_service_capabilities`: HTTP 200 with a tool result.
- Unauthenticated `list_tickets`: HTTP 401 with the public OAuth resource metadata challenge.
- `/connect`: HTTP 200 with the account connection form.
- VOOY service connections UI: `tmoney-go-bus`, 17 tools, connected. Settings
  showed all 17 tool checkboxes enabled. The UI reports compatibility adjustments
  to tool schemas; private and financial execution were not tested.

Screenshot inspected:
`/Users/park/.aside/u/0/sessions/2026-10-25_evsQ8g1v7ijTtwfy/tmp/tmoney-go-status.webp`

## Remaining boundaries

The initial public discovery did not trigger GO authentication. Later verification
through `/mcp/account` completed GO authentication and VOOY OAuth code exchange,
with no manual token entry. VOOY reported connected/ready, and the user observed
a successful list_requests result with 0 watches and 0 automatic booking requests.
See `docs/vooy-oauth-diagnosis.md` for that subsequent verification.
No seat hold, booking, payment, cancellation, or chat message ran in this check.
The previous user-authenticated payment handoff and push-notification gaps remain.

This is a temporary Quick Tunnel. Keep both Terminal processes running and the
Mac awake with network access. Restarting the tunnel produces a new endpoint
that must be reflected in the application configuration and VOOY connection.
