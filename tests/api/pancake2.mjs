// Conector de Pancake en Hermes: cola de envíos, consulta de mensajes sin webhook y webhook opcional.
// Corre contra un Pancake de mentira dentro de esta misma prueba (puerto 4199).
// El servidor debe arrancar con PANCAKE_API_URL=http://127.0.0.1:4199/v1
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0, n = 0; const check = (name, c, x = '') => { n++; console.log(`${c ? 'OK  ' : 'FAIL'} ${name} ${c ? '' : JSON.stringify(x).slice(0, 500)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' && b !== undefined ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' && b !== undefined ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (email) => (await call('POST', '/api/auth/login', null, { email, password: pass })).cookie;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await wait(120); } return false; };

// ── Pancake de mentira ──
const PAGE = 'waba_1', TOKEN = 'tok-bueno-1234567890';
const stamp = (d = new Date()) => d.toISOString().replace('Z', '000'); // como Pancake: UTC, sin zona
const sent = []; const convs = {}; const updated = {}; const postTimes = []; let seq = 0;
const state = { throttle: 0, listBroken: false, gets: 0, lists: 0 };
const mock = createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (url.searchParams.get('page_access_token') !== TOKEN) return reply(401, { success: false, message: 'invalid token' });
    const m = /^\/(v1|v2)\/pages\/([^/]+)\/(users|conversations|conversations\/([^/]+)\/messages)$/.exec(url.pathname);
    if (!m || m[2] !== PAGE) return reply(404, { success: false });
    if (m[3] === 'users') return reply(200, { success: true, users: [] });
    if (m[3] === 'conversations') {
      state.lists++;
      if (m[1] !== 'v2' || state.listBroken) return reply(500, { success: false });
      const since = Number(url.searchParams.get('since')) * 1000;
      return reply(200, { success: true, conversations: Object.entries(updated).filter(([, at]) => at.getTime() >= since).map(([id, at]) => ({ id, type: 'INBOX', updated_at: stamp(at) })) });
    }
    const conv = decodeURIComponent(m[4]);
    if (req.method === 'GET') { state.gets++; return reply(200, { success: true, conversation_id: conv, messages: convs[conv] ?? [] }); }
    postTimes.push(Date.now());
    if (state.throttle > 0) { state.throttle--; return reply(429, { success: false }); }
    const body = JSON.parse(raw || '{}');
    if (body.template_id === 'tpl_malo') return reply(200, { success: false, message_code: 'template_not_found' });
    const id = `out_${++seq}`;
    sent.push({ conv, id, ...body });
    (convs[conv] ??= []).unshift({ id, message: body.message ?? '(plantilla)', inserted_at: stamp(), from: { id: PAGE, is_automated: true } });
    updated[conv] = new Date();
    reply(200, { success: true, id });
  });
});
await new Promise((r) => mock.listen(4199, '127.0.0.1', r));
/** El cliente (o quien se indique) escribe en WhatsApp: queda en el Pancake de mentira. Devuelve el aviso que Pancake mandaría. */
const inbound = (phone, id, message, from = { id: `cliente_${phone}`, name: 'Cliente' }, at = new Date()) => {
  const conv = `${PAGE}_${phone}`;
  (convs[conv] ??= []).unshift({ id, message, inserted_at: stamp(at), from });
  updated[conv] = new Date();
  return { page_id: PAGE, event_type: 'messaging', data: { conversation: { id: conv, type: 'INBOX' }, message: { id, conversation_id: conv, page_id: PAGE, message, type: 'INBOX', from } } };
};

try {
  const adm = await login('admin@demo.olympo.test'), sup = await login('supervisora@demo.olympo.test');
  const poll = () => call('POST', '/api/hermes/channel/poll', adm, {});
  let r = await call('GET', '/api/hermes/channel', adm);
  check('al empezar: modo simulado, sin conectar y con el catálogo de 11 plantillas', r.status === 200 && r.json.driver === 'simulado' && !r.json.hasToken && r.json.catalog.length === 12 && r.json.missing.length === 5, r.json);
  check('la supervisora no ve la conexión del canal', (await call('GET', '/api/hermes/channel', sup)).status === 403);
  check('no se puede activar sin conectar', (await call('POST', '/api/hermes/channel/activate', adm, { active: true })).json.error?.code === 'canal_incompleto');
  r = await call('PUT', '/api/hermes/channel', adm, { pageId: PAGE, token: 'token-equivocado-123', templates: {} });
  check('un token que Pancake rechaza no se guarda', r.status === 400 && r.json.error.code === 'pancake_rechazo' && !(await call('GET', '/api/hermes/channel', adm)).json.hasToken, r);
  const T = { hermes_confirmacion: 'tpl_conf', hermes_recordatorio: 'tpl_rec', hermes_guia: 'tpl_guia', hermes_novedad: 'tpl_nov' };
  r = await call('PUT', '/api/hermes/channel', adm, { pageId: PAGE, token: TOKEN, templates: { ...T, inventada: 'x' } });
  check('guarda la conexión comprobada, sin devolver el token', r.status === 200 && r.json.hasToken && r.json.missing.length === 0 && !('inventada' in r.json.templates) && !JSON.stringify(r.json).includes(TOKEN), r.json);
  const hook = new URL(r.json.webhookUrl).pathname;
  r = await call('POST', '/api/hermes/channel/test', adm, { phone: '3001112233', template: 'hermes_guia' });
  check('la prueba envía la plantilla con sus variables', r.status === 200 && sent.at(-1).template_id === 'tpl_guia' && sent.at(-1).conv === `${PAGE}_573001112233` && sent.at(-1).template_params.BODY_PARAMS.tracking_number, [r, sent.at(-1)]);
  check('consultar con el canal apagado avisa que no está activo', (await poll()).json.error?.code === 'canal_inactivo');
  r = await call('POST', '/api/hermes/channel/activate', adm, { active: true });
  check('se activa el envío real', r.status === 200 && r.json.driver === 'pancake', r);

  const order = async (phone, extra = {}) => (await call('POST', '/api/hermes/orders', adm, { customerName: 'Laura Gómez', phone, address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali', items: [{ free: true, name: '2 fajas talla M', qty: 1, price: 120000 }], ...extra })).json.id;
  const detail = async (id) => (await call('GET', `/api/hermes/orders/${id}`, adm)).json;
  const lastTo = (phone) => sent.filter((x) => x.conv === `${PAGE}_${phone}`).at(-1);

  // ── Envío por la cola ──
  const o1 = await order('3001234567');
  let d = await detail(o1);
  check('al crear el pedido la respuesta no espera a WhatsApp: el mensaje queda en cola o ya enviado', ['en_cola', 'enviado'].includes(d.messages.at(-1).status), d.messages.at(-1));
  check('la cola lo entrega enseguida como plantilla', await until(() => lastTo('573001234567')?.template_id === 'tpl_conf'), sent);
  let last = lastTo('573001234567');
  check('…con las variables por nombre y sin saltos de línea', last.template_params.BODY_PARAMS.customer_name === 'Laura' && /^H-/.test(last.template_params.BODY_PARAMS.order_code) && last.template_params.BODY_PARAMS.payment.includes('120.000') && Object.values(last.template_params.BODY_PARAMS).every((v) => typeof v === 'string' && v && !/\n/.test(v)), last.template_params);
  await until(async () => (await detail(o1)).messages.at(-1).status === 'enviado'); d = await detail(o1);
  check('queda como enviado, con el texto que recibe el cliente', d.messages.at(-1).status === 'enviado' && d.messages.at(-1).body.startsWith('Hola Laura 👋 Soy Hermes de'), d.messages.at(-1));

  // ── Consulta sin webhook ──
  inbound('573001234567', 'in_1', 'Confirmar pedido');
  r = await poll();
  check('la consulta encuentra la respuesta del cliente (sin webhook)', r.status === 200 && r.json.mode === 'lista' && r.json.processed === 1 && !r.json.error, r.json);
  d = await detail(o1);
  check('el cliente pulsó «Confirmar pedido»: el pedido queda confirmado', d.order.status === 'confirmado', d.order.status);
  check('la respuesta sale como texto libre (ventana de 24 h abierta)', await until(() => lastTo('573001234567')?.message?.includes('quedó confirmado')), lastTo('573001234567'));
  const count = (await detail(o1)).messages.length;
  r = await poll();
  check('consultar otra vez no repite nada', r.json.processed === 0 && (await detail(o1)).messages.length === count, r.json);
  r = await call('GET', '/api/hermes/channel', adm);
  check('la pantalla muestra cuándo fue la última consulta', r.json.poll.at && r.json.poll.status === 'lista', r.json.poll);

  // Lo anterior a la activación no se toca
  const o2 = await order('3009998877'); await until(() => lastTo('573009998877'));
  inbound('573009998877', 'viejo_1', 'Cancelar', undefined, new Date(Date.now() - 3 * 3600_000));
  await poll(); d = await detail(o2);
  check('un mensaje anterior a la activación del canal se ignora', d.order.status === 'por_confirmar' && !d.messages.some((m) => m.direction === 'in'), d.messages.map((m) => m.direction));

  // ── Webhook (opcional) ──
  r = await call('POST', hook, null, { page_id: PAGE, event_type: 'messaging', data: { conversation: { id: `${PAGE}_573009998877`, type: 'INBOX' }, message: { id: 'falso_1', conversation_id: `${PAGE}_573009998877`, page_id: PAGE, message: 'Cancelar', type: 'INBOX', from: { id: 'x' } } } });
  await wait(900); d = await detail(o2);
  check('aviso inventado (el mensaje no existe en Pancake): no pasa nada', r.status === 200 && d.order.status === 'por_confirmar' && !d.messages.some((m) => m.direction === 'in'), d.order.status);
  check('una dirección de avisos con clave equivocada no existe', (await call('POST', hook.replace(/.{6}$/, 'AAAAAA'), null, {})).status === 404);
  await call('POST', hook, null, inbound('573009998877', 'staff_1', 'Hola, soy Ana, ya te confirmo', { id: PAGE, admin_id: 'u1', admin_name: 'Ana' }));
  check('con webhook: lo que escribe el equipo desde Pancake queda en la conversación y el bot no actúa', await until(async () => (await detail(o2)).messages.some((m) => m.sender === 'Ana (desde Pancake)')) && (await detail(o2)).order.status === 'por_confirmar');
  await call('POST', hook, null, inbound('573009998877', 'in_2', 'no, ya no lo quiero'));
  check('con webhook: el cliente escribe «no…» y el pedido se cancela al instante', await until(async () => (await detail(o2)).order.status === 'cancelado'));
  await poll();
  check('webhook y consulta no duplican el mismo mensaje', (await detail(o2)).messages.filter((m) => m.direction === 'in').length === 1);

  // ── Si la lista de conversaciones no sirve: pedido a pedido ──
  state.listBroken = true;
  const o3 = await order('3005554433'); await until(() => lastTo('573005554433'));
  inbound('573005554433', 'in_3', 'Sí, confirmo');
  r = await poll(); d = await detail(o3);
  check('si Pancake no da la lista, consulta pedido a pedido y funciona igual', r.json.mode === 'pedidos' && !r.json.error && d.order.status === 'confirmado', [r.json, d.order.status]);
  const gets = state.gets; r = await poll();
  check('…sin volver a revisar enseguida los pedidos recién revisados', state.gets === gets, [gets, state.gets]);
  state.listBroken = false;

  // ── Ráfaga: muchos pedidos de golpe ──
  const s0 = sent.length; const t0 = postTimes.length;
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => order(`30077700${String(i).padStart(2, '0')}`)));
  check('12 pedidos a la vez: todos quedan creados sin esperar a WhatsApp', burst.every(Boolean));
  check('la cola los entrega todos', await until(() => sent.length === s0 + 12, 15000), sent.length - s0);
  const gaps = postTimes.slice(t0).map((t, i, a) => (i ? t - a[i - 1] : 999));
  check(`…a un ritmo que Pancake acepta (pausa mínima ${Math.min(...gaps)} ms)`, Math.min(...gaps) >= 200, gaps);

  // ── Pancake pide esperar ──
  state.throttle = 1;
  const o5 = await order('3002220001');
  check('si Pancake pide esperar una vez, se reintenta solo y sale', await until(() => lastTo('573002220001')?.template_id === 'tpl_conf', 8000));
  state.throttle = 3;
  const o6 = await order('3002220002');
  await until(async () => /Reintentando/.test((await detail(o6)).messages.at(-1).error ?? ''), 12000); d = await detail(o6);
  check('si sigue pidiendo esperar, el mensaje queda en cola para más tarde, sin alarmar', d.messages.at(-1).status === 'en_cola' && /Reintentando/.test(d.messages.at(-1).error) && d.order.attention === false, d.messages.at(-1));
  state.throttle = 0;
  r = await call('GET', '/api/hermes/channel', adm);
  check('la pantalla muestra cuántos mensajes hay en cola', r.json.queued === 1, r.json.queued);

  // ── Casos sin envío ──
  const s3 = sent.length;
  r = await call('POST', `/api/hermes/orders/${o5}/action`, adm, { action: 'confirmar' }); d = await detail(o5);
  check('aviso opcional sin plantilla y fuera de las 24 h: no se envía ni molesta', d.order.status === 'confirmado' && d.messages.at(-1).status === 'omitido' && d.order.attention === false && sent.length === s3, d.messages.at(-1));
  r = await call('POST', `/api/hermes/orders/${o5}/message`, adm, { body: 'Hola Laura' });
  check('mensaje manual fuera de las 24 h: avisa que no se puede enviar', r.status === 400 && r.json.error.code === 'no_enviado', r);
  await call('PUT', '/api/hermes/channel', adm, { pageId: PAGE, templates: { ...T, hermes_guia: 'tpl_malo' } });
  await call('POST', `/api/hermes/orders/${o5}/action`, adm, { action: 'despachar', carrier: 'Interrapidísimo', trackingNumber: '240012345678', trackingUrl: '' });
  check('plantilla que Pancake rechaza: queda como fallido y el pedido pide atención', await until(async () => (await detail(o5)).messages.at(-1).status === 'fallido'), (await detail(o5)).messages.at(-1));
  d = await detail(o5);
  check('…con el motivo a la vista', /template_not_found/.test(d.messages.at(-1).error) && d.order.attention === true && /No se pudo enviar/.test(d.order.attentionReason), [d.messages.at(-1).error, d.order.attentionReason]);
  await call('PUT', '/api/hermes/channel', adm, { pageId: PAGE, templates: T });

  // ── Novedad con respuesta ──
  await call('POST', `/api/hermes/orders/${o5}/action`, adm, { action: 'novedad', type: 'ausente', description: '' });
  check('la novedad sale con su plantilla y el motivo', await until(() => lastTo('573002220001')?.template_id === 'tpl_nov') && /no encontró a nadie/.test(lastTo('573002220001').template_params.BODY_PARAMS.reason), lastTo('573002220001'));
  inbound('573002220001', 'in_5', 'Reprogramar entrega'); await poll(); d = await detail(o5);
  check('el cliente pulsa «Reprogramar entrega»: queda para gestionar con la transportadora', /reprogramar/i.test(d.order.attentionReason) && d.incidents[0].customerChoice === 'reprogramar', [d.order.attentionReason, d.incidents]);

  // ── El mismo número se usa para vender: lo anterior al pedido no es para Hermes ──
  inbound('573009998877', 'venta_1', 'Hola, cuánto valen los buzos?', undefined, new Date(Date.now() - 20_000));
  inbound('573009998877', 'venta_2', 'Quiero dos talla L', undefined, new Date(Date.now() - 15_000));
  await wait(1100);
  const o9 = await order('3009998877');
  await wait(1100);
  inbound('573009998877', 'conf_9', 'Confirmar pedido');
  await poll();
  d = await detail(o9);
  check('la conversación de la venta, anterior al pedido, no se toma como respuesta', d.order.status === 'confirmado' && d.order.attention === false && d.messages.filter((m) => m.direction === 'in').length === 1 && !d.messages.some((m) => /le paso tu mensaje/.test(m.body)), [d.order.attentionReason, d.messages.map((m) => m.body.slice(0, 50))]);
  const outsBefore = d.messages.filter((m) => m.direction === 'out').length;
  inbound('573009998877', 'grac_9', 'Ok perfecto! Gracias 🙏');
  inbound('573009998877', 'grac_10', 'Listo');
  await poll();
  d = await detail(o9);
  check('«gracias» y «listo» después de confirmar: ni respuesta ni aviso al equipo', d.order.attention === false && d.messages.filter((m) => m.direction === 'out').length === outsBefore, [d.order.attentionReason, d.messages.map((m) => m.body.slice(0, 50))]);
  inbound('573009998877', 'preg_9', 'a qué hora me llega?');
  await poll();
  d = await detail(o9);
  check('una pregunta de verdad sí pasa a una persona', d.order.attention === true, d.order);
  check('…y se le avisa que lo atiende el equipo', await until(() => lastTo('573009998877')?.message?.includes('equipo'), 9000), lastTo('573009998877'));

  // ── Apagar ──
  check('con el canal real activo, el simulador queda bloqueado', (await call('POST', `/api/hermes/orders/${o1}/simulate-reply`, adm, { text: 'hola' })).status === 403);
  r = await call('POST', '/api/hermes/channel/activate', adm, { active: false });
  const s5 = sent.length; await order('3002223344'); await wait(600);
  check('al volver al modo simulado deja de enviar', r.json.driver === 'simulado' && sent.length === s5, r.json.driver);
  r = await call('DELETE', '/api/hermes/channel', adm);
  check('desconectar borra el token y anula la dirección de avisos', r.status === 200 && !r.json.hasToken && r.json.webhookUrl === null && (await call('POST', hook, null, {})).status === 404, r.json);
  r = await call('GET', '/api/audit?action=hermes.canal', adm);
  check('todo queda en auditoría, sin el token', r.json.entries.length >= 6 && !JSON.stringify(r.json).includes(TOKEN), r.json.entries?.length);
} finally {
  mock.close();
}
console.log(f ? `\n${f} FALLOS de ${n}` : `\nTODO OK (${n} comprobaciones)`); process.exit(f ? 1 : 0);
