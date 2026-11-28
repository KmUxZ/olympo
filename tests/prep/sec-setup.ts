// SOLO para la base TEMPORAL de la prueba de seguridad: crea una segunda empresa con su administrador y una vendedora.
const { db } = await import('../../apps/server/src/db/db.ts');
const { hashPassword } = await import('../../apps/server/src/core/security.ts');
const pass = process.argv[2];
const hash = await hashPassword(pass);
const c = (await db.query(`INSERT INTO core_companies (name, timezone, products) VALUES ('Empresa B', 'America/Bogota', '["argos","hermes","zeus","athena"]'::jsonb) RETURNING id`)).rows[0];
await db.query(`INSERT INTO core_users (company_id, email, name, role, password_hash) VALUES ($1, 'admin@b.test', 'Admin B', 'admin', $2), ($1, 'vende@b.test', 'Vende B', 'seller', $2)`, [c.id, hash]);
// La empresa de demostración necesita los cuatro productos para probar todas las rutas.
await db.query(`UPDATE core_companies SET products = '["argos","hermes","zeus","athena"]'::jsonb WHERE id <> $1`, [c.id]);
console.log('listo');
process.exit(0);
