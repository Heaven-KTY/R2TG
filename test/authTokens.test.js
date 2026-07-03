import test from "node:test";
import assert from "node:assert/strict";
import { createAuthToken, readAuthConfig, verifyAuthToken } from "../src/server/authTokens.js";

const secret = "test-secret-that-is-long-enough-for-hmac";

test("auth token verifies signed claims", () => {
  const { token, claims } = createAuthToken({
    secret,
    subject: "browser-client",
    scope: "api,events",
    ttlSeconds: 60,
    now: () => 100000
  });

  const result = verifyAuthToken(token, {
    secret,
    now: () => 100000
  });

  assert.equal(result.ok, true);
  assert.equal(result.claims.sub, "browser-client");
  assert.deepEqual(result.claims.scope, ["api", "events"]);
  assert.equal(result.claims.exp, claims.exp);
  assert.ok(token.length < 130);
});

test("auth token rejects tampered payload", () => {
  const { token } = createAuthToken({
    secret,
    subject: "browser-client",
    ttlSeconds: 60,
    now: () => 100000
  });
  const [prefix, payload, signature] = token.split(".");
  const tampered = `${prefix}.${payload.slice(0, -1)}a.${signature}`;

  const result = verifyAuthToken(tampered, {
    secret,
    now: () => 100000
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error.code, "auth_token_invalid");
});

test("auth token rejects expired tokens", () => {
  const { token } = createAuthToken({
    secret,
    subject: "browser-client",
    ttlSeconds: 60,
    now: () => 100000
  });

  const result = verifyAuthToken(token, {
    secret,
    now: () => 200000,
    clockSkewSeconds: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error.code, "auth_token_expired");
});

test("auth config is enabled only when R2TG_AUTH_SECRET exists", () => {
  assert.deepEqual(readAuthConfig({}), {
    enabled: false,
    secret: ""
  });
  assert.deepEqual(readAuthConfig({ R2TG_AUTH_SECRET: "abc" }), {
    enabled: true,
    secret: "abc"
  });
});
