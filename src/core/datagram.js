import { CHANNELS, FEC_TYPES, MESSAGE_TYPES, PROJECT, PROTOCOL_VERSION } from "./constants.js";
import { crc32Hex } from "./crc32.js";
import { base64ToBytes, bytesToBase64, payloadFromBytes, payloadToBytes } from "./encoding.js";
import { createXorParity } from "./fec/xorParity.js";

function normalizeCrc(value) {
  return String(value ?? "").toLowerCase();
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

export function createDatagramPacket({
  messageType = MESSAGE_TYPES.STATE,
  deviceId,
  groupId,
  seq,
  index = 0,
  total = 1,
  timestamp = Date.now(),
  payload,
  fecType = FEC_TYPES.NONE,
  paddedLength = null
}) {
  if (!deviceId) {
    throw new Error("deviceId is required");
  }
  assertPositiveInteger(groupId, "groupId");
  assertNonNegativeInteger(seq, "seq");
  assertNonNegativeInteger(index, "index");
  assertPositiveInteger(total, "total");

  const payloadBytes = payloadToBytes(payload);
  const targetPaddedLength = paddedLength ?? payloadBytes.byteLength;

  if (targetPaddedLength < payloadBytes.byteLength) {
    throw new RangeError("paddedLength cannot be smaller than payload length");
  }

  return {
    version: PROTOCOL_VERSION,
    project: PROJECT,
    channel: CHANNELS.DATAGRAM,
    message_type: messageType,
    device_id: deviceId,
    group_id: groupId,
    seq,
    index,
    total,
    fec_type: fecType,
    timestamp,
    payload_length: payloadBytes.byteLength,
    padded_length: targetPaddedLength,
    padding_type: "zero",
    payload,
    crc: crc32Hex(payloadBytes)
  };
}

export function createXorDatagramGroup({
  deviceId,
  messageType = MESSAGE_TYPES.STATE,
  groupId,
  seqStart,
  payloads,
  timestamp = Date.now()
}) {
  if (!Array.isArray(payloads) || payloads.length < 2) {
    throw new Error("XOR FEC group requires at least two payloads");
  }

  const payloadBytes = payloads.map((payload) => payloadToBytes(payload));
  const paddedLength = Math.max(...payloadBytes.map((bytes) => bytes.byteLength));
  const dataPackets = payloads.map((payload, index) => createDatagramPacket({
    messageType,
    deviceId,
    groupId,
    seq: seqStart + index,
    index,
    total: payloads.length,
    timestamp,
    payload,
    fecType: FEC_TYPES.XOR,
    paddedLength
  }));

  const parityBytes = createXorParity(payloadBytes, paddedLength);
  const payloadLengths = dataPackets.map((packet) => packet.payload_length);
  const payloadCrcs = dataPackets.map((packet) => packet.crc);

  const parityPacket = {
    version: PROTOCOL_VERSION,
    project: PROJECT,
    channel: CHANNELS.DATAGRAM,
    message_type: MESSAGE_TYPES.FEC_PARITY,
    device_id: deviceId,
    group_id: groupId,
    seq: seqStart + payloads.length,
    seq_start: seqStart,
    index: payloads.length,
    total: payloads.length,
    fec_type: FEC_TYPES.XOR,
    parity_for: messageType,
    timestamp,
    payload_length: paddedLength,
    padded_length: paddedLength,
    padding_type: "zero",
    payload_lengths: payloadLengths,
    payload_crcs: payloadCrcs,
    parity_base64: bytesToBase64(parityBytes),
    crc: crc32Hex(parityBytes)
  };

  return {
    dataPackets,
    parityPacket,
    packets: [...dataPackets, parityPacket]
  };
}

export function isParityPacket(packet) {
  return packet?.channel === CHANNELS.DATAGRAM && packet?.message_type === MESSAGE_TYPES.FEC_PARITY;
}

export function verifyDatagramPacket(packet) {
  if (!packet || packet.version !== PROTOCOL_VERSION || packet.project !== PROJECT || packet.channel !== CHANNELS.DATAGRAM) {
    return false;
  }

  if (isParityPacket(packet)) {
    if (!packet.parity_base64) {
      return false;
    }
    return crc32Hex(base64ToBytes(packet.parity_base64)) === normalizeCrc(packet.crc);
  }

  if (!Object.hasOwn(packet, "payload")) {
    return false;
  }

  const payloadBytes = payloadToBytes(packet.payload);
  return payloadBytes.byteLength === packet.payload_length && crc32Hex(payloadBytes) === normalizeCrc(packet.crc);
}

export function buildRecoveredDatagram({ parityPacket, recoveredBytes, missingIndex }) {
  const payload = payloadFromBytes(recoveredBytes);
  const crc = crc32Hex(recoveredBytes);
  const expectedCrc = normalizeCrc(parityPacket.payload_crcs?.[missingIndex]);

  if (crc !== expectedCrc) {
    throw new Error("recovered payload CRC mismatch");
  }

  return {
    version: PROTOCOL_VERSION,
    project: PROJECT,
    channel: CHANNELS.DATAGRAM,
    message_type: parityPacket.parity_for,
    device_id: parityPacket.device_id,
    group_id: parityPacket.group_id,
    seq: parityPacket.seq_start + missingIndex,
    index: missingIndex,
    total: parityPacket.total,
    fec_type: FEC_TYPES.XOR,
    timestamp: parityPacket.timestamp,
    payload_length: recoveredBytes.byteLength,
    padded_length: parityPacket.padded_length,
    padding_type: "zero",
    payload,
    crc,
    recovered: true
  };
}
