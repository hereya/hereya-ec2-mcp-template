import * as http from "node:http";
import * as crypto from "node:crypto";

const OAUTH_SERVER_URL = process.env.OAUTH_SERVER_URL || "http://localhost:5173";
const BOUND_ORG_ID = process.env.BOUND_ORG_ID || "";

// --- JWKS cache ---
interface JWK { kty: string; n: string; e: string; alg?: string; kid?: string; use?: string }
interface JWKS { keys: JWK[] }
let cachedJwks: JWKS | null = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : http;
    mod.get(url, (res: http.IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function getJwks(): Promise<JWKS> {
  const now = Date.now();
  if (cachedJwks && now - jwksCachedAt < JWKS_CACHE_TTL_MS) return cachedJwks;
  const jwks = (await fetchJson(`${OAUTH_SERVER_URL}/.well-known/jwks.json`)) as JWKS;
  cachedJwks = jwks;
  jwksCachedAt = now;
  return jwks;
}

function base64urlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyRS256(token: string, jwk: JWK): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  const isValid = crypto.verify(
    "sha256", Buffer.from(`${headerB64}.${payloadB64}`),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    base64urlDecode(signatureB64),
  );
  if (!isValid) return null;
  return JSON.parse(base64urlDecode(payloadB64).toString());
}

export interface TokenValidationSuccess {
  valid: true;
  claims: Record<string, unknown>;
}

export interface TokenValidationFailure {
  valid: false;
  reason: string;
}

export type TokenValidationResult = TokenValidationSuccess | TokenValidationFailure;

export async function validateToken(authHeader: string | undefined): Promise<TokenValidationResult> {
  if (!authHeader?.startsWith("Bearer ")) return { valid: false, reason: "Missing or invalid Authorization header" };
  const token = authHeader.slice(7);
  try {
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(base64urlDecode(headerB64).toString()) as { alg: string; kid?: string };
    if (header.alg !== "RS256") return { valid: false, reason: "Unsupported algorithm" };
    const jwks = await getJwks();
    const jwk = header.kid ? jwks.keys.find(k => k.kid === header.kid) : jwks.keys[0];
    if (!jwk) return { valid: false, reason: "No matching key in JWKS" };
    const payload = verifyRS256(token, jwk);
    if (!payload) return { valid: false, reason: "Invalid signature" };
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < now) return { valid: false, reason: "Token expired" };
    if (BOUND_ORG_ID && payload.org_id !== BOUND_ORG_ID) return { valid: false, reason: `org_id mismatch: expected ${BOUND_ORG_ID}, got ${payload.org_id}` };
    return { valid: true, claims: payload };
  } catch (e) {
    return { valid: false, reason: String(e) };
  }
}

export function getOAuthServerUrl(): string {
  return OAUTH_SERVER_URL;
}

export function getBoundOrgId(): string {
  return BOUND_ORG_ID;
}
