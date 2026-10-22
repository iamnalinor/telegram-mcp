/**
 * Encoding and signing.
 *
 * Every token this connector hands out — OAuth codes, access and refresh
 * tokens, upload and download links — is a signed blob rather than a database
 * row, so issuing one costs nothing against D1's daily write budget. The
 * signing key is derived from the bot token, which makes it the one secret a
 * deployment has: rotate the bot token and every outstanding blob dies.
 *
 * Each blob names its kind (`k`), and verification insists on the kind it
 * expects, so a download link can never be replayed as an access token.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** SHA-256 as base64url. Used for PKCE challenges and for rate-limit keys. */
export async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(await sha256(value));
}

export function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const raw = typeof secret === "string" ? encoder.encode(secret) : secret;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hmac(key: CryptoKey, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** Compare two strings without leaking where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** Signed blob kinds. */
export type BlobKind =
  | "client" // dynamic client registration
  | "state" // our OAuth state, carried through Telegram's login
  | "code" // OAuth authorization code
  | "access"
  | "refresh"
  | "upload" // one-time file upload link
  | "file"; // file download link

interface Envelope {
  k: BlobKind;
  /** Expiry, epoch seconds. Absent means it never expires (client ids only). */
  exp?: number;
}

export async function sign<T extends object>(
  key: CryptoKey,
  kind: BlobKind,
  payload: T,
  ttlSeconds?: number,
): Promise<string> {
  const envelope: Envelope & T = {
    ...payload,
    k: kind,
    ...(ttlSeconds === undefined ? {} : { exp: nowSeconds() + ttlSeconds }),
  };
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(envelope)));
  return `${body}.${bytesToBase64Url(await hmac(key, body))}`;
}

/** The payload, or null when the blob is malformed, tampered with, of another kind, or expired. */
export async function verify<T extends object>(
  key: CryptoKey,
  kind: BlobKind,
  blob: string,
): Promise<(T & Envelope) | null> {
  const dot = blob.indexOf(".");
  if (dot <= 0) return null;
  const body = blob.slice(0, dot);
  const mac = blob.slice(dot + 1);

  let macBytes: Uint8Array;
  try {
    macBytes = base64UrlToBytes(mac);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify("HMAC", key, macBytes, encoder.encode(body));
  if (!valid) return null;

  let payload: T & Envelope;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(body))) as T & Envelope;
  } catch {
    return null;
  }
  if (payload.k !== kind) return null;
  if (payload.exp !== undefined && payload.exp < nowSeconds()) return null;
  return payload;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomId(bytes = 12): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
