import fs from "node:fs";
import crypto from "node:crypto";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiResponsePacket, createCompactApiResponsePacket } from "../core/stream.js";
import { readAuthConfig, verifyAuthToken } from "./authTokens.js";
import { R2TGGateway } from "./gateway.js";
import {
  consumeRateLimit,
  corsHeadersForOrigin,
  createSecurityRuntime,
  createSessionSecurityState,
  describeSecurityConfig,
  hasRequiredScope,
  checkReplay,
  originAllowed,
  readSecurityConfig,
  validateSecurityConfig,
  verifyFrameHmac
} from "./security.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const streamEncoder = new TextEncoder();
const MIN_EVENT_INTERVAL_MS = 100;
const MAX_EVENT_INTERVAL_MS = 60000;
const CLIENT_LIBRARY_MODULE_PATH = "/r2tg-client.js";
const COMPACT_AUTH_REQUEST = "auth";
const LONG_AUTH_REQUEST = "auth_request";

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

async function loadWebTransportRuntime() {
  try {
    const runtime = await import("@fails-components/webtransport");
    if (runtime.quicheLoaded) {
      await runtime.quicheLoaded;
    }
    return runtime;
  } catch (error) {
    throw new Error(
      "WebTransport runtime is not installed. Run npm install to fetch optional dependencies before npm start.",
      { cause: error }
    );
  }
}

function readTlsConfig() {
  const certPath = resolveProjectPath(process.env.R2TG_TLS_CERT ?? "certs/r2tg.local.crt");
  const keyPath = resolveProjectPath(process.env.R2TG_TLS_KEY ?? "certs/r2tg.local.key");

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(
      `TLS certificate files were not found. Run "npm run cert:local" or set R2TG_TLS_CERT/R2TG_TLS_KEY. Looked for ${certPath} and ${keyPath}.`
    );
  }

  return {
    cert: fs.readFileSync(certPath),
    privKey: fs.readFileSync(keyPath)
  };
}

function readFecFlushIntervalMs(env = process.env) {
  const rawValue = env.R2TG_FEC_FLUSH_INTERVAL_MS;
  if (!rawValue) {
    return undefined;
  }

  const interval = Number(rawValue);
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error("R2TG_FEC_FLUSH_INTERVAL_MS must be a positive number when set.");
  }

  return interval;
}

function createDatagramWriter(datagrams) {
  const writable = typeof datagrams.createWritable === "function"
    ? datagrams.createWritable()
    : datagrams.writable;
  return writable.getWriter();
}

function isNormalSessionClose(error) {
  const message = String(error?.message ?? error);
  return error?.name === "WebTransportError" &&
    (message === "Session closed" || (message.includes("Session closed") && message.includes("code 0")));
}

function logPipelineError(label, error) {
  if (isNormalSessionClose(error)) {
    return;
  }
  console.error(label, error);
}

function sendClientModuleLibrary(res, headers = {}) {
  const clientPath = resolveProjectPath("src/client/r2tg-client.js");
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-cache",
    "cross-origin-resource-policy": "cross-origin",
    ...headers
  });
  fs.createReadStream(clientPath).pipe(res);
}

