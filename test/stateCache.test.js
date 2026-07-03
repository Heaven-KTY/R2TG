import test from "node:test";
import assert from "node:assert/strict";
import { createDatagramPacket } from "../src/core/datagram.js";
import { StateCache } from "../src/core/stateCache.js";

test("state cache keeps only newer sequence values", () => {
  let currentTime = 1000;
  const cache = new StateCache({ ttlMs: 1000, maxPacketAgeMs: 500, now: () => currentTime });

  const first = createDatagramPacket({
    deviceId: "main-controller-01",
    groupId: 1,
    seq: 10,
    timestamp: currentTime,
    payload: { rpm: 1000 }
  });

  const old = createDatagramPacket({
    deviceId: "main-controller-01",
    groupId: 2,
    seq: 9,
    timestamp: currentTime,
    payload: { rpm: 900 }
  });

  assert.equal(cache.upsert(first).accepted, true);
  assert.equal(cache.upsert(old).accepted, false);
  assert.equal(cache.snapshot()["main-controller-01:state"].state.rpm, 1000);
});

test("state cache rejects expired timestamp", () => {
  const cache = new StateCache({ ttlMs: 1000, maxPacketAgeMs: 100, now: () => 1200 });
  const packet = createDatagramPacket({
    deviceId: "main-controller-01",
    groupId: 1,
    seq: 1,
    timestamp: 1000,
    payload: { rpm: 1000 }
  });

  const result = cache.upsert(packet);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "expired_timestamp");
});

test("state cache marks stale entries", () => {
  let currentTime = 1000;
  const cache = new StateCache({ ttlMs: 100, maxPacketAgeMs: 500, now: () => currentTime });
  const packet = createDatagramPacket({
    deviceId: "main-controller-01",
    groupId: 1,
    seq: 1,
    timestamp: currentTime,
    payload: { rpm: 1000 }
  });

  cache.upsert(packet);
  currentTime = 1201;

  assert.equal(cache.snapshot()["main-controller-01:state"].stale, true);
});
