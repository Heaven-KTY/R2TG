import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function pemCertificateToDer(certPem) {
  const base64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(base64, "base64");
}

function formatColonHex(buffer) {
  return buffer.toString("hex").toUpperCase().match(/.{2}/g).join(":");
}

function createSubjectAltName(host) {
  const ipVersion = net.isIP(host);
  return ipVersion ? { type: 7, ip: host } : { type: 2, value: host };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const force = hasFlag("force");
  const days = Number(readArg("days", "13"));
  const host = readArg("host", "r2tg.local");
  const certDir = path.resolve(rootDir, readArg("out", "certs"));
  const certPath = path.join(certDir, `${host}.crt`);
  const keyPath = path.join(certDir, `${host}.key`);
  const hashPath = path.join(certDir, `${host}.hash.json`);

  if (!Number.isInteger(days) || days < 1 || days > 13) {
    throw new Error("Use --days with an integer from 1 to 13 for WebTransport local certificate hashes.");
  }

  if (!force && (await exists(certPath)) && (await exists(keyPath)) && (await exists(hashPath))) {
    console.log(`Local certificate already exists: ${certPath}`);
    console.log("Use npm run cert:local -- --force to regenerate it.");
    return;
  }

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setDate(notAfterDate.getDate() + days);

  const pems = await selfsigned.generate(
    [{ name: "commonName", value: host }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate,
      notAfterDate,
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [createSubjectAltName(host)]
        }
      ]
    }
  );

  const der = pemCertificateToDer(pems.cert);
  const hash = crypto.createHash("sha256").update(der).digest();
  const hashJson = {
    algorithm: "sha-256",
    valueBase64: hash.toString("base64"),
    valueHex: formatColonHex(hash),
    cert: path.relative(rootDir, certPath).replaceAll("\\", "/"),
    key: path.relative(rootDir, keyPath).replaceAll("\\", "/"),
    notAfter: notAfterDate.toISOString()
  };

  await fs.mkdir(certDir, { recursive: true });
  await fs.writeFile(certPath, pems.cert, "utf8");
  await fs.writeFile(keyPath, pems.private, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(hashPath, `${JSON.stringify(hashJson, null, 2)}\n`, "utf8");

  console.log(`Created ${certPath}`);
  console.log(`Created ${keyPath}`);
  console.log(`Created ${hashPath}`);
  console.log(`SHA-256 ${hashJson.valueHex}`);
  console.log("Server defaults now pick these files up without R2TG_TLS_CERT/R2TG_TLS_KEY.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
