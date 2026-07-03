import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  checkReplay,
  consumeRateLimit,
  createSecurityRuntime,
  createSessionSecurityState,
  hasRequiredScope,
  originAllowed,
  readSecurityConfig,
  validateSecurityConfig,
  verifyFrameHmac
} from "../src/server/security.js";

test("security config keeps message limits enabled for open profile", () => {
  const config = readSecurityConfig({ R2TG_SECURITY_PROFILE: "open" }, { enabled: false });

  assert.equal(config.profile, "open");
  assert.equal(config.messageLimits.maxDatagramBytes, 4096);
  assert.equal(config.tokenAuth.enforceScope, false);
  assert.equal(config.rateLimit.enabled, false);
});

test("controlled profile requires token auth secret", () => {
  const config = readSecurityConfig({ R2TG_SECURITY_PROFILE: "controlled" }, { enabled: false });

  assert.throws(() => validateSecurityConfig(config, { enabled: false }), /R2TG_AUTH_SECRET/);
});

test("scope helper accepts admin and rejects missing scope", () => {
  assert.equal(hasRequiredScope({ scope: ["admin"] }, "control"), true);
  assert.equal(hasRequiredScope({ scope: ["api"] }, "control"), false);
});

test("rate limiter blocks after configured per-second threshold", () => {
  const runtime = createSecurityRuntime({
    rateLimit: {
      enabled: true,
      streamFramePerSecond: 2,
      onExceeded: "reject"
    }
  }, () => 1000);
  const state = createSessionSecurityState({
    authConfig: { enabled: false },
    securityRuntime: runtime
  });

  assert.equal(consumeRateLimit(state, "streamFrame").ok, true);
  assert.equal(consumeRateLimit(state, "streamFrame").ok, true);
  const limited = consumeRateLimit(state, "streamFrame");

  assert.equal(limited.ok, false);
  assert.equal(limited.status, 429);
});

test("replay helper rejects duplicate command ids", () => {
  const runtime = createSecurityRuntime({
    replayProtection: { enabled: true, ttlMs: 300000 },
    rateLimit: { enabled: false }
  }, () => 1000);
  const state = createSessionSecurityState({
    authConfig: { enabled: false },
    securityRuntime: runtime
  });

  assert.equal(checkReplay(state, "cmd-1").ok, true);
  const duplicate = checkReplay(state, "cmd-1");

  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.status, 409);
});

test("frame HMAC rejects missing signature when enabled", () => {
  const result = verifyFrameHmac({
    frameHmac: {
      enabled: true,
      secret: "separate-frame-secret"
    }
  }, { t: "api", id: "req-1", m: "GET", r: "/health" });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "frame_hmac_required");
});

test("frame HMAC accepts a valid compact API frame signature", () => {
  const secret = "separate-frame-secret";
  const packet = { t: "api", id: "req-1", m: "GET", r: "/health" };
  const sig = crypto
    .createHmac("sha256", secret)
    .update('{"id":"req-1","m":"GET","r":"/health","t":"api"}')
    .digest("base64url");

  const result = verifyFrameHmac({
    frameHmac: {
      enabled: true,
      secret
    }
  }, { ...packet, sig });

  assert.equal(result.ok, true);
});

test("origin allowlist accepts only configured origins", () => {
  const config = readSecurityConfig({
    R2TG_ORIGIN_ALLOWLIST_ENABLED: "1",
    R2TG_ORIGIN_ALLOWLIST: "https://app.example.com"
  }, { enabled: false });

  assert.equal(originAllowed(config, "https://app.example.com"), true);
  assert.equal(originAllowed(config, "https://evil.example.com"), false);
});
