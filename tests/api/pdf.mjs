// El servidor debe arrancar con HOKO_API_URL=http://127.0.0.1:4191/api
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 600)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' && m !== 'DELETE' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' && m !== 'DELETE' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hoko de mentira
const hoko = { logins: 0, orders: 0, token: 'tok-1', guides: { 9101: 'https://hoko.test/print-guide/9101/0/aaa', 9102: null, 9666: 'https://sitio-malo.example/guia.pdf', 9667: 'https://hoko.test.sitio-malo.example/guia.pdf' } };
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.method === 'POST' && req.url === '/api/login') {
      hoko.logins++;
      return body.includes('clave-buena') ? send(200, { token: hoko.token }) : send(422, { message: 'Credenciales inválidas' });
    }
    const m = /^\/api\/member\/order\/(\d+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) {
      hoko.orders++;
      if (req.headers.authorization !== `Bearer ${hoko.token}`) return send(401, { status: 'error', code: 'INVALID_TOKEN' });
      if (!(m[1] in hoko.guides)) return send(404, { message: 'Orden no encontrada' });
      const pdf = hoko.guides[m[1]];
      return send(200, { id: Number(m[1]), guide: pdf ? { number: '2400' + m[1], state: 2 } : null, ...(pdf ? { guide_pdf: pdf } : {}) });
    }
    if (req.method === 'GET' && req.url === '/api/member/store') return req.headers.authorization === `Bearer ${hoko.token}` ? send(200, { id: 321, name: 'Mi Tienda' }) : send(401, { status: 'error' });
    send(404, { message: 'no' });
  });
});
await new Promise((r) => mock.listen(4191, '127.0.0.1', r));

const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const adm = await login('admin'), sup = await login('supervisora');
const H = (await call('POST', '/api/hermes/operators', adm, { name: 'Hoko', carrier: 'Interrapidísimo' })).json.id;
await call('POST', `/api/hermes/operators/${H}/connect`, adm, { driver: 'hoko' });
let r = await call('GET', '/api/hermes/operators', adm);
const hookPath = new URL(r.json.operators[0].webhookUrl).pathname;
const hook = async (body) => { await fetch(BASE + hookPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); await sleep(400); };
const order = async (name, phone) => { const o = (await call('POST', '/api/hermes/orders', sup, { customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] })).json; await call('POST', `/api/hermes/orders/${o.id}/action`, sup, { action: 'confirmar' }); return o; };
const get = async (id) => (await call('GET', `/api/hermes/orders/${id}`, sup)).json;
const guideMsg = (d) => d.messages.find((m) => m.direction === 'out' && m.body.includes('ya va en camino'));
const open = (path) => fetch(BASE + path, { redirect: 'manual' });

// Sin cuenta: la guía sale sin enlace
const o0 = await order('Ana Cero', '3004440000');
await hook({ order_id: 9100, number: '24009100', last_state: 2, phone: '3004440000' });
check('sin cuenta conectada, el mensaje no lleva enlace', guideMsg(await get(o0.id)) && !guideMsg(await get(o0.id)).body.includes('/g/'), guideMsg(await get(o0.id)));

// Conectar la cuenta
check('supervisora no conecta la cuenta', (await call('PUT', `/api/hermes/operators/${H}/account`, sup, { email: 'tienda@ejemplo.co', password: 'clave-buena' })).status === 403);
r = await call('PUT', `/api/hermes/operators/${H}/account`, adm, { email: 'tienda@ejemplo.co', password: 'clave-mala' });
check('contraseña mala se rechaza', r.status === 400 && /rechazó/.test(JSON.stringify(r.json)), r);
r = await call('PUT', `/api/hermes/operators/${H}/account`, adm, { email: 'tienda@ejemplo.co', password: 'clave-buena' });
check('contraseña buena conecta', r.status === 200, r);
r = await call('GET', '/api/hermes/operators', adm);
const raw = JSON.stringify(r.json);
check('muestra la tienda de Hoko de la cuenta', r.json.operators[0].accountStore === 'Mi Tienda (n.º 321)', r.json.operators[0]);
check('admin ve la cuenta conectada, nunca la contraseña ni el token', r.json.operators[0].hasAccount === true && r.json.operators[0].accountEmail === 'tienda@ejemplo.co' && !raw.includes('clave-buena') && !raw.includes('tok-1') && !raw.includes('api_password'), raw);
r = await call('GET', '/api/hermes/operators', sup);
check('supervisora no ve el correo de la cuenta', r.json.operators[0].accountEmail === '' && !JSON.stringify(r.json).includes('tienda@ejemplo.co'), r.json);

