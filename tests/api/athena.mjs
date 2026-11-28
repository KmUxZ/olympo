// Uso: node athena-test.mjs <credenciales> [ia]
// Con "ia" levanta un servidor que imita la API de Anthropic en el puerto 4200 (el servidor de OLYMPO debe apuntar a él).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const BASE = 'http://127.0.0.1:4100';
const AI = process.argv[3] === 'ia';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 700)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' && m !== 'DELETE' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' && m !== 'DELETE' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;

// ── Imitación de la API de Anthropic ──
const seen = [];
let failNext = false;
if (AI) {
  const msg = (content, stop) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } });
  const text = (t) => msg([{ type: 'text', text: t }], 'end_turn');
  const tool = (name, input) => msg([{ type: 'tool_use', id: `toolu_${seen.length}`, name, input }], 'tool_use');
  createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      seen.push({ url: req.url, beta: req.headers['anthropic-beta'], key: req.headers['x-api-key'], body: b });
      res.setHeader('content-type', 'application/json');
      if (failNext) { failNext = false; res.statusCode = 400; return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallo de prueba' } })); }
      const last = b.messages.at(-1);
      let out;
      if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        const r = String(last.content[0].content);
        out = r.startsWith('Guardado. Los datos') ? text('Te confirmo: 2 fajas talla M por $180.000, para Calle 10 # 5-20, barrio Centro, Cali. ¿Está bien?')
          : r.startsWith('Guardado.') ? text('Me falta un dato para el envío.')
          : r.startsWith('Pedido') ? text('¡Listo! Tu pedido quedó creado. Te llegará la confirmación de despachos.')
          : text('Ya te escribe una persona del equipo.');
      } else {
        const said = b.messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('<estado>')).at(-1)?.content ?? '';
        out = /asesor/i.test(said) ? tool('pasar_a_humano', { motivo: 'El cliente pide una persona' })
          : /^s[ií]/i.test(said) ? tool('crear_pedido', {})
          : /quiero/i.test(said) ? tool('guardar_datos', { nombre: 'Laura Gómez', direccion: 'Calle 10 # 5-20', barrio: 'Centro', ciudad: 'Cali', productos: '2 fajas talla M', total: 180000 })
          : /incompleta/i.test(said) ? tool('guardar_datos', { nombre: 'Pepe Ruiz', direccion: 'por el parque', ciudad: 'Cali', productos: '1 faja', total: 90000 })
          : text('¡Hola! Soy Athena. ¿En qué te ayudo?');
      }
      res.end(JSON.stringify(out));
    });
  }).listen(4200);
}

const adm = await login('admin'), sup = await login('supervisora'), v1 = await login('vendedora1');
check('la empresa tiene Athena', (await call('GET', '/api/auth/me', adm)).json.company.products.includes('athena'));
let r = await call('GET', '/api/athena/settings', sup);
check('ajustes por defecto', r.status === 200 && r.json.settings.assistantName === 'Athena' && r.json.aiReady === AI && r.json.hermesActive === true, r.json);
check('vendedora no entra a Athena', (await call('GET', '/api/athena/settings', v1)).status === 403 && (await call('POST', '/api/athena/simulate', v1, { text: 'hola' })).status === 403);
const settings = { enabled: false, assistantName: 'Sofi', businessAbout: 'Vendemos fajas y cremas reductoras.', tone: 'cercano', shippingPolicy: 'Enviamos a todo el país en 2 a 4 días hábiles. El envío es gratis.', paymentPolicy: 'Pagas en efectivo cuando recibes.', extraRules: 'No prometas resultados médicos.', model: 'claude-opus-5-5', createOrders: true };
check('supervisora no cambia ajustes', (await call('PUT', '/api/athena/settings', sup, settings)).status === 403);
check('admin guarda ajustes', (await call('PUT', '/api/athena/settings', adm, settings)).status === 200 && (await call('GET', '/api/athena/settings', adm)).json.settings.assistantName === 'Sofi');
r = await call('POST', '/api/athena/products', sup, { name: 'Faja reductora', description: 'Tallas S a XL.', price: 90000, offers: '2 por $170.000' });
const pid = r.json.id;
await call('POST', '/api/athena/products', sup, { name: 'Crema térmica', price: 45000 });
check('catálogo', pid && (await call('GET', '/api/athena/products', sup)).json.products.length === 2);
check('editar producto', (await call('PUT', `/api/athena/products/${pid}`, sup, { name: 'Faja reductora', description: 'Tallas S a XL.', price: 95000, offers: '2 por $180.000', active: true })).status === 200 && (await call('GET', '/api/athena/products', sup)).json.products.find((p) => p.id === pid).price === 95000);
r = await call('POST', '/api/athena/knowledge', sup, { question: '¿La faja se puede lavar en lavadora?', answer: 'Sí, en ciclo suave y sin secadora.' });
check('pregunta frecuente', r.json.id && (await call('GET', '/api/athena/knowledge', sup)).json.items.length === 1);
const sim = async (text, conversationId) => (await call('POST', '/api/athena/simulate', sup, { text, conversationId })).json;
const conv = async (id) => (await call('GET', `/api/athena/conversations/${id}`, sup)).json;
const lastBot = (d) => d.messages.filter((m) => m.role === 'athena').at(-1);

