import { createAuthToken } from "../src/server/authTokens.js";

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, fallback));
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a number`);
  }
  return value;
}

function main() {
  const secret = String(process.env.R2TG_AUTH_SECRET ?? "").trim();
  if (!secret) {
    throw new Error("Set R2TG_AUTH_SECRET before running npm run auth:token.");
  }

  const subject = readArg("subject", "browser-client");
  const scope = readArg("scope", "api,events");
  const ttlSeconds = readNumberArg("ttl", "3600");
  const { token, claims } = createAuthToken({
    secret,
    subject,
    scope,
    ttlSeconds
  });

  console.log(JSON.stringify({
    token_type: "R2TG-HMAC-SHA256",
    token,
    subject: claims.sub,
    scope: claims.scope,
    expires_at: new Date(claims.exp * 1000).toISOString()
  }, null, 2));
}

main();
