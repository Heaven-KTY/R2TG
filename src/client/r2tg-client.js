const PROJECT = "R2TG";
const CHANNEL_STREAM = "stream";
const MESSAGE_API_REQUEST = "api_request";
const MESSAGE_API_RESPONSE = "api_response";
const COMPACT_API_REQUEST = "api";
const COMPACT_API_RESPONSE = "api_res";
const COMPACT_AUTH_REQUEST = "auth";
const COMPACT_EVENT_SUBSCRIBE = "sub";
const COMPACT_EVENT_UNSUBSCRIBE = "unsub";
const COMPACT_EVENT = "evt";
const DEFAULT_TRANSPORT_PATH = "/r2tg";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeForSignature(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForSignature(item));
  }

  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "sig" || key === "hmac") {
      continue;
    }
    const item = value[key];
    if (item !== undefined) {
      output[key] = normalizeForSignature(item);
    }
  }
  return output;
}

function stableStringify(value) {
  return JSON.stringify(normalizeForSignature(value));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function hmacSha256Base64Url(secret, message) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto subtle API is required for frame HMAC.");
  }

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

function base64ToUint8Array(value) {
  const binary = globalThis.atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function packetToBytes(packet) {
  return encoder.encode(JSON.stringify(packet));
}

function packetToFrameBytes(packet) {
  return encoder.encode(`${JSON.stringify(packet)}\n`);
}

function packetFromBytes(bytes) {
  return JSON.parse(decoder.decode(bytes));
}

function defaultWebTransportUrl() {
  const url = new URL(import.meta.url);
  url.pathname = DEFAULT_TRANSPORT_PATH;
  url.search = "";
  url.hash = "";
  return url.href;
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return `req-${globalThis.crypto.randomUUID()}`;
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hasValues(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function getPacketRequestId(packet) {
  return packet?.request_id ?? packet?.id ?? null;
}

function normalizeApiResponse(packet) {
  if (packet?.t === COMPACT_API_RESPONSE) {
    return {
      version: 1,
      project: PROJECT,
      channel: CHANNEL_STREAM,
      message_type: MESSAGE_API_RESPONSE,
      request_id: packet.id,
      ok: packet.o === true,
      status: packet.s,
      data: Object.hasOwn(packet, "d") ? packet.d : null,
      error: packet.e ?? null,
      compact: true,
      raw: packet
    };
  }

  if (packet?.message_type === MESSAGE_API_RESPONSE) {
    return {
      ...packet,
      data: packet.data ?? null,
      error: packet.error ?? null,
      compact: false,
      raw: packet
    };
  }

  return packet;
}

function normalizeEventFrame(packet) {
  return {
    type: packet.t,
    topic: packet.topic ?? "message",
    event: packet.event ?? "message",
    id: packet.id ?? null,
    timestamp: packet.ts ?? Date.now(),
    data: Object.hasOwn(packet, "d") ? packet.d : packet.data ?? null,
    raw: packet
  };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readStreamPacket(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return packetFromBytes(merged);
}

export class R2TGClient {
  constructor({
    url = defaultWebTransportUrl(),
    serverCertificateHashBase64 = "",
    requestTimeoutMs = 5000,
    packetFormat = "compact",
    streamMode = "persistent",
    warmupStreamOnConnect = true,
    authToken = "",
    frameHmacSecret = ""
  } = {}) {
    this.url = url;
    this.serverCertificateHashBase64 = serverCertificateHashBase64;
    this.requestTimeoutMs = requestTimeoutMs;
    this.packetFormat = packetFormat;
    this.streamMode = streamMode;
    this.warmupStreamOnConnect = warmupStreamOnConnect;
    this.authToken = authToken;
    this.frameHmacSecret = frameHmacSecret;
    this.authenticated = false;
    this.transport = null;
    this.apiWriter = null;
    this.apiReadLoop = null;
    this.apiStreamOpening = null;
    this.pendingApiResponses = new Map();
    this.eventHandlers = new Map();
    this.lastStreamOpenMs = null;
  }

  get connected() {
    return Boolean(this.transport);
  }

  setUrl(url) {
    this.url = url;
    return this;
  }

  setCertificateHashBase64(value) {
    this.serverCertificateHashBase64 = value;
    return this;
  }

  setAuthToken(value) {
    this.authToken = value;
    this.authenticated = false;
    return this;
  }

  setFrameHmacSecret(value) {
    this.frameHmacSecret = value;
    return this;
  }

  createWebTransportOptions() {
    if (!this.serverCertificateHashBase64) {
      return {};
    }

    return {
      serverCertificateHashes: [
        {
          algorithm: "sha-256",
          value: base64ToUint8Array(this.serverCertificateHashBase64)
        }
      ]
    };
  }

  async connect() {
    if (!globalThis.WebTransport) {
      throw new Error("WebTransport is not available in this browser.");
    }

    if (this.transport) {
      return this;
    }

    this.transport = new WebTransport(this.url, this.createWebTransportOptions());
    try {
      await this.transport.ready;
      if (this.warmupStreamOnConnect) {
        await this.ensureApiStream();
      }
      if (this.authToken) {
        await this.authenticate();
      }
      return this;
    } catch (error) {
      this.close({ reason: "connect failed" });
      throw error;
    }
  }

  close({ code = 0, reason = "closed by client" } = {}) {
    this.rejectPendingApiResponses(new Error("R2TGClient was closed."));
    this.eventHandlers.clear();
    this.apiWriter?.close().catch(() => {});
    this.resetApiStream();
    this.transport?.close({ closeCode: code, reason });
    this.transport = null;
    this.authenticated = false;
  }

  createAuthPacket() {
    const requestId = createRequestId();

    if (this.packetFormat === "compact") {
      return {
        t: COMPACT_AUTH_REQUEST,
        id: requestId,
        token: this.authToken
      };
    }

    return {
      version: 1,
      project: PROJECT,
      channel: CHANNEL_STREAM,
      message_type: "auth_request",
      request_id: requestId,
      token: this.authToken,
      timestamp: Date.now()
    };
  }

  createApiRequestPacket({ method = "GET", resource, params = {}, body = null }) {
    if (!resource) {
      throw new Error("resource is required");
    }

    const requestId = createRequestId();

    if (this.packetFormat === "compact") {
      const packet = {
        t: COMPACT_API_REQUEST,
        id: requestId,
        m: method.toUpperCase(),
        r: resource
      };

      if (hasValues(params)) {
        packet.q = params;
      }
      if (body !== null && body !== undefined) {
        packet.b = body;
      }

      return packet;
    }

    return {
      version: 1,
      project: PROJECT,
      channel: CHANNEL_STREAM,
      message_type: MESSAGE_API_REQUEST,
      request_id: requestId,
      method: method.toUpperCase(),
      resource,
      params,
      body,
      timestamp: Date.now()
    };
  }

  createEventSubscribePacket({ topic = "heartbeat", intervalMs = 1000 }) {
    return {
      t: COMPACT_EVENT_SUBSCRIBE,
      id: createRequestId(),
      topic,
      interval_ms: intervalMs
    };
  }

  createEventUnsubscribePacket({ topic = "heartbeat" }) {
    return {
      t: COMPACT_EVENT_UNSUBSCRIBE,
      id: createRequestId(),
      topic
    };
  }

  async preparePacket(packet) {
    if (!this.frameHmacSecret) {
      return packet;
    }

    return {
      ...packet,
      sig: await hmacSha256Base64Url(this.frameHmacSecret, stableStringify(packet))
    };
  }

  resetApiStream() {
    this.apiWriter = null;
    this.apiReadLoop = null;
    this.apiStreamOpening = null;
  }

  rejectPendingApiResponses(error) {
    for (const pending of this.pendingApiResponses.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingApiResponses.clear();
  }

  waitForApiResponse(requestId, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApiResponses.delete(requestId);
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingApiResponses.set(requestId, { resolve, reject, timer });
    });
  }

  cancelPendingApiResponse(requestId, error) {
    const pending = this.pendingApiResponses.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingApiResponses.delete(requestId);
    pending.reject(error);
  }

  resolveApiFrame(frame) {
    const line = frame.trim();
    if (!line) {
      return;
    }

    const packet = JSON.parse(line);
    if (packet?.t === COMPACT_EVENT) {
      this.dispatchEventFrame(normalizeEventFrame(packet));
      return;
    }

    const response = normalizeApiResponse(packet);
    const requestId = response.request_id;
    const pending = this.pendingApiResponses.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingApiResponses.delete(requestId);
    pending.resolve({
      response,
      bytesReceived: encoder.encode(line).byteLength
    });
  }

  dispatchEventFrame(event) {
    const handlers = [
      ...(this.eventHandlers.get(event.topic) ?? []),
      ...(this.eventHandlers.get("*") ?? [])
    ];

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("R2TG event handler failed", error);
      }
    }
  }

  addEventHandler(topic, handler) {
    if (!this.eventHandlers.has(topic)) {
      this.eventHandlers.set(topic, new Set());
    }
    this.eventHandlers.get(topic).add(handler);
  }

  removeEventHandler(topic, handler) {
    const handlers = this.eventHandlers.get(topic);
    if (!handlers) {
      return false;
    }

    if (handler) {
      handlers.delete(handler);
    } else {
      handlers.clear();
    }

    if (handlers.size === 0) {
      this.eventHandlers.delete(topic);
      return true;
    }

    return false;
  }

  async readApiStream(readable) {
    const reader = readable.getReader();
    const streamDecoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += streamDecoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }

        const frame = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        this.resolveApiFrame(frame);
      }
    }

    const tail = `${buffer}${streamDecoder.decode()}`;
    this.resolveApiFrame(tail);
    throw new Error("R2TG API stream closed.");
  }

  async ensureApiStream() {
    if (!this.transport) {
      throw new Error("R2TGClient is not connected.");
    }

    if (this.streamMode !== "persistent") {
      return;
    }

    if (this.apiWriter) {
      return;
    }

    if (this.apiStreamOpening) {
      await this.apiStreamOpening;
      return;
    }

    const startedAt = performance.now();
    this.apiStreamOpening = (async () => {
      const stream = await this.transport.createBidirectionalStream();
      this.apiWriter = stream.writable.getWriter();
      this.lastStreamOpenMs = performance.now() - startedAt;
      this.apiReadLoop = this.readApiStream(stream.readable).catch((error) => {
        this.resetApiStream();
        this.rejectPendingApiResponses(error);
      });
    })();

    try {
      await this.apiStreamOpening;
    } finally {
      this.apiStreamOpening = null;
    }
  }

  async sendOneShotStreamPacket(packet, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.transport) {
      throw new Error("R2TGClient is not connected.");
    }

    const timings = {};
    const streamStartedAt = performance.now();
    const stream = await this.transport.createBidirectionalStream();
    timings.streamOpenMs = performance.now() - streamStartedAt;

    const writer = stream.writable.getWriter();
    const preparedPacket = await this.preparePacket(packet);
    const bytes = packetToBytes(preparedPacket);
    const writeStartedAt = performance.now();

    await writer.write(bytes);
    await writer.close();

    timings.writeMs = performance.now() - writeStartedAt;

    const readStartedAt = performance.now();
    const response = normalizeApiResponse(await withTimeout(readStreamPacket(stream.readable), timeoutMs, packet.message_type ?? packet.t ?? "stream packet"));
    timings.readMs = performance.now() - readStartedAt;

    return {
      response,
      timings,
      bytesSent: bytes.byteLength,
      bytesReceived: packetToBytes(response.raw ?? response).byteLength
    };
  }

  async sendPersistentStreamPacket(packet, { timeoutMs = this.requestTimeoutMs } = {}) {
    const requestId = getPacketRequestId(packet);
    if (!requestId) {
      return this.sendOneShotStreamPacket(packet, { timeoutMs });
    }

    const timings = {};
    const streamStartedAt = performance.now();
    await this.ensureApiStream();
    timings.streamOpenMs = performance.now() - streamStartedAt;

    const preparedPacket = await this.preparePacket(packet);
    const bytes = packetToFrameBytes(preparedPacket);
    const responsePromise = this.waitForApiResponse(requestId, timeoutMs, packet.message_type ?? packet.t ?? "api request");
    const writeStartedAt = performance.now();

    try {
      await this.apiWriter.write(bytes);
    } catch (error) {
      this.cancelPendingApiResponse(requestId, error);
      throw error;
    }

    timings.writeMs = performance.now() - writeStartedAt;

    const readStartedAt = performance.now();
    const result = await responsePromise;
    timings.readMs = performance.now() - readStartedAt;

    return {
      response: result.response,
      timings,
      bytesSent: Math.max(0, bytes.byteLength - 1),
      bytesReceived: result.bytesReceived
    };
  }

  async sendStreamPacketWithMeta(packet, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.streamMode === "persistent") {
      return this.sendPersistentStreamPacket(packet, { timeoutMs });
    }

    return this.sendOneShotStreamPacket(packet, { timeoutMs });
  }

  async sendStreamPacket(packet, { timeoutMs = this.requestTimeoutMs } = {}) {
    const result = await this.sendStreamPacketWithMeta(packet, { timeoutMs });
    return result.response;
  }

  async authenticate({ timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.authToken) {
      return {
        ok: false,
        skipped: true,
        error: {
          code: "auth_token_missing",
          message: "authToken is not configured"
        }
      };
    }

    const response = await this.sendStreamPacket(this.createAuthPacket(), { timeoutMs });
    if (!response.ok) {
      const message = response.error?.message ?? "R2TG authentication failed";
      throw new Error(message);
    }

    this.authenticated = true;
    return response;
  }

  async api({ method = "GET", resource, params = {}, body = null, timeoutMs = this.requestTimeoutMs }) {
    const packet = this.createApiRequestPacket({ method, resource, params, body });
    const startedAt = performance.now();
    const result = await this.sendStreamPacketWithMeta(packet, { timeoutMs });
    const latencyMs = performance.now() - startedAt;

    return {
      request: packet,
      response: result.response,
      latencyMs,
      timings: {
        ...result.timings,
        totalMs: latencyMs
      },
      bytes: {
        sent: result.bytesSent,
        received: result.bytesReceived
      },
      format: this.packetFormat,
      streamMode: this.streamMode
    };
  }

  async subscribe(topic = "heartbeat", onEvent, { intervalMs = 1000, timeoutMs = this.requestTimeoutMs } = {}) {
    if (typeof onEvent !== "function") {
      throw new Error("onEvent handler is required.");
    }

    this.addEventHandler(topic, onEvent);

    try {
      const response = await this.sendStreamPacket(this.createEventSubscribePacket({ topic, intervalMs }), { timeoutMs });
      return {
        topic,
        response,
        unsubscribe: () => this.unsubscribe(topic, onEvent, { timeoutMs })
      };
    } catch (error) {
      this.removeEventHandler(topic, onEvent);
      throw error;
    }
  }

  async unsubscribe(topic = "heartbeat", onEvent = null, { timeoutMs = this.requestTimeoutMs } = {}) {
    const shouldNotifyServer = this.removeEventHandler(topic, onEvent);
    if (!shouldNotifyServer) {
      return null;
    }

    return this.sendStreamPacket(this.createEventUnsubscribePacket({ topic }), { timeoutMs });
  }

  get(resource, params = {}, options = {}) {
    return this.api({ method: "GET", resource, params, ...options });
  }

  post(resource, body = null, params = {}, options = {}) {
    return this.api({ method: "POST", resource, params, body, ...options });
  }

  put(resource, body = null, params = {}, options = {}) {
    return this.api({ method: "PUT", resource, params, body, ...options });
  }

  delete(resource, params = {}, options = {}) {
    return this.api({ method: "DELETE", resource, params, ...options });
  }
}
