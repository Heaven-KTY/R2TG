# R2TG Architecture

## Project Name

Realtime Recovery Transport Gateway (R2TG)

## Goal

R2TG separates fast state transport from reliable command transport:

```text
Browser UI
  <-> WebTransport
R2TG Node.js Gateway
  <-> UDP/TCP/Serial/CAN/Modbus/Internal API
Device, MCU, controller, inverter, sensor module
```

## Channel Policy

Datagram channel:

- Real-time state values.
- Sensor values.
- Monitoring values.
- Values where the newest value is more important than every historical value.
- Loss-tolerant traffic with optional FEC recovery.

Stream channel:

- Commands.
- ACK responses.
- Settings.
- Ordered logs.
- Safety-related or result-bearing events.

## Initial Browser Scope

The first target is Chrome and Edge. Firefox, Safari, and WebSocket fallback are not part of the first required implementation.

## Runtime Decision

The WebTransport server boundary is designed around `@fails-components/webtransport`.

Reasons:

- It provides Node.js WebTransport server classes, including HTTP/3 support.
- The package documentation exposes `HttpServer`, `Http3Server`, and `Http2Server` choices.
- The HTTP/3 QUIC transport is split into an additional package, so the core project can remain testable before runtime installation.

The gateway core is isolated from the runtime. If the WebTransport library changes later, only the adapter should need to change.

## First Implementation Slice

This repository now starts with:

- `src/core`: protocol, CRC, FEC, and state cache logic.
- `src/server`: gateway orchestration and WebTransport adapter scaffold.
- `src/client`: browser client helper scaffold.
- `test`: protocol and recovery tests.

## Certificate Policy

WebTransport requires a secure context. Local development should use either a trusted local certificate or browser-supported certificate hash handling. Production must use normal HTTPS certificates with HTTP/3 support.
