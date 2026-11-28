// Prueba del panel de plataforma contra una base TEMPORAL.
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) failures++; };
async function call(method, path, cookie, body) {
  const res = await fetch(BASE + path, { method, headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const login = (email, password) => call('POST', '/api/auth/login', null, { email, password });

const plat = (await login('admin@demo.olympo.test', pass)).cookie;
const sup = (await login('supervisora@demo.olympo.test', pass)).cookie;
check('supervisora no accede a plataforma', (await call('GET', '/api/platform/companies', sup)).status === 403);
check('me: es de plataforma', (await call('GET', '/api/auth/me', plat)).json.user.isPlatformAdmin === true);
let list = (await call('GET', '/api/platform/companies', plat)).json.companies;
check('lista: 1 empresa con cifras', list.length === 1 && list[0].sellers === 3 && list[0].lines === 3 && list[0].admins.length === 1, JSON.stringify(list));

const created = await call('POST', '/api/platform/companies', plat, { name: 'Cliente B', timezone: 'America/Bogota', adminName: 'Admin B', adminEmail: 'admin@clienteb.test', limits: { maxSellers: 1, maxLines: 1 } });
check('crear empresa', created.status === 200 && !!created.json.tempPassword, JSON.stringify(created.json));
check('zona horaria inválida se rechaza', (await call('POST', '/api/platform/companies', plat, { name: 'X Y', timezone: 'Marte/Olympus', adminName: 'A B', adminEmail: 'a@x.test' })).status === 400);
const bId = created.json.id;
let b = (await login('admin@clienteb.test', created.json.tempPassword)).cookie;
await call('POST', '/api/auth/change-password', b, { current: created.json.tempPassword, next: 'clave-cliente-b-123' });

// Límites del plan
const s1 = await call('POST', '/api/users', b, { name: 'Vendedora B1', email: 'v1@clienteb.test', role: 'seller' });
const s2 = await call('POST', '/api/users', b, { name: 'Vendedora B2', email: 'v2@clienteb.test', role: 'seller' });
check('límite de vendedoras', s1.status === 200 && s2.status === 409 && s2.json.error.code === 'limite_del_plan', JSON.stringify(s2.json));
const l1 = await call('POST', '/api/argos/lines', b, { label: 'Línea B1' });
const l2 = await call('POST', '/api/argos/lines', b, { label: 'Línea B2' });
check('límite de líneas', l1.status === 200 && l2.status === 409, JSON.stringify(l2.json));

// Aislamiento
const bUsers = (await call('GET', '/api/users', b)).json.users;
check('empresa B solo ve sus usuarios', bUsers.length === 2 && bUsers.every((u) => u.email.endsWith('clienteb.test')), JSON.stringify(bUsers.map((u) => u.email)));
check('empresa B no es de plataforma', (await call('GET', '/api/platform/companies', b)).status === 403);
check('admin demo no ve usuarios de B', !(await call('GET', '/api/users', plat)).json.users.some((u) => u.email.endsWith('clienteb.test')));
const demoLine = (await call('GET', '/api/argos/lines', plat)).json.lines[0];
check('B no puede editar una línea de otra empresa', (await call('PATCH', `/api/argos/lines/${demoLine.id}`, b, { label: 'hack' })).status === 404);

// Soporte
check('soporte sin permiso → 403', (await call('POST', `/api/platform/companies/${bId}/support`, plat)).status === 403);
check('B concede 4 h', (await call('POST', '/api/settings/support-access', b, { hours: 4 })).status === 200);
check('plataforma entra en soporte', (await call('POST', `/api/platform/companies/${bId}/support`, plat)).status === 200);
let me = (await call('GET', '/api/auth/me', plat)).json;
check('en soporte: empresa B, rol admin', me.support === true && me.company.name === 'Cliente B' && me.user.role === 'admin', JSON.stringify(me));
check('en soporte ve usuarios de B', (await call('GET', '/api/users', plat)).json.users.length === 2);
check('soporte no puede ampliarse el permiso', (await call('POST', '/api/settings/support-access', plat, { hours: 72 })).status === 403);
check('B revoca', (await call('DELETE', '/api/settings/support-access', b)).status === 200);
me = (await call('GET', '/api/auth/me', plat)).json;
check('tras revocar, la sesión vuelve a su empresa', me.support === false && me.company.name === 'Empresa de demostración', JSON.stringify(me.company));
const bAudit = (await call('GET', '/api/audit', b)).json.entries.map((e) => e.action);
check('auditoría de B registra plataforma y soporte', ['plataforma.empresa_creada', 'soporte.acceso_concedido', 'soporte.entrada', 'soporte.acceso_revocado'].every((a) => bAudit.includes(a)), JSON.stringify(bAudit));

// Suspensión
check('no se puede suspender la propia empresa', (await call('PATCH', `/api/platform/companies/${list[0].id}`, plat, { status: 'suspended' })).status === 400);
check('suspender B', (await call('PATCH', `/api/platform/companies/${bId}`, plat, { status: 'suspended', suspendedReason: 'pago pendiente' })).status === 200);
check('sesión de B queda cerrada', (await call('GET', '/api/auth/me', b)).status === 401);
const blocked = await login('admin@clienteb.test', 'clave-cliente-b-123');
check('B no puede iniciar sesión', blocked.status === 403 && blocked.json.error.code === 'empresa_suspendida', JSON.stringify(blocked.json));
check('reactivar B', (await call('PATCH', `/api/platform/companies/${bId}`, plat, { status: 'active' })).status === 200);
check('B vuelve a entrar', (await login('admin@clienteb.test', 'clave-cliente-b-123')).status === 200);

// Restablecer admin
list = (await call('GET', '/api/platform/companies', plat)).json.companies;
const bRow = list.find((c) => c.id === bId);
check('lista refleja límites y cifras de B', bRow.sellers === 1 && bRow.lines === 1 && bRow.limits.maxSellers === 1 && bRow.status === 'active', JSON.stringify(bRow));
const reset = await call('POST', `/api/platform/companies/${bId}/reset-admin`, plat, { userId: bRow.admins[0].id });
check('restablecer admin de B', reset.status === 200 && (await login('admin@clienteb.test', reset.json.tempPassword)).status === 200);
check('ampliar límite permite otra vendedora', (await call('PATCH', `/api/platform/companies/${bId}`, plat, { limits: { maxSellers: 5, maxLines: 1 } })).status === 200);
b = (await login('admin@clienteb.test', reset.json.tempPassword)).cookie;
await call('POST', '/api/auth/change-password', b, { current: reset.json.tempPassword, next: 'otra-clave-b-456' });
check('nueva vendedora tras ampliar', (await call('POST', '/api/users', b, { name: 'Vendedora B2', email: 'v2@clienteb.test', role: 'seller' })).status === 200);

console.log(failures ? `\n${failures} FALLOS` : '\nTODO OK');
process.exit(failures ? 1 : 0);
