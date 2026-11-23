// Argos · descarga de la extensión lista para instalar, y saber si esta persona ya la conectó.
// El ZIP sale con la dirección de este servidor ya puesta, para que nadie tenga que escribirla.
import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { config } from '../config.ts';
import { db } from '../db/db.ts';
import { guard } from '../core/http.ts';

const EXTENSION_DIR = resolve(import.meta.dirname, '../../../extension');
const LOCAL = 'http://localhost:4000';

/** Dirección pública de este servidor, tal como la debe usar la extensión. */
export function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${config.port}`).replace(/\/+$/, '');
}

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

/** Arma un ZIP estándar (compresión deflate) con los archivos dados. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // Fecha fija en formato DOS (2026-01-01 00:00): el contenido es lo que importa.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** La extensión con la dirección de este servidor en lugar de la de desarrollo. */
export function buildExtensionZip(serverUrl: string): Buffer {
  const files = listFiles(EXTENSION_DIR).map((name) => {
    let data = readFileSync(join(EXTENSION_DIR, name));
    if (name === 'manifest.json' || name === 'background.js' || name === 'popup.js') data = Buffer.from(data.toString('utf8').replaceAll(LOCAL, serverUrl), 'utf8');
    return { name, data };
  });
  return zip(files);
}

export function extensionVersion(): string {
  return JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).version;
}

export function extensionRoutes(app: FastifyInstance): void {
  app.get('/api/argos/extension.zip', guard(), async (_req, reply) => {
    const body = buildExtensionZip(publicUrl());
    return reply.header('content-type', 'application/zip').header('content-disposition', 'attachment; filename="Argos.zip"').header('cache-control', 'no-store').send(body);
  });

  /** ¿Esta persona ya inició sesión en la extensión? La guía de instalación lo consulta para saber cuándo terminar. */
  app.get('/api/argos/extension/status', guard(), async (req) => {
    const { rows } = await db.query(
      `SELECT max(last_used_at) AS "lastSeenAt" FROM core_sessions WHERE user_id = $1 AND client = 'extension' AND revoked_at IS NULL AND expires_at > now()`,
      [req.ctx.userId],
    );
    return { connected: Boolean(rows[0]?.lastSeenAt), lastSeenAt: rows[0]?.lastSeenAt ?? null, version: extensionVersion(), serverUrl: publicUrl() };
  });
}
