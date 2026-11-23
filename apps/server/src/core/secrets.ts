import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';

// Cifrado de credenciales de integraciones (tokens de terceros) antes de guardarlas en la base.
// Clave: variable OLYMPO_SECRET_KEY (idealmente 32 bytes en base64; cualquier otro texto largo y secreto también sirve). En desarrollo, si no existe, se genera
// una en data/secret.key (fuera de git). En producción debe definirse la variable.
function loadKey(): Buffer {
  const fromEnv = process.env.OLYMPO_SECRET_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64');
    // Si no son exactamente 32 bytes en base64 (p. ej. un valor generado por el hosting), se deriva una clave de 32 bytes del texto.
    return key.length === 32 ? key : createHash('sha256').update(fromEnv, 'utf8').digest();
  }
  const file = join(config.dataDir, 'secret.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  const key = randomBytes(32);
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}

let cached: Buffer | null = null;
const key = () => (cached ??= loadKey());

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Formato de secreto no reconocido.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
