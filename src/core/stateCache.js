export class StateCache {
  constructor({
    ttlMs = 1000,
    maxPacketAgeMs = 1000,
    now = () => Date.now()
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxPacketAgeMs = maxPacketAgeMs;
    this.now = now;
    this.entries = new Map();
  }

  keyFor(packet) {
    return `${packet.device_id}:${packet.message_type}`;
  }

  upsert(packet) {
    const currentTime = this.now();
    const age = currentTime - packet.timestamp;

    if (age > this.maxPacketAgeMs) {
      return { accepted: false, reason: "expired_timestamp" };
    }

    const key = this.keyFor(packet);
    const existing = this.entries.get(key);

    if (existing && packet.seq <= existing.seq) {
      return { accepted: false, reason: "stale_seq", entry: existing };
    }

    const entry = {
      device_id: packet.device_id,
      message_type: packet.message_type,
      group_id: packet.group_id,
      seq: packet.seq,
      timestamp: packet.timestamp,
      updated_at: currentTime,
      stale: false,
      disconnected: false,
      recovered: packet.recovered === true,
      state: packet.payload
    };

    this.entries.set(key, entry);
    return { accepted: true, entry };
  }

  markDisconnected(deviceId) {
    for (const entry of this.entries.values()) {
      if (entry.device_id === deviceId) {
        entry.stale = true;
        entry.disconnected = true;
      }
    }
  }

  refreshStaleness() {
    const currentTime = this.now();
    for (const entry of this.entries.values()) {
      if (currentTime - entry.updated_at > this.ttlMs) {
        entry.stale = true;
      }
    }
  }

  snapshot(deviceId = null) {
    this.refreshStaleness();
    const state = {};

    for (const [key, entry] of this.entries.entries()) {
      if (deviceId && entry.device_id !== deviceId) {
        continue;
      }
      state[key] = { ...entry };
    }

    return state;
  }
}
