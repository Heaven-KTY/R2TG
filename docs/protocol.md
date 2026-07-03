# R2TG Protocol

## Datagram Packet

Datagram packets carry state-like values. They include sequence, timestamp, payload length, padding length, and CRC.

```json
{
  "version": 1,
  "project": "R2TG",
  "channel": "datagram",
  "message_type": "state",
  "device_id": "main-controller-01",
  "group_id": 10001,
  "seq": 50001,
  "index": 0,
  "total": 4,
  "fec_type": "xor",
  "timestamp": 1780000000000,
  "payload_length": 64,
  "padded_length": 80,
  "padding_type": "zero",
  "payload": {
    "temperature": 72.5,
    "rpm": 1200
  },
  "crc": "83f39a2a"
}
```

The CRC is calculated over stable JSON bytes of the payload, not over the full packet.

## XOR Parity Packet

The parity packet carries metadata required to recover one missing packet. The base document defines `payload_length` and `padded_length`; this implementation also stores `payload_lengths`, `payload_crcs`, and `seq_start` in the parity packet so the receiver can rebuild metadata when the missing packet itself is lost.

```json
{
  "version": 1,
  "project": "R2TG",
  "channel": "datagram",
  "message_type": "fec_parity",
  "device_id": "main-controller-01",
  "group_id": 10001,
  "seq": 50005,
  "seq_start": 50001,
  "index": 4,
  "total": 4,
  "fec_type": "xor",
  "parity_for": "state",
  "timestamp": 1780000000000,
  "payload_length": 80,
  "padded_length": 80,
  "padding_type": "zero",
  "payload_lengths": [64, 63, 65, 64],
  "payload_crcs": ["...", "...", "...", "..."],
  "parity_base64": "...",
  "crc": "..."
}
```

## Recovery Rule

For a group of `D1, D2, D3, D4 + P1`:

```text
P1 = D1 XOR D2 XOR D3 XOR D4
D2 = D1 XOR D3 XOR D4 XOR P1
```

Rules:

- All XOR inputs are padded to the same `padded_length` with `0x00`.
- Only one missing original packet can be recovered with XOR parity.
- Recovered bytes are sliced by the original `payload_length`.
- CRC is checked again after recovery.
- If recovery fails or the FEC timeout expires, the group is dropped.
- No retransmission request is made for state Datagram traffic.

## Stream Packet

Stream packets carry reliable messages.

```json
{
  "version": 1,
  "project": "R2TG",
  "channel": "stream",
  "message_type": "command",
  "command_id": "cmd-000001",
  "device_id": "main-controller-01",
  "command": "START",
  "params": {
    "mode": "auto"
  },
  "timestamp": 1780000000000
}
```

Every command must receive an ACK or failure response.

```json
{
  "version": 1,
  "project": "R2TG",
  "channel": "stream",
  "message_type": "ack",
  "command_id": "cmd-000001",
  "device_id": "main-controller-01",
  "ok": true,
  "timestamp": 1780000000100
}
```

## Compact API Stream Frame

API-like request/response traffic can use a compact JSON frame on a persistent bidirectional stream. Fields that are already implied by the WebTransport stream, such as `project`, `channel`, `message_type`, and `timestamp`, are omitted from the compact wire format.

Request:

```json
{
  "t": "api",
  "id": "req-000001",
  "m": "GET",
  "r": "/health"
}
```

Response:

```json
{
  "t": "api_res",
  "id": "req-000001",
  "o": true,
  "s": 200,
  "d": {}
}
```

Compact keys:

- `t`: frame type, `api` or `api_res`
- `id`: request id
- `m`: request method
- `r`: request resource
- `q`: optional request params
- `b`: optional request body
- `o`: response ok flag
- `s`: response status
- `d`: optional response data
- `e`: optional response error

## SSE-like Event Frame

Server push events are sent over the same persistent WebTransport bidirectional stream as compact API frames. They are not HTTP `text/event-stream`; they are R2TG event frames.

Subscribe:

```json
{
  "t": "sub",
  "id": "req-000001",
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
  "ts": 1780000000100,
  "d": {
    "sequence": 1,
    "timestamp": 1780000000100,
    "iso_time": "2026-07-02T00:00:00.100Z"
  }
}
```

Unsubscribe:

```json
{
  "t": "unsub",
  "id": "req-000002",
  "topic": "heartbeat"
}
```

Event frame keys:

- `sub`: subscribe control frame
- `unsub`: unsubscribe control frame
- `evt`: server push event frame
- `topic`: event channel, such as `heartbeat` or `state`
- `event`: event name
- `id`: event id
- `ts`: event timestamp
- `d`: event data
