import test from "node:test";
import assert from "node:assert/strict";
import { createXorDatagramGroup } from "../src/core/datagram.js";
import { packetFromBytes, packetToBytes } from "../src/core/encoding.js";
import { R2TGGateway } from "../src/server/gateway.js";

test("gateway applies recovered datagrams to state cache", () => {
  const gateway = new R2TGGateway({
    fecTimeoutMs: 50,
    stateTtlMs: 1000,
    maxPacketAgeMs: 1000,
    now: () => 1000
  });

  const group = createXorDatagramGroup({
    deviceId: "main-controller-01",
    groupId: 20001,
    seqStart: 1,
    timestamp: 1000,
    payloads: [
      { rpm: 1000 },
      { rpm: 1001, status: "running" },
      { rpm: 1002 },
      { rpm: 1003 }
    ]
  });

  const sent = [
    group.dataPackets[0],
    group.dataPackets[2],
    group.dataPackets[3],
    group.parityPacket
  ];

  let result;
  for (const packet of sent) {
    result = gateway.handleDatagramBytes(packetToBytes(packet));
  }

  assert.equal(result.status, "recovered");
  assert.equal(result.cacheUpdates.at(-1).result.accepted, true);

  const snapshot = packetFromBytes(gateway.snapshotBytes());
  assert.equal(snapshot.project, "R2TG");
  assert.equal(snapshot.state["main-controller-01:state"].state.rpm, 1003);
});

test("gateway maintenance periodically flushes expired FEC groups", async () => {
  const gateway = new R2TGGateway({
    fecFlushIntervalMs: 100
  });
  let flushCount = 0;
  gateway.fecCollector.flushExpired = () => {
    flushCount += 1;
    return [];
  };

  try {
    gateway.startMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 140));
  } finally {
    gateway.stopMaintenance();
  }

  assert.ok(flushCount >= 1);
});

test("gateway maintenance does not create duplicate intervals", () => {
  const gateway = new R2TGGateway({
    fecFlushIntervalMs: 100
  });

  try {
    gateway.startMaintenance();
    const timer = gateway.maintenanceTimer;
    gateway.startMaintenance();

    assert.equal(gateway.maintenanceTimer, timer);
  } finally {
    gateway.stopMaintenance();
  }
});

test("gateway maintenance can be stopped and restarted", () => {
  const gateway = new R2TGGateway({
    fecFlushIntervalMs: 100
  });

  gateway.startMaintenance();
  assert.ok(gateway.maintenanceTimer);
  gateway.stopMaintenance();
  assert.equal(gateway.maintenanceTimer, null);

  try {
    gateway.startMaintenance();
    assert.ok(gateway.maintenanceTimer);
  } finally {
    gateway.stopMaintenance();
  }
});

test("gateway maintenance removes timed out incomplete FEC groups", async () => {
  let currentTime = 1000;
  const gateway = new R2TGGateway({
    fecTimeoutMs: 50,
    fecFlushIntervalMs: 100,
    now: () => currentTime
  });
  const group = createXorDatagramGroup({
    deviceId: "main-controller-01",
    groupId: 20002,
    seqStart: 10,
    timestamp: currentTime,
    payloads: [{ value: 1 }, { value: 2 }]
  });
  const originalDebug = console.debug;
  const debugEntries = [];
  console.debug = (...args) => {
    debugEntries.push(args);
  };

  try {
    gateway.handleDatagramBytes(packetToBytes(group.dataPackets[0]));
    assert.equal(gateway.fecCollector.groups.size, 1);

    currentTime = 1061;
    gateway.startMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 140));

    assert.equal(gateway.fecCollector.groups.size, 0);
    assert.equal(debugEntries.length, 1);
    assert.deepEqual(debugEntries[0], [
      "[R2TG] expired FEC groups flushed",
      { count: 1, timestamp: 1061 }
    ]);
  } finally {
    gateway.stopMaintenance();
    console.debug = originalDebug;
  }
});
