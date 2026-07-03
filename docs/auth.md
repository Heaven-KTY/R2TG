# R2TG Security And Token Auth

`serverCertificateHashBase64` is not an API secret. It only helps browsers verify a local self-signed WebTransport certificate. API and event access control is handled by token auth and optional security profiles.

## Token Auth

Set a signing secret before starting the server:

```powershell
$env:R2TG_AUTH_SECRET="use-a-long-random-secret"
npm start
```

Generate a short-lived token:

```powershell
$env:R2TG_AUTH_SECRET="use-a-long-random-secret"
npm run auth:token -- --subject=browser-client --scope=api,events --ttl=3600
```

Use the `token` field in the browser client:

```js
const client = new R2TGClient({
  authToken: "PASTE_TOKEN_HERE"
});
```

When `R2TG_AUTH_SECRET` is set, API, event, and datagram traffic must authenticate first.

## Scopes

Scopes are enforced when `R2TG_ENFORCE_SCOPE=1`, or by the `controlled` and `strict` profiles.

Default scopes:

- `api`: `GET /health`, `GET /state`
- `events`: `heartbeat`, `state`
- `control`: demo `/command`
- `admin`: bypasses individual scope checks

Insufficient scope returns `403 insufficient_scope`.

## Security Profiles

```text
open       size limits only; other controls optional
basic      size limits + gentle rate limit
controlled auth required, scope enforcement, replay protection
strict     controlled + origin allowlist + frame HMAC
```

`controlled` and `strict` require `R2TG_AUTH_SECRET`.

`strict` also requires:

```powershell
$env:R2TG_ORIGIN_ALLOWLIST="https://app.example.com"
$env:R2TG_FRAME_HMAC_SECRET="use-a-separate-frame-hmac-secret"
```

Do not reuse `R2TG_AUTH_SECRET` as the frame HMAC secret.

## Wire Format

Auth request:

```json
{
  "t": "auth",
  "id": "req-000001",
  "token": "r2tg1..."
}
```

Successful response:

```json
{
  "t": "api_res",
  "id": "req-000001",
  "o": true,
  "s": 200,
  "d": {
    "authenticated": true,
    "subject": "browser-client",
    "scope": ["api", "events"],
    "expires_at": "2026-07-02T01:00:00.000Z"
  }
}
```

The token format is `r2tg1.<payload>.<signature>`. The payload uses compact JSON keys, is encoded with base64url, and is signed with HMAC-SHA256. Tokens are transported inside the already encrypted WebTransport/TLS session.

## Built-In Protections

- Datagram byte limit before JSON parsing
- Stream frame byte limit
- Pending stream buffer byte limit
- Optional per-session rate limit
- Optional token scope enforcement
- Optional command/control replay protection by `command_id`
- Optional frame HMAC for strict deployments
- Optional origin allowlist at WebTransport handshake and client library CORS
