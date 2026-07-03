import { CHANNELS, MESSAGE_TYPES, PROJECT, PROTOCOL_VERSION } from "./constants.js";

export const COMPACT_API_TYPES = Object.freeze({
  REQUEST: "api",
  RESPONSE: "api_res"
});

function hasOwn(value, key) {
  return Object.hasOwn(value, key);
}

function hasValues(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

export function createCommandPacket({
  commandId,
  deviceId,
  command,
  params = {},
  timestamp = Date.now()
}) {
  if (!commandId) {
    throw new Error("commandId is required");
  }
  if (!deviceId) {
    throw new Error("deviceId is required");
  }
  if (!command) {
    throw new Error("command is required");
  }

  return {
    version: PROTOCOL_VERSION,
    project: PROJECT,
    channel: CHANNELS.STREAM,
    message_type: MESSAGE_TYPES.COMMAND,
    command_id: commandId,
    device_id: deviceId,
    command,
    params,
    timestamp
  };
}

export function createAckPacket({
  commandId,
  deviceId,
  ok,
  error = null,
  timestamp = Date.now()
}) {
  return {
    version: PROTOCOL_VERSION,
    project: PROJECT,
    channel: CHANNELS.STREAM,
    message_type: MESSAGE_TYPES.ACK,
    command_id: commandId,
    device_id: deviceId,
    ok: ok === true,
    error,
    timestamp
  };
}

export function createApiRequestPacket({
  requestId,
  method = "GET",
  resource,
  params = {},
  body = null,
  timestamp = Date.now()
}) {
  if (!requestId) {
    throw new Error("requestId is required");
  }
  if (!resource) {
    throw new Error("resource is required");
  }

  return {
    version: PROTOCOL_VERSION,
    project: PROJECT,
    channel: CHANNELS.STREAM,
    message_type: MESSAGE_TYPES.API_REQUEST,
    request_id: requestId,
    method: method.toUpperCase(),
    resource,
    params,
    body,
    timestamp
  };
}

export function createCompactApiRequestPacket({
  requestId,
  method = "GET",
  resource,
  params = {},
  body = null
}) {
  if (!requestId) {
    throw new Error("requestId is required");
  }
  if (!resource) {
    throw new Error("resource is required");
  }

  const packet = {
    t: COMPACT_API_TYPES.REQUEST,
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

export function createApiResponsePacket({
  requestId,
  ok,
  status,
  data = null,
  error = null,
  timestamp = Date.now()
}) {
  if (!requestId) {
    throw new Error("requestId is required");
  }

  return {
    version: PROTOCOL_VERSION,
    project: PROJECT,
    channel: CHANNELS.STREAM,
    message_type: MESSAGE_TYPES.API_RESPONSE,
    request_id: requestId,
    ok: ok === true,
    status,
    data,
    error,
    timestamp
  };
}

export function createCompactApiResponsePacket({
  requestId,
  ok,
  status,
  data = null,
  error = null
}) {
  if (!requestId) {
    throw new Error("requestId is required");
  }

  const packet = {
    t: COMPACT_API_TYPES.RESPONSE,
    id: requestId,
    o: ok === true,
    s: status
  };

  if (data !== null && data !== undefined) {
    packet.d = data;
  }
  if (error) {
    packet.e = error;
  }

  return packet;
}

export function isCompactApiRequestPacket(packet) {
  return packet?.t === COMPACT_API_TYPES.REQUEST;
}

export function isLongApiRequestPacket(packet) {
  return packet?.project === PROJECT && packet?.message_type === MESSAGE_TYPES.API_REQUEST;
}

export function isApiRequestPacket(packet) {
  return isLongApiRequestPacket(packet) || isCompactApiRequestPacket(packet);
}

export function normalizeApiRequestPacket(packet) {
  if (isCompactApiRequestPacket(packet)) {
    return {
      version: PROTOCOL_VERSION,
      project: PROJECT,
      channel: CHANNELS.STREAM,
      message_type: MESSAGE_TYPES.API_REQUEST,
      request_id: packet.id,
      method: packet.m ?? "GET",
      resource: packet.r,
      params: packet.q ?? {},
      body: hasOwn(packet, "b") ? packet.b : null,
      compact: true,
      raw: packet
    };
  }

  return {
    ...packet,
    method: packet.method ?? "GET",
    params: packet.params ?? {},
    body: hasOwn(packet, "body") ? packet.body : null,
    compact: false,
    raw: packet
  };
}
