
import type { Context, Next } from "hono";

export async function authMiddleware(c: Context, next: Next) {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = auth.substring("Bearer ".length);
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return c.json({ error: "Malformed JWT" }, 401);
  }

  const header = JSON.parse(atob(headerB64));
  const payload = JSON.parse(atob(payloadB64));

  // Validate issuer + audience
  const issuerV2 = `https://login.microsoftonline.com/98ba7df7-316d-46fa-8823-37c4f90e7661/v2.0`;
  const issuerSTS = `https://sts.windows.net/98ba7df7-316d-46fa-8823-37c4f90e7661/`;
  const expectedAudience = "cbc35d7c-9e39-4546-bdb6-9a9452435dd9";

  if (payload.iss !== issuerV2 && payload.iss !== issuerSTS) {
    return c.json({ error: "Invalid issuer" }, 401);
  }

  if (payload.aud !== expectedAudience) {
    return c.json({ error: "Invalid audience" }, 403);
  }

  // Validate expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    return c.json({ error: "Token expired" }, 401);
  }

  // Fetch JWKS
  const jwksUrl = `https://login.microsoftonline.com/98ba7df7-316d-46fa-8823-37c4f90e7661/discovery/v2.0/keys`;
  const jwks = await fetch(jwksUrl).then(r => r.json());
  const jwk = jwks.keys.find((k: any) => k.kid === header.kid);

  if (!jwk) {
    return c.json({ error: "Unable to find matching JWK" }, 401);
  }

  // Verify signature
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const encoder = new TextEncoder();
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToUint8Array(signatureB64);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    data
  );

  if (!valid) {
    return c.json({ error: "Invalid token signature" }, 401);
  }

  // Attach identity to context
  c.set("user", payload);

  await next();
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}