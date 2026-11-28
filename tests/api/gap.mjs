import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : String(x).slice(0, 300)}`); if (!c) f++; };
const call = async (m, p, t, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const tok = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass, client: 'extension' })).json.token;
const minute = (agoMin) => new Date(Math.floor((Date.now() - agoMin * 60000) / 60000) * 60000).toISOString();

// Caso 1: reaparece tras 5 h sin señal, sin minutos guardados → se cierra en el último dato
const t1 = await tok('vendedora1');
const s1 = (await call('GET', '/api/argos/me/state', t1)).json.shift;
const r1 = await call('POST', `/api/argos/shifts/${s1.id}/sync`, t1, { sentAt: new Date().toISOString(), minutes: [{ minute: minute(0), systemState: 'active', tools: [] }] });
check('reaparece tras hueco largo → turno cerrado', r1.json.shift?.status === 'ended' && r1.json.accepted === 0, JSON.stringify(r1.json));
const d1 = (await call('GET', `/api/argos/shifts/${s1.id}`, t1)).json;
const durH = (new Date(d1.shift.endedAt) - new Date(d1.shift.startedAt)) / 3600000;
check('cerrado en la hora del último dato (≈2 h de turno, no 7)', d1.shift.endReason === 'automatico' && Math.abs(durH - 2) < 0.1, `${durH} ${d1.shift.endReason}`);
check('puede iniciar un turno nuevo', (await call('POST', '/api/argos/shifts/start', t1)).json.alreadyActive === false);

// Caso 2: estuvo sin conexión pero trabajando: llegan los minutos guardados que cubren el hueco → sigue abierto
const t2 = await tok('vendedora2');
const s2 = (await call('GET', '/api/argos/me/state', t2)).json.shift;
const backlog = []; for (let m = 290; m >= 0; m -= 5) backlog.push({ minute: minute(m), systemState: 'active', tools: [] });
const r2 = await call('POST', `/api/argos/shifts/${s2.id}/sync`, t2, { sentAt: new Date().toISOString(), minutes: backlog });
check('minutos guardados sin conexión → turno sigue abierto', r2.json.shift?.status === 'active' && r2.json.accepted === backlog.length, JSON.stringify(r2.json).slice(0, 200));
console.log(f ? `\n${f} FALLOS` : '\nTODO OK'); process.exit(f ? 1 : 0);
