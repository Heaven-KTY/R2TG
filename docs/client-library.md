# R2TG Browser Client Library

The browser client library is a single ES module:

```text
/r2tg-client.js
```

The server serves it only when explicitly enabled:

```powershell
$env:R2TG_SERVE_CLIENT="1"
npm start
```

When the module is imported from the R2TG server, `R2TGClient` derives the WebTransport endpoint from that origin plus `/r2tg`.

## Basic Usage

```js
import { R2TGClient } from "/r2tg-client.js";

const client = new R2TGClient({
  authToken: "PASTE_R2TG_TOKEN_HERE"
});

await client.connect();
const health = await client.get("/health");
console.log(health.response.data);
client.close();
```

Override the endpoint only when the module and WebTransport endpoint are hosted separately:

```js
const client = new R2TGClient({
  url: "https://r2tg.example.com/r2tg",
  authToken: "PASTE_R2TG_TOKEN_HERE"
});
```

## Local Certificate Hash

For local self-signed certificate testing only:

```js
const client = new R2TGClient({
  authToken: "PASTE_R2TG_TOKEN_HERE",
  serverCertificateHashBase64: "LOCAL_CERT_HASH_BASE64"
});
```

Production with a trusted HTTPS certificate does not need `serverCertificateHashBase64`.

## API Requests

Production routes:

```js
const health = await client.get("/health");
const state = await client.get("/state");
const deviceState = await client.get("/state", {
  device_id: "main-controller-01"
});
```

Demo routes are available only when `R2TG_ENABLE_DEMO_ROUTES=1`:

```js
await client.get("/test");
await client.post("/echo", { message: "hello-r2tg" });
await client.post("/command", {
  command_id: "cmd-000001",
  command: "STOP"
});
```

Each API call returns:

```js
{
  request,
  response,
  latencyMs,
  timings,
  bytes,
  format,
  streamMode
}
```

## SSE-like Events

R2TG events are compact frames on the persistent WebTransport stream, not HTTP `text/event-stream`.

```js
const subscription = await client.subscribe("heartbeat", (event) => {
  console.log(event.topic, event.data);
}, {
  intervalMs: 1000
});

await subscription.unsubscribe();
```

Production topics are `heartbeat` and `state`. Demo topic `hello` is available only when `R2TG_ENABLE_DEMO_ROUTES=1`.

## Strict Frame HMAC

Frame HMAC is off by default. If the server enables strict frame HMAC, the browser client can sign stream frames:

```js
const client = new R2TGClient({
  authToken: "PASTE_R2TG_TOKEN_HERE",
  frameHmacSecret: "SEPARATE_FRAME_HMAC_SECRET"
});
```

Do not reuse `R2TG_AUTH_SECRET` as `frameHmacSecret`.

## Client Options

```js
const client = new R2TGClient({
  url: undefined,
  serverCertificateHashBase64: "",
  authToken: "",
  frameHmacSecret: "",
  requestTimeoutMs: 5000,
  packetFormat: "compact",
  streamMode: "persistent",
  warmupStreamOnConnect: true
});
```

- `url`: optional WebTransport endpoint override. Defaults to the module origin plus `/r2tg`.
- `serverCertificateHashBase64`: local self-signed certificate hash.
- `authToken`: short-lived R2TG bearer token.
- `frameHmacSecret`: optional strict-profile frame signing secret.
- `requestTimeoutMs`: API response timeout.
- `packetFormat`: `compact` by default.
- `streamMode`: `persistent` by default.
- `warmupStreamOnConnect`: opens the persistent stream during `connect()`.
