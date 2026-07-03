export const PROTOCOL_VERSION = 1;
export const PROJECT = "R2TG";

export const CHANNELS = Object.freeze({
  DATAGRAM: "datagram",
  STREAM: "stream"
});

export const FEC_TYPES = Object.freeze({
  NONE: "none",
  XOR: "xor"
});

export const MESSAGE_TYPES = Object.freeze({
  STATE: "state",
  SENSOR: "sensor",
  MONITOR: "monitor",
  FEC_PARITY: "fec_parity",
  COMMAND: "command",
  ACK: "ack",
  API_REQUEST: "api_request",
  API_RESPONSE: "api_response",
  LOG: "log",
  STATE_SNAPSHOT: "state_snapshot"
});
