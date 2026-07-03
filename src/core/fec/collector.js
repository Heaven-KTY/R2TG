import { buildRecoveredDatagram, isParityPacket, verifyDatagramPacket } from "../datagram.js";
import { base64ToBytes, payloadToBytes } from "../encoding.js";
import { recoverSingleMissingBuffer } from "./xorParity.js";

function createGroup(packet, now) {
  return {
    groupId: packet.group_id,
    total: packet.total,
    startedAt: now,
    data: new Map(),
    parity: null
  };
}

function packetSort(a, b) {
  return a.index - b.index;
}

export class FecCollector {
  constructor({ timeoutMs = 50, now = () => Date.now() } = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.groups = new Map();
  }

  receive(packet) {
    const receivedAt = this.now();

    if (!verifyDatagramPacket(packet)) {
      return { status: "dropped", reason: "invalid_crc", packets: [] };
    }

    if (packet.fec_type !== "xor") {
      return { status: "ready", packets: [packet] };
    }

    const groupKey = String(packet.group_id);
    let group = this.groups.get(groupKey);
    if (!group) {
      group = createGroup(packet, receivedAt);
      this.groups.set(groupKey, group);
    }

    if (isParityPacket(packet)) {
      group.parity = packet;
    } else {
      group.data.set(packet.index, packet);
    }

    return this.resolveGroup(groupKey);
  }

  resolveGroup(groupKey) {
    const group = this.groups.get(String(groupKey));
    if (!group) {
      return { status: "missing_group", packets: [] };
    }

    if (group.data.size === group.total) {
      const packets = [...group.data.values()].sort(packetSort);
      this.groups.delete(String(groupKey));
      return { status: "ready", packets };
    }

    if (group.parity) {
      const missingIndexes = [];
      for (let i = 0; i < group.total; i += 1) {
        if (!group.data.has(i)) {
          missingIndexes.push(i);
        }
      }

      if (missingIndexes.length === 1) {
        const missingIndex = missingIndexes[0];
        const dataBuffers = Array.from({ length: group.total }, (_, index) => {
          const dataPacket = group.data.get(index);
          return dataPacket ? payloadToBytes(dataPacket.payload) : null;
        });
        const payloadLength = group.parity.payload_lengths[missingIndex];
        const recoveredBytes = recoverSingleMissingBuffer({
          dataBuffers,
          parityBuffer: base64ToBytes(group.parity.parity_base64),
          missingIndex,
          payloadLength,
          paddedLength: group.parity.padded_length
        });
        const recoveredPacket = buildRecoveredDatagram({
          parityPacket: group.parity,
          recoveredBytes,
          missingIndex
        });
        group.data.set(missingIndex, recoveredPacket);
        const packets = [...group.data.values()].sort(packetSort);
        this.groups.delete(String(groupKey));
        return { status: "recovered", packets, recovered: recoveredPacket };
      }

      if (missingIndexes.length > 1) {
        return { status: "waiting", reason: "multiple_missing", packets: [] };
      }
    }

    return { status: "waiting", packets: [] };
  }

  flushExpired(now = this.now()) {
    const dropped = [];

    for (const [groupKey, group] of this.groups.entries()) {
      if (now - group.startedAt > this.timeoutMs) {
        this.groups.delete(groupKey);
        dropped.push({ group_id: group.groupId, reason: "fec_timeout" });
      }
    }

    return dropped;
  }
}
