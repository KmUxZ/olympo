// SOLO base TEMPORAL: dos turnos abiertos cuya última señal fue hace 5 horas.
const { db } = await import('../../apps/server/src/db/db.ts');
const { CONSENT_VERSION } = await import('../../apps/server/src/config.ts');
const users = (await db.query(`SELECT id, company_id, team_id FROM core_users WHERE email IN ('vendedora1@demo.olympo.test','vendedora2@demo.olympo.test') ORDER BY email`)).rows;
for (const u of users) {
  await db.query(`INSERT INTO argos_consents (company_id, user_id, version, client) VALUES ($1,$2,$3,'extension')`, [u.company_id, u.id, CONSENT_VERSION]);
  await db.query(`INSERT INTO argos_shifts (company_id, user_id, team_id, started_at, last_sync_at) VALUES ($1,$2,$3, now() - interval '7 hours', now() - interval '5 hours')`, [u.company_id, u.id, u.team_id]);
}
console.log('turnos con hueco creados');
await db.close();
