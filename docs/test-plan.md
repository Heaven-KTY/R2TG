# R2TG Test Plan

## Core Protocol Tests

- CRC32 is deterministic and catches payload changes.
- Datagram packets include `project: "R2TG"`.
- Stable JSON encoding keeps CRC independent of object key order.
- Old `seq` values are rejected by State Cache.
- Expired timestamps are rejected by State Cache.

## FEC Tests

- `D1..D4 + P1` recovers any single missing original packet.
- Two missing packets fail recovery.
- Padding is removed using `payload_length`.
- CRC is rechecked after recovery.
- FEC timeout drops incomplete groups.
- Gateway maintenance periodically flushes timed out incomplete FEC groups.
- Gateway maintenance avoids duplicate intervals and stops cleanly.

## Runtime Tests

- Chrome connects to the WebTransport server over HTTPS.
- Edge connects to the WebTransport server over HTTPS.
- Datagram receive path updates State Cache.
- Stream command receives ACK.
- Device disconnect marks cache entries stale or disconnected.

## Security Tests

- Token creation and verification.
- Expired and tampered tokens are rejected.
- Production routes do not register demo routes by default.
- Token scope enforcement rejects missing scopes.
- Replay protection rejects duplicate `command_id` values.
- Message size limits are present in every security profile.
- Rate limit rejects frames after the configured threshold.
- Frame HMAC rejects unsigned frames when enabled.
- Origin allowlist rejects unknown origins.

## Performance Tests

- Start at 100 ms state period.
- Measure 50 ms period after phase 2 is stable.
- Measure 20 ms period only after packet rate, FEC overhead, and UI rendering delay are visible in metrics.