function sendClientIndex(res) {
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>R2TG Client Library</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <h1>R2TG Client Library</h1>
  <p>ES module client: <a href="${CLIENT_LIBRARY_MODULE_PATH}">${CLIENT_LIBRARY_MODULE_PATH}</a></p>
  <pre>import { R2TGClient } from "./r2tg-client.js";

const client = new R2TGClient({
  // authToken: "PASTE_R2TG_TOKEN_HERE"
});

await client.connect();
const result = await client.get("/health");</pre>
</body>
</html>`;

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(body);
}

function startClientLibraryServer({ host, port, tls, securityConfig }) {
  const server = https.createServer({
    cert: tls.cert,
    key: tls.privKey
  }, (req, res) => {
    const url = new URL(req.url ?? "/", `https://${req.headers.host ?? `${host}:${port}`}`);
    const origin = req.headers.origin ?? "";
    const corsHeaders = corsHeadersForOrigin(securityConfig, origin);

    if (!corsHeaders && req.method === "OPTIONS") {
      res.writeHead(403, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-cache"
      });
      res.end(JSON.stringify({ ok: false, error: "origin_not_allowed" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders,
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "*"
      });
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, OPTIONS" });
      res.end();
      return;
    }

    if (url.pathname === CLIENT_LIBRARY_MODULE_PATH) {
      if (!corsHeaders && origin) {
        res.writeHead(403, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-cache"
        });
        res.end(JSON.stringify({ ok: false, error: "origin_not_allowed" }));
        return;
      }

      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-cache",
          "cross-origin-resource-policy": "cross-origin",
          ...(corsHeaders ?? {})
        });
        res.end();
        return;
      }
      sendClientModuleLibrary(res, corsHeaders ?? {});
      return;
    }

    if (url.pathname === "/") {
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache"
        });
        res.end();
        return;
      }
      sendClientIndex(res);
      return;
    }

    res.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache"
    });
    res.end(JSON.stringify({
      ok: false,
      error: "not_found",
      client: CLIENT_LIBRARY_MODULE_PATH
    }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") {
    return "";
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? "";
}

function createSessionRequestHandler({ path, securityConfig }) {
  return async ({ header }) => {
    const origin = headerValue(header, "origin");
    const requestPath = headerValue(header, ":path") || path;

    if (!originAllowed(securityConfig, origin)) {
      return {
        status: 403,
        path: requestPath
      };
    }

    return {
      status: 200,
      path: requestPath,
      header,
      userData: {
        origin: origin || null
      }
    };
  };
}

async function pipeDatagrams(session, gateway, authState) {
  const reader = session.datagrams.readable.getReader();
  const writer = createDatagramWriter(session.datagrams);

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    if (value.byteLength > authState.security.messageLimits.maxDatagramBytes) {
      continue;
    }

    const rate = consumeRateLimit(authState, "datagram");
    if (!rate.ok) {
      if (rate.action === "close") {
        break;
      }
      continue;
    }

    if (authState.config.enabled && !authState.authenticated) {
      continue;
    }

    let result;
    try {
      result = gateway.handleDatagramBytes(value, {
        auth: authState,
        security: authState.security
      });
    } catch {
      continue;
    }

    if (result.status === "ready" || result.status === "recovered") {
      await writer.write(gateway.snapshotBytes());
    }
  }
}

function streamPacketToBytes(packet) {
  return streamEncoder.encode(`${JSON.stringify(packet)}\n`);
}

function createStreamWriterQueue(writer) {
  let chain = Promise.resolve();

  return {
    write(packet) {
      if (!packet) {
        return chain;
      }
      chain = chain.then(() => writer.write(streamPacketToBytes(packet)));
      return chain;
    },
    close() {
      chain = chain.finally(() => writer.close());
      return chain;
    }
  };
}

async function writeStreamResponse(writer, packet) {
  if (packet) {
    await writer.write(packet);
  }
}

function isAuthPacket(packet) {
  return packet?.t === COMPACT_AUTH_REQUEST || packet?.message_type === LONG_AUTH_REQUEST;
}

function normalizeAuthPacket(packet) {
  return {
    compact: packet?.t === COMPACT_AUTH_REQUEST,
    requestId: packet?.id ?? packet?.request_id ?? "missing-request-id",
    token: packet?.token ?? ""
  };
}

function createControlResponse(control, { ok = true, status = 200, data = null, error = null }) {
  if (control.compact) {
    return createCompactApiResponsePacket({
      requestId: control.requestId,
      ok,
      status,
      data,
      error
    });
  }

  return createApiResponsePacket({
    requestId: control.requestId,
    ok,
    status,
    data,
    error,
    timestamp: Date.now()
  });
}

function createPacketControl(packet) {
  return {
    compact: Boolean(packet?.t),
    requestId: packet?.id ?? packet?.request_id ?? "missing-request-id"
  };
}

