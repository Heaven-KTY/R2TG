# Local TLS Certificate

WebTransport needs HTTPS. For local R2TG testing, generate a short-lived self-signed certificate:

```powershell
npm run cert:local
```

This creates:

```text
certs/r2tg.local.crt
certs/r2tg.local.key
certs/r2tg.local.hash.json
```

The server automatically uses `certs/r2tg.local.crt` and `certs/r2tg.local.key` when `R2TG_TLS_CERT` and `R2TG_TLS_KEY` are not set.

```powershell
npm start
```

To regenerate:

```powershell
npm run cert:local -- --force
```

To create a certificate for the host or LAN IP clients will actually use:

```powershell
npm run cert:local -- --host=r2tg.example.com --force
```

To use a different certificate:

```powershell
$env:R2TG_TLS_CERT = "C:\path\server.crt"
$env:R2TG_TLS_KEY = "C:\path\server.key"
npm start
```

For browser-side certificate hash testing, read `valueBase64` from the generated hash JSON:

```js
const client = new R2TGClient({
  url: "https://r2tg.example.com:4433/r2tg",
  serverCertificateHashBase64: "PASTE_VALUE_BASE64_HERE"
});

await client.connect();
```

This certificate hash is not an API token or secret. Use [token auth](auth.md) for API access control.

The generated certificate uses ECDSA P-256 and is limited to 13 days because WebTransport certificate-hash workflows require short-lived X.509v3 certificates for local/self-signed testing.
