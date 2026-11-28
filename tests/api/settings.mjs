import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const adm = (await call('POST', '/api/auth/login', null, { email: 'admin@demo.olympo.test', password: pass })).cookie;
console.log('inicial', JSON.stringify((await call('GET', '/api/hermes/settings', adm)).json));
// Como lo envía la página vieja (sin noReplyAction)
let r = await call('PUT', '/api/hermes/settings', adm, { reminderMinutes: [30, 90], escalateMinutes: 60, botName: 'Valentina' });
console.log('guardar viejo', r.status, JSON.stringify(r.json));
console.log('leer', JSON.stringify((await call('GET', '/api/hermes/settings', adm)).json));
r = await call('PUT', '/api/hermes/settings', adm, { reminderMinutes: [30, 90], escalateMinutes: 60, botName: 'Valentina', noReplyAction: 'confirmar' });
console.log('guardar nuevo', r.status, JSON.stringify(r.json));
console.log('leer', JSON.stringify((await call('GET', '/api/hermes/settings', adm)).json));
console.log('TODO OK');