if (!AI) {
  // ── Modo guion (sin IA): solo repite lo escrito y pasa a una persona lo demás ──
  let s = await sim('Hola, buenas');
  const id = s.conversationId;
  let d = await conv(id);
  check('saluda con el nombre configurado y marca modo guion', s.mode === 'guion' && lastBot(d).body.includes('Sofi') && lastBot(d).meta.mode === 'guion' && d.conversation.isTest === true, lastBot(d));
  await sim('cuánto vale la faja?', id);
  check('responde el precio del catálogo', lastBot(await conv(id)).body.includes('$95.000'), lastBot(await conv(id)));
  await sim('y hacen envios a Pasto?', id);
  check('responde con la política de envíos', lastBot(await conv(id)).body.includes('2 a 4 días'));
  await sim('se puede lavar la faja en lavadora?', id);
  check('pregunta con producto: da la ficha, no inventa', /Faja reductora|ciclo suave/.test(lastBot(await conv(id)).body));
  await sim('listo, quiero comprar dos', id);
  d = await conv(id);
  check('la compra pasa a una persona', d.conversation.status === 'humano' && d.conversation.attention === true && d.conversation.handoffReason.includes('comprar') && d.messages.some((m) => m.role === 'sistema'), d.conversation);
  const before = d.messages.filter((m) => m.role === 'athena').length;
  s = await sim('hola?', id);
  d = await conv(id);
  check('con una persona a cargo, Athena no responde', s.answered === false && d.messages.filter((m) => m.role === 'athena').length === before);
  check('persona responde y deja de estar pendiente', (await call('POST', `/api/athena/conversations/${id}/message`, sup, { body: 'Hola, soy Marta. Te tomo el pedido.' })).status === 200 && (await conv(id)).conversation.attention === false && (await conv(id)).conversation.takenBy === 'Supervisora Demo');
  await call('POST', `/api/athena/conversations/${id}/takeover`, sup, { human: false });
  s = await sim('cuanto vale la crema', id);
  check('al devolverla, Athena vuelve a responder', s.answered === true && (await conv(id)).conversation.status === 'bot' && lastBot(await conv(id)).body.includes('$45.000'));
  s = await sim('¿ustedes tienen tienda física en Medellín?');
  check('lo que no sabe lo pasa a una persona, sin inventar', (await conv(s.conversationId)).conversation.status === 'humano' && (await conv(s.conversationId)).conversation.handoffReason.includes('no tiene la respuesta'));
  r = await call('GET', '/api/athena/conversations?view=prueba', sup);
  check('las pruebas van aparte', r.json.conversations.length === 2 && r.json.counts.tests === 2 && r.json.counts.total === 0 && (await call('GET', '/api/athena/conversations', sup)).json.conversations.length === 0, r.json.counts);
  check('las pruebas no crean pedidos en Hermes', (await call('GET', '/api/hermes/orders', sup)).json.orders.length === 0);
  check('cerrar conversación', (await call('POST', `/api/athena/conversations/${id}/close`, sup)).status === 200 && (await conv(id)).conversation.status === 'cerrada');
  check('quitar del catálogo', (await call('DELETE', `/api/athena/products/${pid}`, sup)).status === 200 && (await call('GET', '/api/athena/products', sup)).json.products.length === 1);
} else {
  // ── Modo IA contra la API imitada: herramientas, pedido en Hermes y fallos ──
  let s = await call('POST', '/api/athena/inbound', adm, { phone: '3005551234', name: '', text: 'Hola' });
  const id = s.json.conversationId;
  check('responde con IA', s.json.mode === 'ia' && lastBot(await conv(id)).meta.mode === 'ia' && lastBot(await conv(id)).meta.usage.cached === 50, s.json);
  const q = seen.at(-1);
  check('la petición lleva modelo, esfuerzo, respaldo y herramientas', q.url.startsWith('/v1/messages') && q.body.model === 'claude-opus-5-5' && q.body.output_config?.effort === 'low' && q.body.fallbacks === 'default' && String(q.beta).includes('server-side-fallback-2026-07-01') && q.body.tools.length === 3 && !('thinking' in q.body) && !('temperature' in q.body), { beta: q.beta, keys: Object.keys(q.body) });
  check('el contexto fijo va cacheado e incluye catálogo y reglas', q.body.system[0].cache_control?.type === 'ephemeral' && q.body.system[0].text.includes('Faja reductora: $95.000') && q.body.system[0].text.includes('2 a 4 días') && q.body.system[0].text.includes('Sofi') && q.body.system[0].text.includes('lavadora'), q.body.system[0].text.slice(0, 200));
  check('el estado va al final, fuera del contexto cacheado', q.body.messages.at(-1).content.includes('<estado>') && q.body.messages.at(-1).content.includes('573005551234') && q.body.messages[0].role === 'user' && q.body.messages[0].content === 'Hola');
  await call('POST', '/api/athena/inbound', adm, { phone: '3005551234', text: 'quiero 2 fajas talla M, soy Laura Gómez, Calle 10 # 5-20 barrio Centro, Cali' });
  let d = await conv(id);
  check('guarda los datos y pide confirmación', d.conversation.draft.total === 180000 && d.conversation.customerName === 'Laura Gómez' && lastBot(d).body.includes('¿Está bien?') && !d.conversation.orderCode, d.conversation);
  const tr = seen.at(-1).body.messages.at(-1);
  check('el resultado de la herramienta vuelve al modelo', tr.role === 'user' && tr.content[0].type === 'tool_result' && tr.content[0].content.includes('Los datos están completos') && seen.at(-1).body.messages.at(-2).role === 'assistant');
  await call('POST', '/api/athena/inbound', adm, { phone: '3005551234', text: 'sí, perfecto' });
  d = await conv(id);
  check('crea el pedido en Hermes', /^H-\d+$/.test(d.conversation.orderCode) && lastBot(d).body.includes('pedido quedó creado') && d.messages.some((m) => m.role === 'sistema' && m.body.includes(d.conversation.orderCode)), d.conversation);
  const orders = (await call('GET', '/api/hermes/orders', sup)).json.orders;
  check('el pedido existe en Hermes con origen Athena y pide confirmación', orders.length === 1 && orders[0].source === 'athena' && orders[0].phone === '573005551234' && Number(orders[0].total) === 180000 && orders[0].status === 'por_confirmar' && orders[0].customerName === 'Laura Gómez', orders[0]);
  const n = seen.length;
  await call('POST', '/api/athena/inbound', adm, { phone: '3005551234', text: 'sí' });
  check('no crea un segundo pedido en la misma conversación', (await call('GET', '/api/hermes/orders', sup)).json.orders.length === 1 && seen.length > n);
  // Dirección incompleta: la herramienta le dice al modelo qué falta
  s = await call('POST', '/api/athena/inbound', adm, { phone: '3005559999', text: 'direccion incompleta' });
  const tr2 = seen.at(-1).body.messages.at(-1).content[0].content;
  check('con dirección incompleta la herramienta explica qué falta', tr2.includes('Falta o hay que corregir') && /v[ií]a|barrio/i.test(tr2), tr2);
  // Pasar a una persona
  s = await call('POST', '/api/athena/inbound', adm, { phone: '3005558888', text: 'quiero hablar con un asesor' });
  d = await conv(s.json.conversationId);
  check('pasa a una persona con motivo', d.conversation.status === 'humano' && d.conversation.attention && d.conversation.handoffReason === 'El cliente pide una persona' && lastBot(d).body.includes('persona del equipo'), d.conversation);
  // Cliente bloqueado
  await call('POST', '/api/hermes/blocked', sup, { phone: '3005557777', reason: 'Rechazos' });
  await call('POST', '/api/athena/inbound', adm, { phone: '3005557777', text: 'quiero 2 fajas' });
  s = await call('POST', '/api/athena/inbound', adm, { phone: '3005557777', text: 'sí' });
  d = await conv(s.json.conversationId);
  check('a un bloqueado no le crea pedido y lo pasa a una persona', !d.conversation.orderCode && d.conversation.status === 'humano' && d.conversation.handoffReason.includes('bloqueados'), d.conversation);
  // Fallo de la API: no se inventa respuesta
  failNext = true;
  s = await call('POST', '/api/athena/inbound', adm, { phone: '3005556666', text: 'Hola' });
  d = await conv(s.json.conversationId);
  check('si la IA falla, no responde y pasa a una persona', s.json.answered === false && s.json.mode === 'error' && d.messages.filter((m) => m.role === 'athena').length === 0 && d.conversation.status === 'humano' && d.conversation.handoffReason.includes('no pudo responder'), d.conversation);
  // Prueba desde la plataforma: no crea pedido real
  s = await sim('quiero 2 fajas');
  await sim('sí', s.conversationId);
  d = await conv(s.conversationId);
  check('en una prueba el pedido no llega a Hermes', d.conversation.orderCode === 'PRUEBA' && d.messages.some((m) => m.role === 'sistema' && m.body.startsWith('Prueba:')) && (await call('GET', '/api/hermes/orders', sup)).json.orders.length === 1, d.conversation);
  r = await call('GET', '/api/athena/conversations', sup);
  check('bandeja: primero las que esperan a una persona', r.json.conversations[0].attention === true && r.json.counts.orders === 1 && r.json.counts.persona === 3 && r.json.conversations.every((c) => !c.isTest), r.json.counts);
  check('supervisora no usa la entrada real', (await call('POST', '/api/athena/inbound', sup, { phone: '3001112222', text: 'hola' })).status === 403);
}
console.log(f ? `\n${f} FALLOS` : '\nTODO OK'); process.exit(f ? 1 : 0);