function createAuthRequiredResponse(packet) {
  return createControlResponse(createPacketControl(packet), {
    ok: false,
    status: 401,
    error: {
      code: "auth_required",
      message: "R2TG auth token is required"
    }
  });
}

function createSecurityErrorResponse(packet, result) {
  return createControlResponse(createPacketControl(packet), {
    ok: false,
    status: result.status ?? 400,
    error: result.error ?? {
      code: "security_error",
      message: "R2TG security check failed"
    }
  });
}

function createAuthResponse(control, verification) {
  const claims = verification.claims ?? {};
  return createControlResponse(control, {
    ok: verification.ok,
    status: verification.status,
    data: verification.ok
      ? {
          authenticated: true,
          subject: claims.sub ?? null,
          scope: claims.scope ?? [],
          expires_at: Number.isFinite(claims.exp) ? new Date(claims.exp * 1000).toISOString() : null
        }
      : null,
    error: verification.ok ? null : verification.error
  });
}

async function handleAuthPacket(packet, authState, writer) {
  const control = normalizeAuthPacket(packet);

  if (!authState.config.enabled) {
    authState.authenticated = true;
    await writeStreamResponse(writer, createControlResponse(control, {
      status: 200,
      data: {
        authenticated: true,
        disabled: true
      }
    }));
    return;
  }

  const verification = verifyAuthToken(control.token, {
    secret: authState.config.secret
  });

  if (verification.ok) {
    authState.authenticated = true;
    authState.claims = verification.claims;
  }

  await writeStreamResponse(writer, createAuthResponse(control, verification));
}

function isEventSubscribePacket(packet) {
  return packet?.t === "sub" || packet?.message_type === "event_subscribe";
}

function isEventUnsubscribePacket(packet) {
  return packet?.t === "unsub" || packet?.message_type === "event_unsubscribe";
}

function normalizeEventControlPacket(packet) {
  const compact = packet?.t === "sub" || packet?.t === "unsub";
  const intervalMs = Number(packet.interval_ms ?? packet.intervalMs ?? 1000);

  return {
    compact,
    requestId: packet.id ?? packet.request_id ?? "missing-request-id",
    topic: String(packet.topic ?? packet.resource ?? "heartbeat"),
    intervalMs: clamp(Number.isFinite(intervalMs) ? intervalMs : 1000, MIN_EVENT_INTERVAL_MS, MAX_EVENT_INTERVAL_MS)
  };
}

function createEventControlResponse(control, { ok = true, status = 200, data = null, error = null }) {
  return createControlResponse(control, { ok, status, data, error });
}

function stopEventSubscription(topic, subscriptions) {
  const subscription = subscriptions.get(topic);
  if (!subscription) {
    return false;
  }

  clearInterval(subscription.timer);
  subscriptions.delete(topic);
  return true;
}

function stopAllEventSubscriptions(subscriptions) {
  for (const subscription of subscriptions.values()) {
    clearInterval(subscription.timer);
  }
  subscriptions.clear();
}

function startEventSubscription(control, gateway, writer, subscriptions) {
  stopEventSubscription(control.topic, subscriptions);

  const subscription = {
    topic: control.topic,
    intervalMs: control.intervalMs,
    seq: 0,
    timer: null
  };

  const emit = () => {
    subscription.seq += 1;
    const eventId = `${control.topic}-${subscription.seq}`;
    const eventFrame = gateway.eventRouter.createEventFrame({
      topic: control.topic,
      eventId,
      seq: subscription.seq
    });
    writer.write(eventFrame).catch(() => {
      stopEventSubscription(control.topic, subscriptions);
    });
  };

  subscription.timer = setInterval(emit, control.intervalMs);
  subscriptions.set(control.topic, subscription);

  return {
    emit,
    data: {
      subscribed: true,
      topic: control.topic,
      interval_ms: control.intervalMs
    }
  };
}

