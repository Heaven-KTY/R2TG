import crypto from "node:crypto";
import { stableStringify } from "../core/stableJson.js";

const SECURITY_PROFILES = new Set(["open", "basic", "controlled", "strict"]);

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function envNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProfile(value) {
  const profile = String(value ?? "basic").trim().toLowerCase();
  return SECURITY_PROFILES.has(profile) ? profile : "basic";
}

function profileDefaults(profile) {
  return {
    enforceScope: profile === "controlled" || profile === "strict",
    rateLimit: profile === "basic" || profile === "controlled" || profile === "strict",
    replayProtection: profile === "controlled" || profile === "strict",
    frameHmac: profile === "strict",
    originAllowlist: profile === "strict",
    requireAuthSecret: profile === "controlled" || profile === "strict"
  };
}

function normalizeScopes(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function packetForSignature(packet) {
  if (!packet || typeof packet !== "object") {
    return packet;
  }

  const output = Array.isArray(packet) ? [] : {};
  for (const key of Object.keys(packet)) {
    if (key === "sig" || key === "hmac") {
      continue;
    }
    const value = packet[key];
    if (value && typeof value === "object") {
      output[key] = packetForSignature(value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function signPacket(packet, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(stableStringify(packetForSignature(packet)))
    .digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "base64url");
  const rightBuffer = Buffer.from(String(right ?? ""), "base64url");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createRateExceeded(action) {
  return {
    ok: false,
    action,
    status: 429,
    error: {
      code: "rate_limited",
      message: "R2TG rate limit exceeded"
    }
  };
}

export function readSecurityConfig(env = process.env, authConfig = { enabled: false }) {
  const profile = normalizeProfile(env.R2TG_SECURITY_PROFILE);
  const defaults = profileDefaults(profile);
  const originAllowlist = parseCsv(env.R2TG_ORIGIN_ALLOWLIST);

  return {
    profile,
    messageLimits: {
      maxDatagramBytes: envNumber(env.R2TG_MAX_DATAGRAM_BYTES, 4096),
      maxStreamFrameBytes: envNumber(env.R2TG_MAX_STREAM_FRAME_BYTES, 65536),
      maxPendingStreamBufferBytes: envNumber(env.R2TG_MAX_PENDING_STREAM_BUFFER_BYTES, 262144)
    },
    tokenAuth: {
      enabled: authConfig.enabled,
      requireSecret: defaults.requireAuthSecret,
      enforceScope: envFlag(env.R2TG_ENFORCE_SCOPE, defaults.enforceScope)
    },
    rateLimit: {
      enabled: envFlag(env.R2TG_RATE_LIMIT, defaults.rateLimit),
      datagramPerSecond: envNumber(env.R2TG_RATE_LIMIT_DATAGRAM_PER_SECOND, 100),
      streamFramePerSecond: envNumber(env.R2TG_RATE_LIMIT_STREAM_FRAME_PER_SECOND, 30),
      commandPerSecond: envNumber(env.R2TG_RATE_LIMIT_COMMAND_PER_SECOND, 10),
      onExceeded: String(env.R2TG_RATE_LIMIT_ON_EXCEEDED ?? "drop")
    },
    replayProtection: {
      enabled: envFlag(env.R2TG_REPLAY_PROTECTION, defaults.replayProtection),
      ttlMs: envNumber(env.R2TG_REPLAY_TTL_MS, 300000)
    },
    frameHmac: {
      enabled: envFlag(env.R2TG_FRAME_HMAC, defaults.frameHmac),
      secret: String(env.R2TG_FRAME_HMAC_SECRET ?? "")
    },
    originAllowlist: {
      enabled: envFlag(env.R2TG_ORIGIN_ALLOWLIST_ENABLED, defaults.originAllowlist || originAllowlist.length > 0),
      origins: originAllowlist
    }
  };
}

export function validateSecurityConfig(config, authConfig) {
  if (config.tokenAuth.requireSecret && !authConfig.enabled) {
    throw new Error(`R2TG_SECURITY_PROFILE=${config.profile} requires R2TG_AUTH_SECRET.`);
  }

  if (config.frameHmac.enabled && !config.frameHmac.secret) {
    throw new Error("R2TG_FRAME_HMAC_SECRET is required when frame HMAC is enabled.");
  }

  if (config.profile === "strict" && config.originAllowlist.enabled) {
    if (config.originAllowlist.origins.length === 0) {
      throw new Error("R2TG_SECURITY_PROFILE=strict requires R2TG_ORIGIN_ALLOWLIST.");
    }
    if (config.originAllowlist.origins.some((origin) => origin === "*" || origin.includes("*"))) {
      throw new Error("R2TG_SECURITY_PROFILE=strict does not allow wildcard origins.");
    }
  }
}

export function createSecurityRuntime(config, now = () => Date.now()) {
  return {
    config,
    now,
    replayIds: new Map()
  };
}

export function createSessionSecurityState({ authConfig, securityRuntime }) {
  return {
    config: authConfig,
    security: securityRuntime.config,
    runtime: securityRuntime,
    authenticated: !authConfig.enabled,
    claims: null,
    rateWindows: new Map()
  };
}

export function hasRequiredScope(claims, requiredScope) {
  const required = normalizeScopes(requiredScope);
  if (required.length === 0) {
    return true;
  }

  const granted = new Set(normalizeScopes(claims?.scope));
  if (granted.has("admin")) {
    return true;
  }

  return required.every((scope) => granted.has(scope));
}

export function consumeRateLimit(authState, key) {
  const config = authState.security.rateLimit;
  if (!config.enabled) {
    return { ok: true };
  }

  const limit = {
    datagram: config.datagramPerSecond,
    streamFrame: config.streamFramePerSecond,
    command: config.commandPerSecond
  }[key];

  if (!limit) {
    return { ok: true };
  }

  const now = authState.runtime.now();
  const windowStartedAt = Math.floor(now / 1000) * 1000;
  const current = authState.rateWindows.get(key);

  if (!current || current.windowStartedAt !== windowStartedAt) {
    authState.rateWindows.set(key, { windowStartedAt, count: 1 });
    return { ok: true };
  }

  current.count += 1;
  if (current.count > limit) {
    return createRateExceeded(config.onExceeded);
  }

  return { ok: true };
}

export function checkReplay(authState, commandId) {
  const config = authState.security.replayProtection;
  if (!config.enabled) {
    return { ok: true };
  }

  const id = String(commandId ?? "").trim();
  if (!id) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "command_id_required",
        message: "command_id is required for replay-protected routes"
      }
    };
  }

  const now = authState.runtime.now();
  for (const [key, expiresAt] of authState.runtime.replayIds.entries()) {
    if (expiresAt <= now) {
      authState.runtime.replayIds.delete(key);
    }
  }

  if (authState.runtime.replayIds.has(id)) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "duplicate_command_id",
        message: "command_id was already processed"
      }
    };
  }

  authState.runtime.replayIds.set(id, now + config.ttlMs);
  return { ok: true };
}

