# Cloudflare Workers: joowon-custom-mcp

The Worker serves the existing MCP on `/mcp` and the protected account endpoint
on `/mcp/account`. Browser account connection remains at `/connect`. Callers
connect their own GO account; the local server's accounts and financial jobs are
not imported into the new deployment.

## Runtime and persistence

The forwarding Worker routes to one SQLite-backed `TmoneyApplication` Durable
Object. That object runs the existing provider, OAuth, watch, booking and
cancellation services. This is a small personal deployment: all users share one
execution object, with separate database namespaces and account ownership checks.
The design does not claim horizontal scaling across multiple execution objects.

The Worker's fetch handler is placed near `aws:ap-northeast-2`. The existing
Durable Object is not recreated or relocated. Its KOBUS public queries use the
same Worker's `PROVIDER_TRANSPORT` service binding, so their HTTP requests run
through the placed fetch handler. HTML/JSON parsing stays in the Durable Object.
This uses one Worker deployment and adds no resident Mac process or external VM.
The internal transport accepts only the three public KOBUS query paths, strips
private headers, and rejects other destinations and oversized bodies. GO account,
payment and cancellation requests never pass through this public transport.

Account credentials use the existing authenticated encryption and key-fingerprint
checks. Login sessions, OAuth continuation bindings, short-lived trip/ticket
references and the scheduler queue are also encrypted before SQL storage.
Logical database namespaces preserve the former per-user SQLite file boundary.
SQL transactions and revision checks preserve one-time claims and token rotation.

Alarms run due watch/booking/reconciliation work without an always-running
process. Idle deployments have no recurring alarm. Every active HTTP/alarm event
retains a recovery wake-up, including while another request completes. Restarted
booking/cancellation runners preserve uncertain financial outcomes instead of
resending a payment or cancellation.

The local Bun entry (`pnpm start`) remains available. The deployed dependency
graph uses the `workerd` branch of `#local-runtime`, with no Bun or persistent
filesystem APIs. Upstream redirects are handled manually and rejected rather
than forwarding credentials to a redirected host.

## Local verification

Use Node 24, Bun and pnpm. The checked-in pnpm configuration permits only the
esbuild and workerd installation scripts required by Wrangler.

```sh
pnpm install
pnpm run check
pnpm test
pnpm run test:workers
```

The workerd tests execute the built production Worker with synthetic upstream
responses and isolated persistent storage. They cover OAuth/GO connection across
restart, account isolation, persisted trip/checkout references, key mismatch and
alarm execution. Financial crash tests use only synthetic state and requests.
They do not establish a new live payment or refund.

## Configuration and deployment

`wrangler.jsonc` names the Worker `joowon-custom-mcp` and creates only SQLite
Durable Objects, which are supported on Workers Free. It does not upgrade a plan.

Secrets:

- `GO_VAULT_KEY`: base64-encoded 32-byte encryption key. Keep it stable. Replacing
  this secret without migrating encrypted data makes the database unreadable.
- `GO_REFRESH_SALT`: the `crypt_key_salt` from the operator's decoded GO resource
  XML. Upload the value as a secret; never put the XML in the deployment bundle.

Optional variables:

- `MCP_BASE_URL`: public HTTPS origin. Without an explicit setting, the first
  request origin is persisted and used for subsequent OAuth/host validation.
  Changing an established origin requires updating client connections.
- `MCP_ALLOWED_ORIGINS`: comma-separated allowed browser hostnames; defaults to
  `app.vooy.com`, with the MCP's own hostname added by the application.
- `MCP_LIMITS`: existing service-limit JSON, including polling intervals and
  retained request counts. Provider polling defaults remain unchanged.

```sh
pnpm exec wrangler login
pnpm run deploy:worker
pnpm run setup:worker-secrets -- /absolute/path/to/resources/res/values/strings.xml
```

Create the Worker with the first deployment before initializing its secrets.
It is not usable until the required secrets have been uploaded. Later code
deployments preserve the existing secrets.

The secret setup reads the XML privately and pipes values to Wrangler. On first
initialization it retains a mode-0600 backup key at `data/worker-vault.key`.
Repeated setup preserves an existing remote vault-key secret. The `data/`
directory is ignored and is never bundled. Back up the key securely.

The public MCP URL has this form:

```text
https://joowon-custom-mcp.<account-subdomain>.workers.dev/mcp
```

Connect the client to `/mcp/account` when it needs OAuth from the initial
connection. Use `/mcp` for public discovery and queries with optional protected
tools. GO/Npay registration and a successful GO account connection remain
prerequisites for automatic purchases.

## Free-tier capacity

Workers Free currently includes 100,000 incoming requests/day, 10 ms CPU per
Worker request, 128 MB memory and 50 external subrequests per invocation.
Provider parsing and application execution occur in the Durable Object, rather
than in the forwarding Worker's short CPU budget. SQLite Durable Objects have
their own free compute/storage limits; alarms also count as requests. Watch
frequency, query size and user count must stay within these limits.

See the current official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
This architecture is free-compatible; it does not promise unlimited usage.

## Deployment verification, 2026-11-05

Deployed version: `b24c29cc-6e1f-49f2-99b8-25344e0c8c9e`.

- Public MCP: `https://joowon-custom-mcp.qkrwndnjs7308.workers.dev/mcp`
- OAuth-first account MCP: `https://joowon-custom-mcp.qkrwndnjs7308.workers.dev/mcp/account`
- The account dashboard showed Workers Free; no plan change was made.
- Live `/health`, MCP initialization, 17-tool discovery and OAuth issuer metadata
  passed. `/mcp/account` returned the expected HTTP401 resource-metadata challenge.
- Live 2026-11-06 queries found 10 intercity Seoul Nambu -> Seosan trips and
  28 express Central City -> Seosan trips. A seat query passed for each service.
- Live financial calls: zero. No local accounts or pending financial jobs were
  imported. The user must connect GO through the new MCP client's OAuth flow.
- Final checks passed: 1,132 Bun tests, 8 actual-workerd scenarios, both TypeScript
  configurations and lint. Six pre-existing informational lint diagnostics remain.
- Code review approved the final storage, recovery and regional transport
  boundaries. Temporary diagnostics and the raw request-metadata tail were removed.

The migration exposed three provider differences that synthetic business tests
alone could not prove: workerd requires a bound native fetch, the intercity
schedule endpoint requires an explicit User-Agent, and KOBUS timed out522 from
the original execution path. Identical KOBUS queries succeeded200 through the
placed fetch handler; the public-only service-binding transport preserves that
working path. This observation does not establish an origin firewall/TLS cause.
Actual-workerd regressions cover both providers and the transport's boundaries.

Local evidence: `.omo/evidence/worker-final/`,
`.omo/evidence/worker-alarms/`, `.omo/evidence/provider-parity/wire/`,
and `.omo/evidence/regional-public-fetch/`.

Production health, MCP tools and provider reachability must be checked on the
actual deployment. A successful local test or deployment upload alone does not
prove that a provider accepts Cloudflare's network, or that a user's GO account
has been connected on the new origin.
