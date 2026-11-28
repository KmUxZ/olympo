// Zeus · clientes, segmentos, recompra y seguimientos, contra una base TEMPORAL con clientes de prueba (zeus-prep.ts).
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0, n = 0; const check = (name, c, x = '') => { n++; console.log(`${c ? 'OK  ' : 'FAIL'} ${name} ${c ? '' : JSON.stringify(x).slice(0, 500)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' && b !== undefined ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' && b !== undefined ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (email, password = pass) => (await call('POST', '/api/auth/login', null, { email, password })).cookie;
const P = (i) => `57300000000${i}`;
const adm = await login('admin@demo.olympo.test'), sup = await login('supervisora@demo.olympo.test'), v1 = await login('vendedora1@demo.olympo.test'), v2 = await login('vendedora2@demo.olympo.test');

// Zeus está en pausa para el público: la empresa de la plataforma lo activa para sí misma.
const mine = (await call('GET', '/api/platform/companies', adm)).json.companies[0];
check('la empresa que opera la plataforma tiene todos los productos, Zeus incluido', ['argos', 'hermes', 'zeus', 'athena'].every((p) => mine.products.includes(p)), mine.products);

// ── Resumen y segmentos ──
let r = await call('GET', '/api/zeus/summary', adm);
const seg = Object.fromEntries((r.json.segments ?? []).map((s) => [s.segment, s.customers]));
check('resumen: 8 clientes, 6 han recibido, 2 repiten (33 %)', r.status === 200 && r.json.totals.customers === 8 && r.json.totals.buyers === 6 && r.json.totals.repeat === 2 && r.json.totals.repeatRate === 33, r.json.totals);
check('cada cliente cae en su segmento', seg.vip === 1 && seg.recurrente === 1 && seg.una_vez === 2 && seg.en_proceso === 1 && seg.sin_entrega === 1 && seg.riesgoso === 1 && seg.bloqueado === 1, seg);
check('valor entregado y valor promedio por entrega', r.json.totals.value === 800000 && r.json.totals.averageTicket === Math.round(800000 / 9), r.json.totals);
check('hay 2 clientes para recompra', r.json.opportunities === 2 && r.json.repurchaseDays === 30, [r.json.opportunities, r.json.repurchaseDays]);

// ── Lista ──
r = await call('GET', '/api/zeus/customers?sort=valor', adm);
check('lista ordenada por valor: Ana primero, con su nombre más reciente', r.json.total === 8 && r.json.customers[0].phone === P(1) && r.json.customers[0].name === 'Ana Ruiz Torres' && r.json.customers[0].value === 300000 && r.json.customers[0].delivered === 3 && r.json.customers[0].sellerName, r.json.customers?.[0]);
const by = async (qs) => (await call('GET', `/api/zeus/customers?${qs}`, adm)).json;
check('filtro por segmento', (await by('segment=riesgoso')).customers.map((c) => c.phone).join() === P(5));
check('búsqueda por nombre (sin importar mayúsculas)', (await by('q=beto')).customers.map((c) => c.phone).join() === P(2));
check('búsqueda por ciudad', (await by('q=pasto')).total === 1);
check('búsqueda por parte del WhatsApp', (await by('q=0000007')).customers.map((c) => c.phone).join() === P(7));
check('la búsqueda trata % y _ como texto', (await by(`q=${encodeURIComponent('%')}`)).total === 0);
r = await by('size=3&page=3');
check('paginación', r.total === 8 && r.customers.length === 2 && r.page === 3, [r.total, r.customers?.length]);
check('segmento desconocido: rechazado', (await call('GET', '/api/zeus/customers?segment=x', adm)).status === 400);

// ── Ficha ──
r = await call('GET', `/api/zeus/customers/${P(5)}`, adm);
check('ficha: Elsa es riesgosa, con sus 3 pedidos', r.status === 200 && r.json.customer.segment === 'riesgoso' && r.json.orders.length === 3 && r.json.customer.returned === 2, r.json.customer);
r = await call('GET', `/api/zeus/customers/${P(8)}`, adm);
check('ficha: Hugo aparece bloqueado, con el motivo', r.json.customer.segment === 'bloqueado' && r.json.customer.blocked && /Rechazó/.test(r.json.customer.blockedReason), r.json.customer);
check('cliente inexistente: 404', (await call('GET', '/api/zeus/customers/573999999999', adm)).status === 404);
r = await call('PUT', `/api/zeus/customers/${P(1)}`, adm, { tags: ['  Mayorista ', 'mayorista', 'Paga Rápido'] });
check('etiquetas: se limpian y no se repiten', r.status === 200 && r.json.tags.join() === 'mayorista,paga rápido', r.json);
check('filtro por etiqueta', (await by('tag=mayorista')).customers.map((c) => c.phone).join() === P(1));
r = await call('GET', '/api/zeus/tags', adm);
check('lista de etiquetas en uso', r.json.tags.length === 2 && r.json.tags[0].customers === 1, r.json);
r = await call('POST', `/api/zeus/customers/${P(1)}/notes`, sup, { body: 'Prefiere que le escriban en la tarde' });
r = await call('GET', `/api/zeus/customers/${P(1)}`, adm);
check('notas: quedan con su autora', r.json.notes.length === 1 && r.json.notes[0].authorName && r.json.customer.tags.length === 2, r.json.notes);
check('nota a un cliente que no existe: 404', (await call('POST', '/api/zeus/customers/573999999999/notes', adm, { body: 'hola' })).status === 404);

// ── Recompra ──
r = await call('GET', '/api/zeus/opportunities', adm);
check('recompra: Ana y Beto (no el reciente, ni el que tiene pedido en curso, ni la riesgosa, ni el bloqueado)', r.json.customers.map((c) => c.phone).sort().join() === [P(1), P(2)].join(), r.json.customers?.map((c) => c.name));
check('la supervisora no puede cambiar los días de recompra', (await call('PUT', '/api/zeus/settings', sup, { repurchaseDays: 5 })).status === 403);
r = await call('PUT', '/api/zeus/settings', adm, { repurchaseDays: 5 });
check('con 5 días entra también Carla', r.status === 200 && (await call('GET', '/api/zeus/opportunities', adm)).json.customers.length === 3, r);
await call('PUT', '/api/zeus/settings', adm, { repurchaseDays: 30 });

// ── Seguimientos ──
const today = (await call('GET', '/api/zeus/followups', adm)).json.today;
r = await call('POST', '/api/zeus/followups', adm, { phones: [P(1), P(2), P(1)], title: 'Ofrecer recompra', dueOn: today });
check('crea un seguimiento por cliente elegido', r.status === 200 && r.json.created === 2, r);
r = await call('GET', '/api/zeus/followups', adm);
const fAna = r.json.followups.find((x) => x.phone === P(1)), fBeto = r.json.followups.find((x) => x.phone === P(2));
check('se asignan a quien le vendió la última vez', r.json.followups.length === 2 && /Demo 1/.test(fAna.assignedName) && /Demo 2/.test(fBeto.assignedName), r.json.followups);
check('con seguimiento pendiente ya no salen en recompra', (await call('GET', '/api/zeus/opportunities', adm)).json.customers.length === 0);
check('seguimiento para un cliente que no existe: rechazado', (await call('POST', '/api/zeus/followups', adm, { phones: ['573999999999'], title: 'Llamar', dueOn: today })).json.error?.code === 'cliente_no_valido');
check('fecha mal escrita: rechazada', (await call('POST', '/api/zeus/followups', adm, { phones: [P(3)], title: 'Llamar', dueOn: '2026-13-45' })).status === 400);
r = await call('POST', '/api/zeus/followups', sup, { phones: [P(3)], title: 'Pedir reseña', dueOn: '2030-01-15', assignedUserId: null });
check('la supervisora crea uno sin asignar', r.status === 200 && (await call('GET', '/api/zeus/followups', adm)).json.followups.find((x) => x.phone === P(3)).assignedUserId === null, r);

// Vendedora
r = await call('GET', '/api/zeus/followups', v1);
check('la vendedora ve solo los suyos', r.status === 200 && r.json.followups.length === 1 && r.json.followups[0].phone === P(1), r.json.followups);
check('…con nombre y WhatsApp, sin historial de pedidos', r.json.followups[0].customerName && !/delivered|value|orders|segment/.test(JSON.stringify(r.json)), Object.keys(r.json.followups[0]));
const denied = []; for (const p of ['/api/zeus/summary', '/api/zeus/customers', `/api/zeus/customers/${P(1)}`, '/api/zeus/opportunities', '/api/zeus/tags', '/api/zeus/settings']) denied.push((await call('GET', p, v1)).status);
check('la vendedora no entra a clientes, fichas ni recompra', denied.every((s) => s === 403), denied);
check('la vendedora no puede crear seguimientos', (await call('POST', '/api/zeus/followups', v1, { phones: [P(1)], title: 'Otro', dueOn: today })).status === 403);
check('la vendedora no puede tocar el seguimiento de otra', (await call('PATCH', `/api/zeus/followups/${fBeto.id}`, v1, { status: 'hecho', outcome: 'compro' })).status === 403);
check('la vendedora no puede reasignar ni cambiar la fecha', (await call('PATCH', `/api/zeus/followups/${fAna.id}`, v1, { assignedUserId: null })).status === 403 && (await call('PATCH', `/api/zeus/followups/${fAna.id}`, v1, { dueOn: '2030-01-01' })).status === 403);
check('cerrar sin decir qué pasó: rechazado', (await call('PATCH', `/api/zeus/followups/${fAna.id}`, v1, { status: 'hecho' })).json.error?.code === 'falta_resultado');
r = await call('GET', '/api/argos/notifications', v1);
check('el menú le avisa a la vendedora de su seguimiento de hoy', r.json.zeusAttention === 1, r.json.zeusAttention);
r = await call('PATCH', `/api/zeus/followups/${fAna.id}`, v1, { status: 'hecho', outcome: 'interesado', result: 'Pide que le escriban el lunes' });
check('la vendedora registra el resultado', r.status === 200 && (await call('GET', '/api/zeus/followups', v1)).json.followups.length === 0 && (await call('GET', '/api/zeus/followups?status=hecho', v1)).json.followups[0].outcome === 'interesado', r);
r = await call('GET', '/api/argos/notifications', adm);
check('administración cuenta los pendientes de hoy de todo el equipo (no los futuros)', r.json.zeusAttention === 1, r.json.zeusAttention);
check('filtro por persona encargada', (await call('GET', `/api/zeus/followups?assignedUserId=${fBeto.assignedUserId}`, adm)).json.followups.length === 1);
r = await call('PATCH', `/api/zeus/followups/${fBeto.id}`, sup, { status: 'descartado' });
check('descartar y reabrir', r.status === 200 && (await call('PATCH', `/api/zeus/followups/${fBeto.id}`, sup, { status: 'pendiente' })).status === 200 && (await call('GET', '/api/zeus/followups', adm)).json.followups.some((x) => x.id === fBeto.id && x.outcome === ''), r);
r = await call('GET', `/api/zeus/customers/${P(1)}`, adm);
check('la ficha muestra el seguimiento con su resultado', r.json.followups.length === 1 && r.json.followups[0].outcome === 'interesado' && /lunes/.test(r.json.followups[0].result), r.json.followups);
r = await call('GET', '/api/zeus/summary', adm);
check('el resumen cuenta pendientes y hechos', r.json.followups.pending === 2 && r.json.followups.done30 === 1 && r.json.followups.bought30 === 0, r.json.followups);

// ── Otras empresas: Zeus no se les puede activar ──
r = await call('POST', '/api/platform/companies', adm, { name: 'Empresa B', timezone: 'America/Bogota', adminName: 'Admin B', adminEmail: 'admin@b.test', products: ['argos', 'hermes', 'zeus'] });
const companies = (await call('GET', '/api/platform/companies', adm)).json.companies;
const b = companies.find((c) => c.id === r.json.id);
check('al crear otra empresa, Zeus no se le activa aunque se pida', r.status === 200 && b.products.join() === 'argos,hermes', b?.products);
r = await call('PATCH', `/api/platform/companies/${b.id}`, adm, { products: ['argos', 'hermes', 'zeus'] });
check('tampoco se le puede activar después', r.status === 400 && r.json.error.code === 'producto_en_pausa', r);
const admB = await login('admin@b.test', (await call('POST', `/api/platform/companies/${b.id}/reset-admin`, adm, { userId: b.admins[0].id })).json.tempPassword);
await call('POST', '/api/auth/change-password', admB, { current: 'x', next: 'x' });
const cross = [['GET', '/api/zeus/customers'], ['GET', `/api/zeus/customers/${P(1)}`], ['GET', '/api/zeus/followups'], ['POST', '/api/zeus/followups', { phones: [P(1)], title: 'Robar', dueOn: today }], ['PATCH', `/api/zeus/followups/${fBeto.id}`, { status: 'descartado' }]];
const leaks = []; for (const [m, p, body] of cross) { const x = await call(m, p, admB, body); if (x.status !== 403) leaks.push([m, p, x.status]); }
check('otra empresa: Zeus no le responde nada', leaks.length === 0, leaks);
check('cambiar otros datos de la propia empresa conserva Zeus', (await call('PATCH', `/api/platform/companies/${mine.id}`, adm, { name: mine.name })).status === 200 && (await call('GET', '/api/zeus/summary', adm)).status === 200);
check('sin sesión: 401', (await call('GET', '/api/zeus/customers')).status === 401 && (await call('GET', '/api/zeus/followups')).status === 401);
r = await call('GET', '/api/audit?action=zeus', adm);
check('queda en auditoría', r.json.entries.length >= 3, r.json.entries?.length);
console.log(f ? `\n${f} FALLOS de ${n}` : `\nTODO OK (${n} comprobaciones)`); process.exit(f ? 1 : 0);