async function handleEventSubscribe(packet, gateway, writer, subscriptions, authState) {
  const control = normalizeEventControlPacket(packet);
  const route = gateway.eventRouter.get(control.topic);

  if (!route) {
    await writeStreamResponse(writer, createEventControlResponse(control, {
      ok: false,
      status: 404,
      data: {
        topics: gateway.eventRouter.describeTopics()
      },
      error: {
        code: "event_topic_not_found",
        message: `event topic "${control.topic}" is not registered`
      }
    }));
    return;
  }

  if (
    authState.security.tokenAuth.enforceScope &&
    route.scope &&
    !hasRequiredScope(authState.claims, route.scope)
  ) {
    await writeStreamResponse(writer, createEventControlResponse(control, {
      ok: false,
      status: 403,
      error: {
        code: "insufficient_scope",
        message: `event topic "${control.topic}" requires scope ${route.scope}`
      }
    }));
    return;
  }

  const subscription = startEventSubscription(control, gateway, writer, subscriptions);

  await writeStreamResponse(writer, createEventControlResponse(control, {
    status: 200,
    data: subscription.data
  }));

  subscription.emit();
}

async function handleEventUnsubscribe(packet, writer, subscriptions) {
  const control = normalizeEventControlPacket(packet);
  const unsubscribed = stopEventSubscription(control.topic, subscriptions);

  await writeStreamResponse(writer, createEventControlResponse(control, {
    status: 200,
    data: {
      unsubscribed,
      topic: control.topic
    }
  }));
}

async function handleStreamFrame(frame, gateway, writer, subscriptions, authState) {
  const text = frame.trim();
  if (!text) {
    return;
  }

  let packet;
  try {
    packet = JSON.parse(text);
  } catch {
    await writeStreamResponse(writer, createControlResponse({
      compact: true,
      requestId: "invalid-json"
    }, {
      ok: false,
      status: 400,
      error: {
        code: "invalid_json",
        message: "stream frame must be valid JSON"
      }
    }));
    return;
  }

  if (isAuthPacket(packet)) {
    await handleAuthPacket(packet, authState, writer);
    return;
  }

  const hmac = verifyFrameHmac(authState.security, packet);
  if (!hmac.ok) {
    await writeStreamResponse(writer, createSecurityErrorResponse(packet, hmac));
    return;
  }

  if (authState.config.enabled && !authState.authenticated) {
    await writeStreamResponse(writer, createAuthRequiredResponse(packet));
    return;
  }

  if (isEventSubscribePacket(packet)) {
    await handleEventSubscribe(packet, gateway, writer, subscriptions, authState);
    return;
  }

  if (isEventUnsubscribePacket(packet)) {
    await handleEventUnsubscribe(packet, writer, subscriptions);
    return;
  }

  const response = gateway.handleStreamPacket(packet, {
    auth: authState,
    security: authState.security,
    consumeRateLimit: (key) => consumeRateLimit(authState, key),
    checkReplay: (commandId) => checkReplay(authState, commandId)
  });
  await writeStreamResponse(writer, response);
}

async function handleBidirectionalStream(stream, gateway, authState) {
  const streamReader = stream.readable.getReader();
  const streamWriter = createStreamWriterQueue(stream.writable.getWriter());
  const streamDecoder = new TextDecoder();
  const subscriptions = new Map();
  let buffer = "";
  let pendingBufferBytes = 0;

  try {
    while (true) {
      const { value, done } = await streamReader.read();
      if (done) {
        break;
      }

      pendingBufferBytes += value.byteLength;
      if (pendingBufferBytes > authState.security.messageLimits.maxPendingStreamBufferBytes) {
        throw new Error("stream pending buffer limit exceeded");
      }

      buffer += streamDecoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }

        const frame = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const frameBytes = streamEncoder.encode(`${frame}\n`).byteLength;
        pendingBufferBytes = Math.max(0, pendingBufferBytes - frameBytes);

        if (frameBytes > authState.security.messageLimits.maxStreamFrameBytes) {
          throw new Error("stream frame size limit exceeded");
        }

        const rate = consumeRateLimit(authState, "streamFrame");
        if (!rate.ok) {
          if (rate.action === "close") {
            throw new Error("stream frame rate limit exceeded");
          }
          if (rate.action === "reject") {
            await writeStreamResponse(streamWriter, createControlResponse({
              compact: true,
              requestId: "rate-limited"
            }, {
              ok: false,
              status: rate.status,
              error: rate.error
            }));
          }
          continue;
        }

        await handleStreamFrame(frame, gateway, streamWriter, subscriptions, authState);
      }
    }

    const tail = `${buffer}${streamDecoder.decode()}`;
    if (tail.trim()) {
      const tailBytes = streamEncoder.encode(tail).byteLength;
      if (tailBytes > authState.security.messageLimits.maxStreamFrameBytes) {
        throw new Error("stream frame size limit exceeded");
      }
      await handleStreamFrame(tail, gateway, streamWriter, subscriptions, authState);
    }
  } finally {
    stopAllEventSubscriptions(subscriptions);
    await streamWriter.close().catch(() => {});
  }
}

