import crypto from "node:crypto";

const TOKEN_PREFIX = "r2tg1";
const DEFAULT_CLOCK_SKEW_SECONDS = 30;

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url");
}

function signTokenPart(payloadPart, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${TOKEN_PREFIX}.${payloadPart}`)
    .digest("base64url");
}

function safeEqualBase64Url(left, right) {
  let leftBytes;
  let rightBytes;

  try {
    leftBytes = base64UrlDecode(left);
    rightBytes = base64UrlDecode(right);
  } catch {
    return false;
  }

  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function normalizeScope(scope) {
  if (Array.isArray(scope)) {
    return scope.map(String).filter(Boolean);
  }
  return String(scope ?? "api,events")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function encodeScope(scope) {
  return normalizeScope(scope).join(",");
}

function normalizeClaims(claims) {
  const normalized = {
    sub: String(claims.sub ?? claims.s ?? "client"),
    scope: normalizeScope(claims.scope ?? claims.c ?? ""),
    exp: Number(claims.exp ?? claims.e)
  };

  const issuedAt = Number(claims.iat ?? claims.i);
  if (Number.isFinite(issuedAt)) {
    normalized.iat = issuedAt;
  }

  const tokenId = claims.jti ?? claims.j;
  if (tokenId) {
    normalized.jti = String(tokenId);
  }

  return normalized;
}

export function readAuthConfig(env = process.env) {
  const secret = String(env.R2TG_AUTH_SECRET ?? "").trim();

  return {
    enabled: Boolean(secret),
    secret
  };
}

export function createAuthToken({
  secret,
  subject = "client",
  scope = ["api", "events"],
  ttlSeconds = 3600,
  tokenId = null,
  now = () => Date.now()
} = {}) {
  if (!secret) {
    throw new Error("secret is required");
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("ttlSeconds must be a positive number");
  }

  const issuedAt = Math.floor(now() / 1000);
  const expiresAt = issuedAt + Math.floor(ttlSeconds);
  const payload = {
    s: String(subject || "client"),
    c: encodeScope(scope),
    e: expiresAt
  };

  if (tokenId) {
    payload.j = String(tokenId);
  }

  const payloadPart = base64UrlJson(payload);
  const signaturePart = signTokenPart(payloadPart, secret);

  return {
    token: `${TOKEN_PREFIX}.${payloadPart}.${signaturePart}`,
    claims: normalizeClaims(payload)
  };
}

export function verifyAuthToken(token, {
  secret,
  now = () => Date.now(),
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS
} = {}) {
  if (!secret) {
    return {
      ok: false,
      status: 500,
      error: {
        code: "auth_not_configured",
        message: "R2TG auth is enabled but no secret is configured"
      }
    };
  }

  if (typeof token !== "string" || !token.trim()) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "auth_token_missing",
        message: "auth token is required"
      }
    };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "auth_token_invalid",
        message: "auth token format is invalid"
      }
    };
  }

  const [, payloadPart, signaturePart] = parts;
  const expectedSignature = signTokenPart(payloadPart, secret);
  if (!safeEqualBase64Url(signaturePart, expectedSignature)) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "auth_token_invalid",
        message: "auth token signature is invalid"
      }
    };
  }

  let claims;
  try {
    claims = normalizeClaims(JSON.parse(base64UrlDecode(payloadPart).toString("utf8")));
  } catch {
    return {
      ok: false,
      status: 401,
      error: {
        code: "auth_token_invalid",
        message: "auth token payload is invalid"
      }
    };
  }

  const nowSeconds = Math.floor(now() / 1000);
  const skew = Math.max(0, Number(clockSkewSeconds) || 0);

  if (!Number.isFinite(claims.exp)) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "auth_token_invalid",
        message: "auth token expiration is missing"
      }
    };
  }

  if (claims.exp + skew < nowSeconds) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "auth_token_expired",
        message: "auth token is expired"
      }
    };
  }

  if (Number.isFinite(claims.iat) && claims.iat - skew > nowSeconds) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "auth_token_invalid",
        message: "auth token was issued in the future"
      }
    };
  }

  return {
    ok: true,
    status: 200,
    claims
  };
}
