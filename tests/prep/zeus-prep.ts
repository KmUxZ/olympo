// SOLO base TEMPORAL: pedidos de varios clientes con fechas pasadas, para probar Zeus.
const { db } = await import('../../apps/server/src/db/db.ts');
const users = (await db.query(`SELECT id, email, company_id FROM core_users WHERE email LIKE 'vendedora%@demo.olympo.test' ORDER BY email`)).rows;
const company = users[0].company_id, v1 = users[0].id, v2 = users[1].id;
let n = 0;
const add = async (name: string, phone: string, city: string, status: string, total: number, daysAgo: number, seller: string | null) => {
  await db.query(
    `INSERT INTO hermes_orders (company_id, code, customer_name, phone, address, city, items, total, status, seller_user_id, created_at, delivered_at)
     VALUES ($1, $2, $3, $4, 'Calle 1 # 2-3', $5, $6::jsonb, $7, $8, $9, now() - ($10 || ' days')::interval, CASE WHEN $8 = 'entregado' THEN now() - ($10 || ' days')::interval + interval '2 days' ELSE NULL END)`,
    [company, `Z-${String(++n).padStart(4, '0')}`, name, phone, city, JSON.stringify([{ free: true, name: 'Faja', qty: 1, price: total }]), total, status, seller, String(daysAgo)],
  );
};
await add('Ana Ruiz', '573000000001', 'Cali', 'entregado', 100000, 62, v1);
await add('Ana Ruiz', '573000000001', 'Cali', 'entregado', 100000, 47, v1);
await add('Ana Ruiz Torres', '573000000001', 'Cali', 'entregado', 100000, 42, v1);
await add('Beto Díaz', '573000000002', 'Medellín', 'entregado', 80000, 52, v2);
await add('Beto Díaz', '573000000002', 'Medellín', 'entregado', 80000, 37, v2);
await add('Carla Gil', '573000000003', 'Bogotá', 'entregado', 90000, 7, v1);
await add('Darío Paz', '573000000004', 'Cali', 'entregado', 70000, 42, v1);
await add('Darío Paz', '573000000004', 'Cali', 'confirmado', 70000, 1, v1);
await add('Elsa Mora', '573000000005', 'Pasto', 'entregado', 60000, 62, v2);
await add('Elsa Mora', '573000000005', 'Pasto', 'devuelto', 60000, 30, v2);
await add('Elsa Mora', '573000000005', 'Pasto', 'devuelto', 60000, 10, v2);
await add('Fabio Rey', '573000000006', 'Cali', 'por_confirmar', 50000, 0, null);
await add('Gina Sol', '573000000007', 'Cali', 'cancelado', 50000, 20, v2);
await add('Hugo Luna', '573000000008', 'Cali', 'entregado', 120000, 92, v1);
await db.query(`INSERT INTO hermes_blocked (company_id, phone, name, reason) VALUES ($1, '573000000008', 'Hugo Luna', 'Rechazó varios pedidos')`, [company]);
console.log('clientes de prueba creados');
await db.close();
