import test from "node:test";
import assert from "node:assert/strict";
import { crc32Hex } from "../src/core/crc32.js";
import { payloadToBytes } from "../src/core/encoding.js";

test("crc32 returns the standard check value", () => {
  assert.equal(crc32Hex("123456789"), "cbf43926");
});

test("stable payload bytes keep CRC independent of key order", () => {
  const a = payloadToBytes({ rpm: 1200, temperature: 72.5 });
  const b = payloadToBytes({ temperature: 72.5, rpm: 1200 });
  assert.equal(crc32Hex(a), crc32Hex(b));
});