export function verifyFrameHmac(config, packet) {
  if (!config.frameHmac.enabled) {
    return { ok: true };
  }

  const signature = packet?.sig ?? packet?.hmac;
  if (!signature) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "frame_hmac_required",
        message: "frame HMAC signature is required"
      }
    };
  }

  const expected = signPacket(packet, config.frameHmac.secret);
  if (!safeEqual(signature, expected)) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "frame_hmac_invalid",
        message: "frame HMAC signature is invalid"
      }
    };
  }

  return { ok: true };
}

export function originAllowed(config, origin) {
  if (!config.originAllowlist.enabled) {
    return true;
  }

  if (!origin) {
    return false;
  }

  return config.originAllowlist.origins.includes(origin);
}

export function corsHeadersForOrigin(config, origin) {
  if (config.originAllowlist.enabled) {
    if (!originAllowed(config, origin)) {
      return null;
    }
    return {
      "access-control-allow-origin": origin,
      "vary": "origin"
    };
  }

  return {
    "access-control-allow-origin": "*"
  };
}

export function describeSecurityConfig(config) {
  return {
    profile: config.profile,
    messageLimits: config.messageLimits,
    tokenAuth: {
      enabled: config.tokenAuth.enabled,
      enforceScope: config.tokenAuth.enforceScope
    },
    rateLimit: {
      enabled: config.rateLimit.enabled,
      datagramPerSecond: config.rateLimit.datagramPerSecond,
      streamFramePerSecond: config.rateLimit.streamFramePerSecond,
      commandPerSecond: config.rateLimit.commandPerSecond
    },
    replayProtection: {
      enabled: config.replayProtection.enabled
    },
    frameHmac: {
      enabled: config.frameHmac.enabled
    },
    originAllowlist: {
      enabled: config.originAllowlist.enabled,
      origins: config.originAllowlist.origins
    }
  };
}
