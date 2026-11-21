import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config.ts';

export interface QueryResult<T> {
  rows: T[];
  count: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const wrap = (r: { rows: any[]; rowCount: number | null }) => ({ rows: r.rows, count: r.rowCount ?? 0 });
  return {
    kind: 'postgres',
    query: async (sql, params) => wrap(await pool.query(sql, params as any[])),
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: async (sql, params) => wrap(await client.query(sql, params as any[])) });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * La base embebida NO admite dos procesos a la vez: abrirla dos veces la corrompe.
 * Este bloqueo impide que un segundo servidor (p. ej. otro `npm run dev`) la toque.
 */
function acquireLock(dir: string): void {
  const lockFile = `${dir}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      process.on('exit', () => {
        try {
          if (readFileSync(lockFile, 'utf8') === String(process.pid)) unlinkSync(lockFile);
        } catch {}
      });
      return;
    } catch {
      const pid = Number(readFileSync(lockFile, 'utf8').trim());
      let alive = false;
      try {
        if (pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch (err) {
        alive = (err as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive) {
        console.error(`\nYa hay un servidor de OLYMPO usando esta base de datos (proceso ${pid}).\nNo hace falta iniciar otro: usa el que está en marcha o ciérralo primero.\n`);
        process.exit(1);
      }
      unlinkSync(lockFile); // bloqueo de un proceso que ya no existe
    }
  }
  throw new Error('No se pudo bloquear la base de datos local.');
}

async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  mkdirSync(dir, { recursive: true });
  acquireLock(dir);
  const pg = await PGlite.create(dir);
  const wrap = (r: { rows: any[]; affectedRows?: number }) => ({ rows: r.rows, count: r.affectedRows ?? r.rows.length });
  return {
    kind: 'pglite',
    query: async (sql, params) => wrap(await pg.query(sql, params as any[])),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    tx: (fn) =>
      pg.transaction(async (tx) => fn({ query: async (sql, params) => wrap(await tx.query(sql, params as any[])) })) as Promise<any>,
    close: () => pg.close(),
  };
}

async function migrate(db: Db): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = resolve(import.meta.dirname, 'migrations');
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    await db.exec(`BEGIN;\n${readFileSync(join(dir, file), 'utf8')}\nCOMMIT;`);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    console.log(`[db] migración aplicada: ${file}`);
  }
}

export const db: Db = config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite(join(config.dataDir, 'pglite'));
await migrate(db);

/**
 * Fragmento SQL para filtrar por una lista de UUID pasada como JSON en el parámetro $n.
 * Funciona igual en PostgreSQL y PGlite sin depender de la serialización de arrays.
 */
export function inIds(n: number): string {
  return `IN (SELECT value::uuid FROM jsonb_array_elements_text($${n}::jsonb))`;
}
