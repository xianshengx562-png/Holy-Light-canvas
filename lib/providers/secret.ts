import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Per-deployment key material. Prefer an explicit ENCRYPTION_KEY; otherwise derive from DATABASE_URL. */
const algorithm = 'aes-256-gcm';
const salt = 'frame-secret-v1';
let cached: Buffer | null = null;

function keyMaterial() {
  if (cached) return cached;
  const configured = process.env.ENCRYPTION_KEY?.trim();
  if (configured) {
    const raw = Buffer.from(configured, 'base64');
    cached = raw.length === 32 ? raw : scryptSync(configured, salt, 32);
    return cached;
  }
  cached = scryptSync(process.env.DATABASE_URL || 'frame-local-development', salt, 32);
  return cached;
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, keyMaterial(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptSecret(payload: string) {
  const [iv, tag, body] = payload.split('.');
  if (!iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv(algorithm, keyMaterial(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function maskSecret(value: string) {
  return value.length <= 10 ? '••••••••' : `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}
