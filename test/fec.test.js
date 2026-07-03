import test from "node:test";
import assert from "node:assert/strict";
import { createXorDatagramGroup } from "../src/core/datagram.js";
import { FecCollector } from "../src/core/fec/collector.js";

test("xor FEC recovers one missing datagram", () => {
  let currentTime = 1000;
  const group = createXorDatagramGroup({
    deviceId: "main-controller-01",
    groupId: 10001,
    seqStart: 50001,
    timestamp: currentTime,
    payloads: [
      { temperature: 72.5, rpm: 1200 },
      { temperature: 72.6, rpm: 1201, status: "running" },
      { temperature: 72.7, rpm: 1202 },
      { temperature: 72.8, rpm: 1203 }
    ]
  });

  const collector = new FecCollector({ timeoutMs: 50, now: () => currentTime });
  const sent = [
    group.dataPackets[0],
    group.dataPackets[2],
    group.dataPackets[3],
    group.parityPacket
  ];

  let result;
  for (const packet of sent) {
    result = collector.receive(packet);
  }

  assert.equal(result.status, "recovered");
  assert.equal(result.packets.length, 4);
  assert.equal(result.packets[1].recovered, true);
  assert.deepEqual(result.packets[1].payload, group.dataPackets[1].payload);
});

test("xor FEC waits when two original datagrams are missing", () => {
  const group = createXorDatagramGroup({
    deviceId: "main-controller-01",
    groupId: 10002,
    seqStart: 60001,
    timestamp: 1000,
    payloads: [
      { value: 1 },
      { value: 2 },
      { value: 3 },
      { value: 4 }
    ]
  });

  const collector = new FecCollector({ timeoutMs: 50, now: () => 1000 });
  collector.receive(group.dataPackets[0]);
  collector.receive(group.dataPackets[3]);
  const result = collector.receive(group.parityPacket);

  assert.equal(result.status, "waiting");
  assert.equal(result.reason, "multiple_missing");
});

test("fec collector drops timed out incomplete groups", () => {
  let currentTime = 1000;
  const group = createXorDatagramGroup({
    deviceId: "main-controller-01",
    groupId: 10003,
    seqStart: 70001,
    timestamp: currentTime,
    payloads: [{ value: 1 }, { value: 2 }]
  });

  const collector = new FecCollector({ timeoutMs: 50, now: () => currentTime });
  collector.receive(group.dataPackets[0]);
  currentTime = 1061;

  assert.deepEqual(collector.flushExpired(), [{ group_id: 10003, reason: "fec_timeout" }]);
});
