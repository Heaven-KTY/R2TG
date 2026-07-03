import { stableStringify } from "./stableJson.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function payloadToBytes(payload) {
  return textEncoder.encode(stableStringify(payload));
}

export function payloadFromBytes(bytes) {
  return JSON.parse(textDecoder.decode(bytes));
}

export function packetToBytes(packet) {
  return textEncoder.encode(JSON.stringify(packet));
}

export function packetFromBytes(bytes) {
  return JSON.parse(textDecoder.decode(bytes));
}

export function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}