async function pipeIncomingBidirectionalStreams(session, gateway, authState) {
  const reader = session.incomingBidirectionalStreams.getReader();

  while (true) {
    const { value: stream, done } = await reader.read();
    if (done) {
      break;
    }

    handleBidirectionalStream(stream, gateway, authState).catch((error) => {
      logPipelineError("bidirectional stream failed", error);
    });
  }
}

async function handleSessions(server, gateway, path, authConfig, securityRuntime) {
  const sessionStream = server.sessionStream(path, {});
  const reader = sessionStream.getReader();

  while (true) {
    const { value: session, done } = await reader.read();
    if (done) {
      break;
    }

    const authState = createSessionSecurityState({ authConfig, securityRuntime });

    pipeDatagrams(session, gateway, authState).catch((error) => {
      logPipelineError("datagram pipeline failed", error);
    });
    pipeIncomingBidirectionalStreams(session, gateway, authState).catch((error) => {
      logPipelineError("stream pipeline failed", error);
    });
  }
}

export async function startServer({
  host = process.env.R2TG_HOST ?? "0.0.0.0",
  port = Number(process.env.R2TG_PORT ?? 4433),
  path = process.env.R2TG_PATH ?? "/r2tg",
  serveClientLibrary = process.env.R2TG_SERVE_CLIENT === "1",
  fecFlushIntervalMs = readFecFlushIntervalMs()
} = {}) {
  const { Http3Server } = await loadWebTransportRuntime();
  const tls = readTlsConfig();
  const authConfig = readAuthConfig();
  const securityConfig = readSecurityConfig(process.env, authConfig);
  validateSecurityConfig(securityConfig, authConfig);

  const gateway = new R2TGGateway({
    enableDemoRoutes: process.env.R2TG_ENABLE_DEMO_ROUTES === "1",
    fecFlushIntervalMs
  });
  const securityRuntime = createSecurityRuntime(securityConfig);

  const server = new Http3Server({
    host,
    port,
    secret: crypto.randomBytes(32).toString("hex"),
    ...tls
  });

  server.setRequestCallback(createSessionRequestHandler({ path, securityConfig }));

  await server.startServer();
  await server.ready;

  const clientLibraryServer = serveClientLibrary
    ? await startClientLibraryServer({ host, port, tls, securityConfig })
    : null;

  gateway.startMaintenance();

  handleSessions(server, gateway, path, authConfig, securityRuntime).catch((error) => {
    console.error("session loop failed", error);
  });

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    gateway.stopMaintenance();
    clientLibraryServer?.close?.();
    server.stopServer?.();
  };

  console.log(`R2TG WebTransport server listening on https://${host}:${port}${path}`);
  console.log(`R2TG token auth ${authConfig.enabled ? "enabled" : "disabled"}`);
  console.log(`R2TG security profile ${securityConfig.profile}`);
  if (clientLibraryServer) {
    console.log(`R2TG browser client module available at https://${host}:${port}${CLIENT_LIBRARY_MODULE_PATH}`);
  }
  return { server, gateway, clientLibraryServer, security: describeSecurityConfig(securityConfig), stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer().then((runtime) => {
    const shutdown = () => {
      runtime.stop();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
