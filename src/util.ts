const enc = new TextEncoder();
const dec = new TextDecoder();

export const now = (): number => Date.now();

export const DAY_MS = 86_400_000;

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time-ish string compare (leaks only length). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function randomId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic small hash — used to rotate public comment replies. */
export function strHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function b64urlEncode(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return dec.decode(Uint8Array.from(atob(t), (c) => c.charCodeAt(0)));
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Replace {username} placeholders; falls back to "there". */
export function render(tpl: string, username: string | null | undefined): string {
  return (tpl || "").replace(/\{username\}/g, username || "there");
}

/** Signed, expiring token embedded in tracked /go/<token> link buttons. */
export async function makeGoToken(secret: string, igsid: string, mediaId: string, ttlDays = 90): Promise<string> {
  const payload = b64urlEncode(JSON.stringify({ i: igsid, m: mediaId, e: now() + ttlDays * DAY_MS }));
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyGoToken(secret: string, token: string): Promise<{ i: string; m: string } | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmacHex(secret, payload))) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload)) as { i?: string; m?: string; e?: number };
    if (!data.i || !data.m || typeof data.e !== "number" || data.e < now()) return null;
    return { i: data.i, m: data.m };
  } catch {
    return null;
  }
}