// Con cuenta: el mensaje lleva el enlace y abre el PDF
const o1 = await order('Ana Uno', '3004440001');
await hook({ order_id: 9101, number: '24009101', last_state: 2, phone: '3004440001' });
const m1 = guideMsg(await get(o1.id));
const link = /\/g\/[A-Za-z0-9_-]{12,40}/.exec(m1?.body ?? '')?.[0];
check('con cuenta, el mensaje lleva el enlace al PDF', Boolean(link) && m1.body.includes('📄 Ábrela aquí: http'), m1);
const before = hoko.orders;
let res = await open(link);
check('el enlace redirige al PDF de Hoko, sin sesión', res.status === 302 && res.headers.get('location') === 'https://hoko.test/print-guide/9101/0/aaa', { s: res.status, l: res.headers.get('location') });
res = await open(link);
check('la segunda vez no vuelve a consultar a Hoko', res.status === 302 && hoko.orders === before + 1, hoko);

// Token vencido: vuelve a iniciar sesión solo
const o2 = await order('Beto Dos', '3004440002');
hoko.guides[9103] = 'https://hoko.test/print-guide/9103/0/bbb';
await hook({ order_id: 9103, number: '24009103', last_state: 2, phone: '3004440002' });
const link2 = /\/g\/[A-Za-z0-9_-]{12,40}/.exec(guideMsg(await get(o2.id))?.body ?? '')?.[0];
hoko.token = 'tok-2';
const loginsBefore = hoko.logins;
res = await open(link2);
check('con la sesión vencida vuelve a entrar y abre el PDF', res.status === 302 && res.headers.get('location')?.endsWith('/bbb') && hoko.logins === loginsBefore + 1, { s: res.status, logins: hoko.logins });

// Guía aún no generada
const o3 = await order('Caro Tres', '3004440003');
await hook({ order_id: 9102, number: '24009102', last_state: 2, phone: '3004440003' });
const link3 = /\/g\/[A-Za-z0-9_-]{12,40}/.exec(guideMsg(await get(o3.id))?.body ?? '')?.[0];
res = await open(link3);
const html = await res.text();
check('si el PDF aún no existe, lo explica', res.status === 503 && html.includes('se está generando') && (res.headers.get('content-type') ?? '').includes('text/html'), { s: res.status, html: html.slice(0, 120) });
check('enlace inventado → 404', (await open('/g/' + 'B'.repeat(16))).status === 404);
// El operador devuelve un enlace que no es de su sitio: no se redirige
for (const [n, ref, phone] of [[1, 9666, '3004440066'], [2, 9667, '3004440067']]) {
  const ox = await order('Ajeno ' + n, phone);
  await hook({ order_id: ref, number: '2400' + ref, last_state: 2, phone });
  const lx = /[/]g[/][A-Za-z0-9_-]{12,40}/.exec(guideMsg(await get(ox.id))?.body ?? '')?.[0];
  res = await open(lx);
  check('enlace de otro dominio (' + n + '): no se redirige', res.status === 503 && !res.headers.get('location'), { s: res.status, l: res.headers.get('location') });
}
await open(link);

// Hoko rechaza la consulta: el motivo queda a la vista del administrador
const o4 = await order('Dani Cuatro', '3004440077');
await hook({ order_id: 9777, number: '24009777', last_state: 2, phone: '3004440077' });
const link4 = /\/g\/[A-Za-z0-9_-]{12,40}/.exec(guideMsg(await get(o4.id))?.body ?? '')?.[0];
res = await open(link4);
check('si Hoko no conoce la orden, el cliente ve un mensaje amable', res.status === 503 && (await res.text()).includes('No pudimos abrir'), res.status);
let ops = (await call('GET', '/api/hermes/operators', adm)).json.operators[0];
check('el motivo queda en el operador', /9777/.test(ops.accountError ?? '') && /no encuentra esa orden/.test(ops.accountError) && Boolean(ops.accountErrorAt), ops);
await open(link);


// Quitar la cuenta
r = await call('DELETE', `/api/hermes/operators/${H}/account`, adm);
check('quitar la cuenta', r.status === 200 && (await call('GET', '/api/hermes/operators', adm)).json.operators[0].hasAccount === false, r);
res = await open(link);
check('un enlace ya consultado sigue abriendo mientras esté vigente', res.status === 302);
mock.close();
console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
process.exit(f ? 1 : 0);
