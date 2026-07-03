# API-like Flow over WebTransport

R2TG separates real-time state traffic from API-like request traffic.

```text
State / sensor / monitor values
  -> WebTransport Datagram

API-like request / response
  -> WebTransport Bidirectional Stream

SSE-like server push events
  -> Same persistent WebTransport Bidirectional Stream
```

## Session Order

When `R2TG_AUTH_SECRET` is set:

```text
WebTransport ready
  -> client opens persistent stream
  -> auth frame
  -> API / event frames
  -> datagrams accepted
```

Unauthenticated API/event frames receive `401 auth_required`. Unauthenticated datagrams are dropped.

## Compact API Request

```json
{
  "t": "api",
  "id": "req-000001",
  "m": "GET",
  "r": "/health"
}
```

With query params:

```json
{
  "t": "api",
  "id": "req-000002",
  "m": "GET",
  "r": "/state",
  "q": {
    "device_id": "main-controller-01"
  }
}
```

With body:

```json
{
  "t": "api",
  "id": "req-000003",
  "m": "POST",
  "r": "/command",
  "b": {
    "command_id": "cmd-000001",
    "command": "STOP"
  }
}
```

## Compact API Response

```json
{
  "t": "api_res",
  "id": "req-000001",
  "o": true,
  "s": 200,
  "d": {
    "ok": true
  }
}
```

## Production Routes

- `GET /health`
- `GET /state`
- `GET /state?device_id=:deviceId`

## Demo Routes

Only registered when `R2TG_ENABLE_DEMO_ROUTES=1`:

- `GET /test`
- `POST /echo`
- `POST /command`

The demo `/command` route is replay-protected when replay protection is enabled and requires `command_id`.

## Events

Subscribe:

```json
{
  "t": "sub",
  "id": "req-000004",
  "topic": "heartbeat",
  "interval_ms": 1000
}
```

Event:

```json
{
  "t": "evt",
  "topic": "heartbeat",
  "event": "message",
  "id": "heartbeat-1",
  "ts": 1782790000010,
  "d": {
    "sequence": 1,
    "timestamp": 1782790000010,
    "iso_time": "2026-07-02T00:00:00.010Z"
  }
}
```

Unsubscribe:

```json
{
  "t": "unsub",
  "id": "req-000005",
  "topic": "heartbeat"
}
```

Production topics are `heartbeat` and `state`. Demo topic `hello` is registered only when `R2TG_ENABLE_DEMO_ROUTES=1`.

## Security Controls

The stream handler applies:

- max frame size
- max pending buffer size
- stream frame rate limit
- token auth
- optional frame HMAC
- optional scope enforcement
- optional replay protection

Datagram handling applies:

- max datagram size before JSON parse
- datagram rate limit
- token auth gate
- optional frame HMAC
- CRC/FEC validation
