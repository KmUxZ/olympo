import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 400)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const sup = await login('supervisora'), v1 = await login('vendedora1');
const items = [{ name: 'Faja', qty: 1, price: 90000 }];
const mk = async (name, phone) => (await call('POST', '/api/hermes/orders', sup, { customerName: name, phone, address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali', items })).json.id;
const reply = (id, b) => call('POST', `/api/hermes/orders/${id}/simulate-reply`, sup, b);
const chats = async (qs = '') => (await call('GET', `/api/hermes/chats${qs}`, sup)).json;
const find = (list, id) => list.chats.find((c) => c.id === id);

const a = await mk('Ana Uno', '3000000001');   // quedará esperando al cliente
const b = await mk('Beto Dos', '3000000002');  // escribirá algo libre → te toca
const c = await mk('Caro Tres', '3000000003'); // confirmará → en curso
await reply(b, { text: '¿tienen otro color?' });
await reply(c, { payload: 'CONFIRMAR' });
let all = await chats();
check('pelota: cliente / persona / proceso', find(all, a).ball === 'cliente' && find(all, b).ball === 'persona' && find(all, c).ball === 'proceso', all.chats.map((x) => [x.customerName, x.ball]));
check('contadores por pelota', all.counts.persona === 1 && all.counts.cliente === 1 && all.counts.proceso === 1, all.counts);
check('la que te toca va primero', all.chats[0].id === b);
check('último mensaje y remitente', find(all, b).lastBody.includes('le paso tu mensaje al equipo') && find(all, a).lastDirection === 'out' && find(all, a).lastSender === 'Hermes', find(all, b));
check('tiempo de espera', !!find(all, b).waitingSince && !!find(all, a).waitingSince && find(all, c).waitingSince === null);
check('filtro por pelota', (await chats('?ball=persona')).chats.length === 1 && (await chats('?ball=cerrado')).chats.length === 0);
check('búsqueda', (await chats('?q=beto')).chats.length === 1);
check('sin leer hasta abrir', find(all, b).unread === true && find(all, a).unread === false);
await call('POST', `/api/hermes/orders/${b}/seen`, sup);
check('al abrir queda leído', find(await chats(), b).unread === false);

// Responder como persona: deja de tocarte y ahora se espera al cliente
await call('POST', `/api/hermes/orders/${b}/message`, sup, { body: 'Sí, también en negro.' });
all = await chats();
check('tras responder ya no te toca', find(all, b).ball === 'cliente' && all.counts.persona === undefined, find(all, b));

// Tomar la conversación: el bot no responde aunque el cliente pulse un botón
await call('POST', `/api/hermes/orders/${a}/takeover`, sup, { paused: true });
await reply(a, { payload: 'CONFIRMAR' });
let d = (await call('GET', `/api/hermes/orders/${a}`, sup)).json;
check('con el bot en pausa no confirma solo', d.order.status === 'por_confirmar' && d.order.botPaused === true && d.order.attention === true && d.messages.at(-1).direction === 'in', d.order);
check('queda en el historial quién la tomó', d.events.some((e) => e.type === 'bot_pausado' && e.detail.includes('Supervisora Demo')) && d.order.takenBy === 'Supervisora Demo');
await call('POST', `/api/hermes/orders/${a}/takeover`, sup, { paused: false });
await reply(a, { payload: 'CONFIRMAR' });
d = (await call('GET', `/api/hermes/orders/${a}`, sup)).json;
check('al devolverla, el bot vuelve a actuar', d.order.status === 'confirmado' && d.order.botPaused === false && d.events.some((e) => e.type === 'bot_reanudado'), d.order);

// Reenviar confirmación
const before = (await call('GET', `/api/hermes/orders/${b}`, sup)).json.messages.filter((m) => m.template === 'hermes_confirmacion').length;
check('reenviar confirmación', (await call('POST', `/api/hermes/orders/${b}/resend-confirmation`, sup)).status === 200 && (await call('GET', `/api/hermes/orders/${b}`, sup)).json.messages.filter((m) => m.template === 'hermes_confirmacion').length === before + 1);
check('no se reenvía si ya está confirmado', (await call('POST', `/api/hermes/orders/${a}/resend-confirmation`, sup)).status === 400);
check('vendedora no entra a la bandeja', (await call('GET', '/api/hermes/chats', v1)).status === 403 && (await call('POST', `/api/hermes/orders/${a}/takeover`, v1, { paused: true })).status === 403);
console.log(f ? `\n${f} FALLOS` : '\nTODO OK'); process.exit(f ? 1 : 0);
