// Lanzador de las pruebas de OLYMPO.
//
//   npm test                 corre todas
//   npm test -- hermes hoko  corre solo las que se nombren
//   npm test -- --lista      muestra las que hay
//
// Cada prueba corre contra una base de datos TEMPORAL nueva, que se borra al terminar. Nunca toca la base de
// desarrollo ni producción. El servidor de prueba se arranca apuntando a servicios SIMULADOS: no puede escribirle
// a Hoko, a Pancake, a Google ni a la IA reales, aunque la máquina tenga sus credenciales configuradas.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES } from './suites.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'apps', 'server');
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = 4100;

/** Variables con las que arranca todo proceso de prueba: servicios simulados y ninguna credencial real. */
function testEnv(dataDir, extra = {}) {
  const env = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'DATABASE_URL', 'NODE_ENV', 'OLYMPO_SECRET_KEY', 'RENDER_EXTERNAL_URL']) delete env[key];
  return {
    ...env,
    DATA_DIR: dataDir,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    WEB_ORIGINS: 'http://localhost:5174',
    LOG_LEVEL: 'info',
    HOKO_API_URL: 'http://127.0.0.1:4191/api',
    HOKO_PDF_HOSTS: 'hoko.test',
    PANCAKE_API_URL: 'http://127.0.0.1:4199/v1',
    ATHENA_FORMS_URL: 'http://127.0.0.1:4192',
    ...extra,
  };
}

/** Corre un programa de Node y devuelve su salida completa. */
function run(file, args, env, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const portBusy = () => new Promise((resolve) => {
  const s = createConnection({ port: PORT, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(env) {
  const child = spawn(process.execPath, ['src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise((resolve) => child.on('close', resolve));
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    const ok = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok, () => false);
    if (ok) return { stop: async () => { child.kill(); await exited; }, log: () => log };
    await sleep(250);
  }
  child.kill();
  await exited;
  throw new Error(`El servidor de prueba no arrancó.\n${log.slice(-1500)}`);
}

/** Una prueba pasa si termina bien, no imprime ningún FAIL y declara su resultado. */
function verdict({ code, out }) {
  const fails = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));
  const declared = /TODO OK|· 0 con hallazgo/.test(out);
  return { ok: code === 0 && fails.length === 0 && declared, fails, checks: (out.match(/^OK {2}/gm) ?? []).length };
}

async function runSuite(suite) {
  const dataDir = mkdtempSync(join(tmpdir(), 'olympo-prueba-'));
  const secret = `Prueba-${randomBytes(9).toString('base64url')}`;
  const env = testEnv(dataDir, suite.env);
  const cred = join(dataDir, 'credenciales-demo.txt');
  const fill = (args = []) => args.map((a) => a.replace('{credenciales}', cred).replace('{secreto}', secret));
  let server = null;
  try {
    const seed = await run('src/seed.ts', [], env, SERVER);
    if (seed.code !== 0) return { ok: false, fails: ['No se pudo crear la base de prueba.'], out: seed.out, checks: 0 };
    // Algunas pruebas necesitan que la cuenta de administración opere la plataforma (panel de empresas).
    if (suite.platform) {
      const r = await run('src/seed.ts', ['--plataforma', 'admin@demo.olympo.test'], env, SERVER);
      if (r.code !== 0) return { ok: false, fails: ['No se pudo dar el rol de plataforma.'], out: r.out, checks: 0 };
    }
    // Preparación que escribe directo en la base: va antes de arrancar el servidor.
    for (const p of suite.prep ?? []) {
      const r = await run(join(HERE, 'prep', p.file), fill(p.args), env);
      if (r.code !== 0) return { ok: false, fails: [`Falló la preparación ${p.file}.`], out: r.out, checks: 0 };
    }
    if (suite.kind === 'api') server = await startServer(env);
    // Preparación que usa la API: va con el servidor arriba.
    for (const p of suite.prepApi ?? []) {
      const r = await run(join(HERE, 'prep', p.file), fill(p.args), env);
      if (r.code !== 0) return { ok: false, fails: [`Falló la preparación ${p.file}.`], out: r.out, checks: 0 };
    }
    const result = await run(join(HERE, suite.kind === 'api' ? 'api' : 'directo', suite.file), fill(suite.args ?? (suite.kind === 'api' ? ['{credenciales}'] : [])), env);
    return { ...verdict(result), out: result.out, log: server?.log() };
  } catch (err) {
    return { ok: false, fails: [String(err.message ?? err)], out: '', checks: 0 };
  } finally {
    if (server) await server.stop();
    // La carpeta la creó esta misma corrida con un nombre al azar: solo se borra esa.
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* en Windows a veces tarda en soltarse */ }
  }
}

const args = process.argv.slice(2);
if (args.includes('--lista')) {
  for (const s of SUITES) console.log(`${s.name.padEnd(22)} ${s.what}`);
  process.exit(0);
}
const verbose = args.includes('--detalle');
const wanted = args.filter((a) => !a.startsWith('--'));
const unknown = wanted.filter((w) => !SUITES.some((s) => s.name === w));
if (unknown.length) {
  console.error(`No existe la prueba: ${unknown.join(', ')}. Usa --lista para ver las que hay.`);
  process.exit(2);
}
const chosen = wanted.length ? SUITES.filter((s) => wanted.includes(s.name)) : SUITES;
if (await portBusy()) {
  console.error(`El puerto ${PORT} está ocupado. Cierra lo que lo esté usando (otro servidor de prueba) y vuelve a intentar.`);
  process.exit(2);
}

const started = Date.now();
const failed = [];
let checks = 0;
for (const suite of chosen) {
  const t = Date.now();
  const r = await runSuite(suite);
  checks += r.checks;
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  console.log(`${r.ok ? 'OK   ' : 'FALLA'} ${suite.name.padEnd(22)} ${String(r.checks).padStart(3)} comprobaciones · ${secs} s`);
  if (!r.ok) {
    failed.push(suite.name);
    for (const line of r.fails.slice(0, 12)) console.log(`      ${line.slice(0, 600)}`);
    if (!r.fails.length || verbose) console.log(r.out.split(/\r?\n/).slice(-25).map((l) => `      ${l}`).join('\n'));
  }
}
const total = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n${chosen.length - failed.length} de ${chosen.length} pruebas pasan · ${checks} comprobaciones · ${total} s`);
if (failed.length) console.log(`Fallan: ${failed.join(', ')}`);
process.exit(failed.length ? 1 : 0);
