# Realtime Recovery Transport Gateway (R2TG)

R2TG is a WebTransport gateway for low-latency state datagrams, reliable stream request/response traffic, SSE-like event frames, and optional security profiles.

## Runtime Defaults

- Bind host: `0.0.0.0`
- WebTransport endpoint: `https://<server-host>:4433/r2tg`
- Production API routes: `GET /health`, `GET /state`
- Production event topics: `heartbeat`, `state`
- Demo routes are disabled unless `R2TG_ENABLE_DEMO_ROUTES=1`
- Browser client serving is disabled unless `R2TG_SERVE_CLIENT=1`
- Message size and stream pending-buffer limits are always configured
- Incomplete FEC groups are flushed by the gateway maintenance loop
- Token auth is enabled only when `R2TG_AUTH_SECRET` is set

## Scripts

```powershell
npm run cert:local
npm run auth:token
npm run check
npm test
npm run verify
npm start
```

Local testing can use `npm run cert:local`. Production should provide trusted TLS files through `R2TG_TLS_CERT` and `R2TG_TLS_KEY`.

## Local Run

```powershell
npm run cert:local
$env:R2TG_SERVE_CLIENT="1"
npm start
```

If token auth is required:

```powershell
$env:R2TG_AUTH_SECRET="use-a-long-random-secret"
npm run auth:token -- --subject=browser-client --scope=api,events --ttl=3600
npm start
```

Browser usage:

```js
import { R2TGClient } from "/r2tg-client.js";

const client = new R2TGClient({
  authToken: "PASTE_R2TG_TOKEN_HERE"
});

await client.connect();
const health = await client.get("/health");
client.close();
```

For local self-signed certificate testing, pass `serverCertificateHashBase64`. For production with a trusted certificate, omit it.

## Security Profiles

`R2TG_SECURITY_PROFILE` supports:

- `open`: local/dev profile. Size limits stay on; auth/rate/scope/replay/HMAC are optional.
- `basic`: default profile. Size limits and gentle rate limit are on.
- `controlled`: requires `R2TG_AUTH_SECRET`, enables scope enforcement and replay protection.
- `strict`: requires auth, origin allowlist, and frame HMAC secret.

See [.env.example](.env.example) and [docs/auth.md](docs/auth.md).

## Maintenance

R2TG starts a lightweight gateway maintenance loop with the server. It periodically calls FEC timeout cleanup so incomplete recovery groups do not stay in memory during long-running operation. Set `R2TG_FEC_FLUSH_INTERVAL_MS` to tune the interval when needed.

## Deployment Notes

Keep these out of runtime source packages:

- `node_modules/`
- `.git/`
- `.agents/`
- `certs/*.key`, `certs/*.crt`, `certs/*.pem`, `certs/*.json`
- `test/`
- local `.env` files

Runtime install should use the committed lock file:

```powershell
npm ci --omit=dev
npm start
```

See [docs/architecture.md](docs/architecture.md), [docs/protocol.md](docs/protocol.md), [docs/api-flow.md](docs/api-flow.md), [docs/client-library.md](docs/client-library.md), [docs/auth.md](docs/auth.md), and [docs/test-plan.md](docs/test-plan.md).
