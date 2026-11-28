// Prueba de seguridad activa contra una copia LOCAL y temporal (nunca producción).
// Uso: node sec.mjs <credenciales-demo.txt> <contraseña de la empresa B>  (la crea tests/prep/sec-setup.ts)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
// El inventario de rutas se saca del código cada vez: una ruta nueva entra sola a la prueba.
const SRC = fileURLToPath(new URL('../../apps/server/src/', import.meta.url));
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
const routes = [];
for (const file of sources(SRC)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /\b(?:app|scope)\.(get|post|put|patch|delete)\('([^']+)'(.*)/.exec(line);
    if (!m) continue;
    const g = /guardPlatform\(/.test(m[3]) ? '[PLATAFORMA]' : (/guard\(([^)]*)\)/.exec(m[3])?.[1] ?? null);
    routes.push({ method: m[1].toUpperCase(), path: m[2], guard: g === null ? '[SIN GUARDA]' : g === '[PLATAFORMA]' ? g : `[${g}]` });
  }
}
const passB = process.argv[3];
const out = []; let f = 0;
const check = (id, name, ok, detail = '') => { out.push({ id, name, ok, detail }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${id} ${name} ${ok ? '' : JSON.stringify(detail).slice(0, 700)}`); if (!ok) f++; };
const call = async (m, p, cookie, body, headers = {}) => {
  const r = await fetch(BASE + p, { method: m, redirect: 'manual', headers: { ...(m !== 'GET' && m !== 'HEAD' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: m !== 'GET' && m !== 'HEAD' ? JSON.stringify(body ?? {}) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* no es JSON */ }
  return { status: r.status, json, text, headers: r.headers };
};
const login = async (email, password = pass) => { const r = await call('POST', '/api/auth/login', null, { email, password }); return r.headers.get('set-cookie')?.split(';')[0] ?? null; };
const UUID = '00000000-0000-4000-8000-000000000000';
const fill = (p) => p.replace(/:key/g, 'A'.repeat(43)).replace(/:token/g, 'A'.repeat(16)).replace(/:\w+/g, UUID);

const adm = await login('admin@demo.olympo.test'), sup = await login('supervisora@demo.olympo.test'), v1 = await login('vendedora1@demo.olympo.test'), v2 = await login('vendedora2@demo.olympo.test');
const admB = await login('admin@b.test', passB), venB = await login('vende@b.test', passB);
check('P0', 'las seis sesiones de prueba abren', [adm, sup, v1, v2, admB, venB].every(Boolean), [adm, sup, v1, v2, admB, venB].map(Boolean));

// ── A. Sin sesión ──
const PUBLIC = new Set(['/api/auth/login', '/api/health', '/api/hermes/webhook/pancake/:key', '/api/hermes/webhook/hoko/:key', '/g/:token']);
const open = [];
for (const r of routes) {
  if (PUBLIC.has(r.path)) continue;
  const res = await call(r.method, fill(r.path));
  if (res.status !== 401) open.push(`${r.method} ${r.path} → ${res.status}`);
}
check('P2', 'el inventario encontró las rutas del servidor', routes.length > 140 && routes.filter((r) => r.guard === '[SIN GUARDA]').every((r) => PUBLIC.has(r.path)), [routes.length, routes.filter((r) => r.guard === '[SIN GUARDA]' && !PUBLIC.has(r.path))]);
check('A1', `las ${routes.length - PUBLIC.size} rutas privadas rechazan a quien no tiene sesión (401)`, open.length === 0, open);
check('A2', 'un token de sesión inventado no sirve', (await call('GET', '/api/auth/me', 'olympo_session=' + 'x'.repeat(43))).status === 401 && (await call('GET', '/api/auth/me', null, null, { authorization: 'Bearer ' + 'x'.repeat(43) })).status === 401);
const wh = [await call('POST', '/api/hermes/webhook/hoko/' + 'A'.repeat(43), null, { order_id: 1, last_state: 2 }), await call('POST', '/api/hermes/webhook/pancake/' + 'A'.repeat(43), null, {}), await call('GET', '/g/' + 'A'.repeat(16))];
check('A3', 'webhooks y enlace público con clave inventada responden 404, sin dar pistas', wh.every((r) => r.status === 404), wh.map((r) => r.status));

// ── B. Permisos por rol ──
const leaks = [];
for (const r of routes) {
  const g = r.guard;
  if (g === "['admin']" || g === "['admin','supervisor']" || g === "['admin', 'supervisor']" || g === "['admin','supervisor']" ) { /* se evalúa abajo */ }
  const adminOnly = /^\['admin'\]$/.test(g), staff = /^\['admin', ?'supervisor'\]$/.test(g), platform = g === '[PLATAFORMA]';
  if (!adminOnly && !staff && !platform) continue;
  for (const [who, cookie] of [['vendedora', v1], ...(adminOnly || platform ? [['supervisora', sup]] : []), ...(platform ? [['admin de empresa', adm]] : [])]) {
    const res = await call(r.method, fill(r.path), cookie, {}, { origin: BASE });
    if (res.status !== 403) leaks.push(`${who}: ${r.method} ${r.path} → ${res.status}`);
  }
}
check('B1', 'ninguna ruta de administrador, supervisión o plataforma responde a un rol inferior (403)', leaks.length === 0, leaks);

// ── Datos de la empresa A para las pruebas de aislamiento ──
const O = { origin: BASE };
const order = (await call('POST', '/api/hermes/orders', v1, { customerName: 'Cliente Uno', phone: '3001110001', address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] }, O)).json;
const order2 = (await call('POST', '/api/hermes/orders', v2, { customerName: 'Cliente Dos', phone: '3001110002', address: 'Calle 11 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] }, O)).json;
const operator = (await call('POST', '/api/hermes/operators', adm, { name: 'Hoko', carrier: 'Hoko' }, O)).json;
await call('POST', `/api/hermes/operators/${operator.id}/connect`, adm, { driver: 'hoko' }, O);
const users = (await call('GET', '/api/users', adm)).json.users ?? [];
const product = (await call('POST', '/api/athena/products', adm, { name: 'Buzo', price: 80000, description: '', offers: '' }, O)).json;
const conv = (await call('POST', '/api/athena/simulate', adm, { text: 'hola' }, O)).json;
check('P1', 'datos de prueba creados en la empresa A', Boolean(order.id && order2.id && operator.id && users.length), [order, order2, operator, users.length, product, conv]);
const sellerA = users.find((u) => u.email === 'vendedora1@demo.olympo.test');

// ── C. Aislamiento entre empresas ──
const cross = [];
const tryB = async (m, p, body) => { const r = await call(m, p, admB, body, O); if (![403, 404, 400].includes(r.status)) cross.push(`${m} ${p} → ${r.status} ${r.text.slice(0, 80)}`); return r; };
await tryB('GET', `/api/hermes/orders/${order.id}`);
await tryB('POST', `/api/hermes/orders/${order.id}/action`, { action: 'cancelar', reason: 'x' });
await tryB('POST', `/api/hermes/orders/${order.id}/office-note`, { note: 'intruso' });
await tryB('POST', `/api/hermes/orders/${order.id}/office`, {});
await tryB('PUT', `/api/hermes/orders/${order.id}/correction`, { customerName: 'Hack', phone: '3001110001', address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'x', qty: 1, price: 1 }] });
await tryB('PATCH', `/api/hermes/operators/${operator.id}`, { name: 'Robado', carrier: 'x', active: true });
await tryB('PUT', `/api/hermes/operators/${operator.id}/account`, { email: 'a@b.co', password: 'x' });
await tryB('DELETE', `/api/hermes/operators/${operator.id}/account`);
await tryB('GET', `/api/hermes/operators/${operator.id}/events`);
await tryB('GET', `/api/hermes/export?operatorId=${operator.id}`);
await tryB('POST', '/api/hermes/export', { operatorId: operator.id, includeUnassigned: true });
await tryB('PUT', `/api/hermes/operators/${operator.id}/export-config`, { carrier: 'X', stockId: 1 });
await tryB('POST', '/api/hermes/orders/assign-operator', { operatorId: operator.id, orderIds: [order.id] });
if (sellerA) { await tryB('PATCH', `/api/users/${sellerA.id}`, { name: 'Hack', role: 'admin', status: 'active', teamId: null }); await tryB('POST', `/api/users/${sellerA.id}/reset-password`, {}); }
if (product.id) { await tryB('PUT', `/api/athena/products/${product.id}`, { name: 'Hack', price: 1, description: '', offers: '', active: true }); await tryB('DELETE', `/api/athena/products/${product.id}`); }
if (conv.conversationId || conv.id) { const cid = conv.conversationId ?? conv.id; await tryB('GET', `/api/athena/conversations/${cid}`); await tryB('POST', `/api/athena/conversations/${cid}/message`, { body: 'intruso' }); await tryB('POST', `/api/athena/conversations/${cid}/takeover`, {}); }
check('C1', 'el administrador de otra empresa no puede leer ni cambiar nada de esta (pedidos, operadores, usuarios, catálogo, conversaciones)', cross.length === 0, cross);
const listsB = await Promise.all(['/api/hermes/orders', '/api/hermes/operators', '/api/users', '/api/athena/products', '/api/athena/conversations', '/api/zeus/customers', '/api/audit', '/api/argos/shifts', '/api/hermes/office', '/api/hermes/incidents'].map(async (p) => [p, (await call('GET', p, admB)).text]));
const seen = listsB.filter(([, t]) => /Cliente Uno|Cliente Dos|3001110001|demo\.olympo\.test|Vendedora Demo/.test(t)).map(([p]) => p);
check('C2', 'los listados de la otra empresa no muestran datos de esta', seen.length === 0, seen);
const after = (await call('GET', `/api/hermes/orders/${order.id}`, adm)).json;
check('C3', 'tras los intentos, el pedido de la empresa A sigue intacto', after.order?.customerName === 'Cliente Uno' && after.order?.status !== 'cancelado' && !JSON.stringify(after).includes('intruso'), after.order);

// ── D. Acceso entre personas de la misma empresa ──
check('D1', 'una vendedora no abre el pedido de otra vendedora', [403, 404].includes((await call('GET', `/api/hermes/orders/${order.id}`, v2)).status));
check('D2', 'una vendedora no ve en su lista los pedidos de otra', !(await call('GET', '/api/hermes/orders', v2)).text.includes('Cliente Uno'));
const d3 = await call('PUT', `/api/hermes/orders/${order.id}/correction`, v2, { customerName: 'Hack', phone: '3001110001', address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'x', qty: 1, price: 1 }] }, O);
check('D3', 'una vendedora no corrige el pedido de otra', [403, 404, 400].includes(d3.status), d3.status);
const forged = (await call('POST', '/api/hermes/orders', v1, { customerName: 'Cliente Tres', phone: '3001110003', address: 'Calle 12 # 5-20 apto 1', neighborhood: 'Centro', city: 'Cali', sellerUserId: users.find((u) => u.email === 'vendedora2@demo.olympo.test')?.id, items: [{ name: 'Faja', qty: 1, price: 90000 }] }, O)).json;
const forgedDetail = (await call('GET', `/api/hermes/orders/${forged.id}`, adm)).json;
check('D4', 'una vendedora no puede atribuirle su venta a otra persona', forgedDetail.order?.sellerUserId === sellerA?.id, forgedDetail.order?.sellerUserId);
const esc = await call('PATCH', `/api/users/${sellerA?.id}`, v1, { name: 'Vendedora', role: 'admin', status: 'active', teamId: null }, O);
check('D5', 'una vendedora no puede subirse el rol', esc.status === 403 && (await call('GET', '/api/auth/me', v1)).json.user.role === 'seller', esc.status);

// ── E. Peticiones forjadas desde otro sitio (CSRF) ──
const body = { customerName: 'Forjado', phone: '3001119999', address: 'Calle 10 # 5-20 apto 2', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'x', qty: 1, price: 1000 }] };
check('E1', 'una escritura con cookie desde otro origen se rechaza', (await call('POST', '/api/hermes/orders', sup, body, { origin: 'https://sitio-malo.example' })).status === 403);
check('E2', 'una escritura con cookie marcada por el navegador como de otro sitio se rechaza', (await call('POST', '/api/hermes/orders', sup, body, { 'sec-fetch-site': 'cross-site' })).status === 403);
const e3 = await call('POST', '/api/hermes/orders', sup, body);
check('E3', 'sin Origin ni Sec-Fetch-Site la escritura pasa (solo clientes que no son navegador)', [200, 201].includes(e3.status), e3.status);
const cookieLine = (await call('POST', '/api/auth/login', null, { email: 'supervisora@demo.olympo.test', password: pass })).headers.get('set-cookie') ?? '';
check('E4', 'la cookie de sesión es HttpOnly y SameSite=Lax', /HttpOnly/i.test(cookieLine) && /SameSite=Lax/i.test(cookieLine), cookieLine.replace(/=[^;]+/, '=…'));

// ── F. Entradas maliciosas ──
const inj = ["' OR '1'='1", "'; DROP TABLE hermes_orders;--", '%27%20OR%201=1--', '\\', '{{7*7}}', '<script>alert(1)</script>'];
const injRes = [];
for (const q of inj) for (const p of ['/api/hermes/orders?search=', '/api/zeus/customers?search=', '/api/audit?search=', '/api/hermes/orders?tab=']) { const r = await call('GET', p + encodeURIComponent(q), adm); if (r.status >= 500 || /syntax error|relation|pg_|postgres/i.test(r.text)) injRes.push(`${p}${q} → ${r.status}`); }
check('F1', 'los buscadores no dejan pasar inyección de SQL ni revelan errores de la base', injRes.length === 0 && (await call('GET', '/api/hermes/orders', adm)).status === 200, injRes);
const xss = (await call('POST', '/api/hermes/orders', sup, { customerName: '<img src=x onerror=alert(1)>', phone: '3001118888', address: 'Calle 10 # 5-20 apto 3', neighborhood: 'Centro', city: 'Cali', items: [{ name: '<script>alert(1)</script>', qty: 1, price: 1000 }] }, O));
check('F2', 'texto con HTML se guarda como texto y la API responde JSON, no HTML', [200, 201].includes(xss.status) && ((await call('GET', `/api/hermes/orders/${xss.json.id}`, adm)).headers.get('content-type') ?? '').includes('application/json'), xss.status);
check('F3', 'un cuerpo de más de 1 MB se rechaza', (await call('POST', '/api/hermes/orders', sup, { customerName: 'x'.repeat(1_200_000) }, O)).status === 413);
check('F4', 'identificadores que no son UUID se rechazan sin error interno', [400, 404].includes((await call('GET', "/api/hermes/orders/1' OR 1=1--", adm)).status) && [400, 404].includes((await call('GET', '/api/hermes/orders/%2e%2e%2f%2e%2e%2fusers', adm)).status) && [400, 404].includes((await call('GET', '/api/hermes/orders/00000000-0000-4000-8000-00000000000g', adm)).status));
const trav = await Promise.all(['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/render.yaml', '/assets/..%2f..%2f..%2fapps/server/src/config.ts', '/.env', '/.git/config'].map((p) => call('GET', p)));
check('F5', 'no se pueden leer archivos del servidor fuera de la web', trav.every((r) => r.status === 404 || /<!doctype html>/i.test(r.text)) && !trav.some((r) => /"workspaces"|databases:|process\.env|\[core\]/.test(r.text)), trav.map((r) => r.status));
const err = await call('POST', '/api/hermes/orders', sup, 'esto no es json', { origin: BASE });
check('F6', 'los errores no muestran rutas internas ni trazas', !/at .*\.ts|node_modules|D:\\|\/src\//.test(err.text + (await call('GET', '/api/no-existe', adm)).text));

// ── G. Fuerza bruta ──
let last = 0, tries = 0;
for (let i = 0; i < 12; i++) { last = (await call('POST', '/api/auth/login', null, { email: 'vendedora3@demo.olympo.test', password: 'mala-' + i })).status; tries++; if (last === 429) break; }
check('G1', `tras 10 contraseñas malas la cuenta se bloquea 15 minutos (bloqueó al intento ${tries})`, last === 429 && tries === 11, [last, tries]);
check('G2', 'con la cuenta bloqueada, ni la contraseña correcta entra', (await call('POST', '/api/auth/login', null, { email: 'vendedora3@demo.olympo.test', password: pass })).status === 429);
const t0 = Date.now(); await call('POST', '/api/auth/login', null, { email: 'no-existe-1@demo.olympo.test', password: 'x' }); const tNo = Date.now() - t0;
const t1 = Date.now(); await call('POST', '/api/auth/login', null, { email: 'vendedora2@demo.olympo.test', password: 'x' }); const tSi = Date.now() - t1;
check('G3', `el inicio de sesión tarda parecido exista o no el correo (${tNo} ms y ${tSi} ms): no se pueden enumerar cuentas`, Math.abs(tNo - tSi) < 150, [tNo, tSi]);
const badMsg = [(await call('POST', '/api/auth/login', null, { email: 'no-existe-2@demo.olympo.test', password: 'x' })).json.error?.message, (await call('POST', '/api/auth/login', null, { email: 'admin@demo.olympo.test', password: 'x' })).json.error?.message];
check('G4', 'el mensaje de error es el mismo exista o no el correo', badMsg[0] === badMsg[1] && Boolean(badMsg[0]), badMsg);

// ── H. Sesiones ──
const tmp = await login('vendedora2@demo.olympo.test');
await call('POST', '/api/auth/logout', tmp, {}, O);
check('H1', 'al cerrar sesión, la cookie anterior deja de servir', (await call('GET', '/api/auth/me', tmp)).status === 401);
check('H2', 'una contraseña nueva de menos de 10 caracteres se rechaza', (await call('POST', '/api/auth/change-password', v1, { current: pass, next: 'corta123' }, O)).status === 400);

// ── I. Cabeceras ──
const h = (await call('GET', '/api/health')).headers;
const need = { 'content-security-policy': /default-src 'self'/, 'x-content-type-options': /nosniff/, 'x-frame-options': /DENY/, 'referrer-policy': /strict-origin/, 'cache-control': /no-store/, 'cross-origin-opener-policy': /same-origin/ };
const missing = Object.entries(need).filter(([k, re]) => !re.test(h.get(k) ?? '')).map(([k]) => k);
check('I1', 'las respuestas llevan las cabeceras de seguridad', missing.length === 0, missing);
check('I2', 'el servidor no anuncia su tecnología', !h.get('x-powered-by') && !h.get('server'), [h.get('x-powered-by'), h.get('server')]);
check('I3', 'no se aceptan peticiones de otros orígenes (sin cabeceras CORS)', !(await call('GET', '/api/health', null, null, { origin: 'https://sitio-malo.example' })).headers.get('access-control-allow-origin'));

console.log(`\n${out.length} comprobaciones · ${f} con hallazgo`);
console.log('RESUMEN ' + JSON.stringify(out.filter((x) => !x.ok).map((x) => ({ id: x.id, name: x.name, detail: x.detail }))));
process.exit(f ? 1 : 0);
