import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4100';
const pass = /cuentas\): (\S+)/.exec(readFileSync(process.argv[2], 'utf8'))[1];
let f = 0; const check = (n, c, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 600)}`); if (!c) f++; };
const call = async (m, p, c, b) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m !== 'GET' && m !== 'DELETE' ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) }, body: m !== 'GET' && m !== 'DELETE' ? JSON.stringify(b ?? {}) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@demo.olympo.test`, password: pass })).cookie;
const sup = await login('supervisora'), v1 = await login('vendedora1');
const good = (name, phone, extra = {}) => ({ customerName: name, phone, address: 'Calle 10 # 5-20 apto 201', neighborhood: 'Centro', city: 'Cali', products: '2 fajas talla M', total: '120.000', ...extra });

// Bloqueados
let r = await call('POST', '/api/hermes/blocked', sup, { phone: '300 111 2233', name: 'Mala Paga', reason: 'Rechazó tres pedidos' });
check('bloquear', r.status === 200 || r.status === 201, r);
r = await call('GET', '/api/hermes/blocked', sup);
check('lista de bloqueados', r.json.blocked?.length === 1 && r.json.blocked[0].reason === 'Rechazó tres pedidos' && r.json.blocked[0].createdByName === 'Supervisora Demo', r.json);
const bphone = r.json.blocked[0].phone;
r = await call('POST', '/api/hermes/orders', sup, { customerName: 'Mala Paga', phone: '3001112233', address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] });
check('crear a bloqueado → 409', r.status === 409 && JSON.stringify(r.json).includes('bloque'), r);
r = await call('POST', '/api/hermes/validate', v1, { phone: '3001112233', address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali' });
check('validador avisa bloqueado', r.json.blocked?.reason === 'Rechazó tres pedidos', r.json);
check('vendedora no gestiona bloqueados', (await call('GET', '/api/hermes/blocked', v1)).status === 403 && (await call('POST', '/api/hermes/blocked', v1, { phone: '3009998877', reason: 'xxxx' })).status === 403);

// Vista previa
const rows = [
  good('Laura Uno', '3002000001'),
  good('Pedro Dos', '3002000002', { address: 'por la iglesia', neighborhood: '' }),
  good('Mala Paga', '3001112233'),
  good('Sin Tel', '123'),
  good('Laura Repetida', '3002000001'),
  good('Nora Seis', '300 200 0006', { total: '$ 85,000', seller: 'Vendedora 1' }),
];
r = await call('POST', '/api/hermes/import/preview', sup, { rows });
const pv = r.json;
check('vista previa responde', r.status === 200 && pv.total === 6, r);
check('fila buena lista', pv.rows[0].ok === true, pv.rows[0]);
check('dirección incompleta solo avisa', pv.rows[1].ok === true && pv.rows[1].warnings.some((w) => w.includes('Revisa la dirección')), pv.rows[1]);
check('bloqueado se rechaza', pv.rows[2].ok === false && pv.rows[2].errors.join(' ').toLowerCase().includes('bloque'), pv.rows[2]);
check('teléfono inválido se rechaza', pv.rows[3].ok === false, pv.rows[3]);
check('repetido dentro del archivo se señala', pv.rows[4].ok === false || pv.rows[4].warnings.length > 0, pv.rows[4]);
check('la vista previa no crea nada', (await call('GET', '/api/hermes/orders', sup)).json.orders.length === 0);
console.log('fila 5:', JSON.stringify(pv.rows[4]), '\nfila 6:', JSON.stringify(pv.rows[5]), '\nvalid', pv.valid);

// Importar
r = await call('POST', '/api/hermes/import', sup, { rows });
check('importa las válidas y omite el resto', r.status === 200 && r.json.created.length === pv.valid - (pv.rows[4].ok ? 1 : 0) + (pv.rows[4].ok ? 1 : 0) && r.json.skipped.length === 6 - r.json.created.length, r.json);
console.log('creados', JSON.stringify(r.json.created), 'omitidos', JSON.stringify(r.json.skipped));
const orders = (await call('GET', '/api/hermes/orders', sup)).json.orders;
check('pedidos creados', orders.length === r.json.created.length, orders.length);
const o6 = orders.find((o) => o.customerName === 'Nora Seis');
const d6 = o6 && (await call('GET', `/api/hermes/orders/${o6.id}`, sup)).json;
check('valor y confirmación del importado', d6 && Number(d6.order.total) === 85000 && d6.order.status === 'por_confirmar' && d6.messages.length >= 1, d6?.order);
check('vendedora no importa', (await call('POST', '/api/hermes/import', v1, { rows })).status === 403);
check('lote vacío se rechaza', (await call('POST', '/api/hermes/import', sup, { rows: [] })).status === 400);
r = await call('GET', '/api/audit', await login('admin'));
check('queda en auditoría', JSON.stringify(r.json).includes('hermes.importacion') && JSON.stringify(r.json).includes('hermes.cliente_bloqueado'), Object.keys(r.json));

// Desbloquear
r = await call('DELETE', `/api/hermes/blocked/${bphone}`, sup);
check('desbloquear', r.status === 200, r);
r = await call('POST', '/api/hermes/orders', sup, { customerName: 'Mala Paga', phone: '3001112233', address: 'Calle 10 # 5-20', neighborhood: 'Centro', city: 'Cali', items: [{ name: 'Faja', qty: 1, price: 90000 }] });
check('tras desbloquear se le puede crear', r.status === 200 || r.status === 201, r);
console.log(f ? `\n${f} FALLOS` : '\nTODO OK'); process.exit(f ? 1 : 0);
