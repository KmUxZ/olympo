// Crea la empresa de demostración (o, con --empresa, una empresa real con su primer administrador).
//   npm run seed
//   npm run seed -- --empresa "Mi Empresa" --admin correo@ejemplo.com --nombre "Mi Nombre"
// No genera actividad ni métricas ficticias: solo cuentas y configuración.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from './config.ts';
import { db } from './db/db.ts';
import { hashPassword, tempPassword } from './core/security.ts';

const { values } = parseArgs({ options: { empresa: { type: 'string' }, admin: { type: 'string' }, nombre: { type: 'string' }, plataforma: { type: 'string' } } });
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

async function createUser(companyId: string, name: string, email: string, role: string, password: string, teamId: string | null, demo: boolean): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO core_users (company_id, email, name, role, password_hash, team_id, is_demo, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [companyId, email.toLowerCase(), name, role, await hashPassword(password), teamId, demo, !demo],
  );
  return rows[0].id;
}

if (values.plataforma) {
  // Da (o confirma) el rol de plataforma a una cuenta existente:  npm run seed -- --plataforma correo@ejemplo.com
  const { rows } = await db.query(`UPDATE core_users SET is_platform_admin = true WHERE lower(email) = $1 RETURNING name`, [values.plataforma.toLowerCase()]);
  console.log(rows.length ? `
${rows[0].name} ahora opera la plataforma OLYMPO (verá «Empresas» en el menú).
` : `
No existe ninguna cuenta con el correo ${values.plataforma}.
`);
} else if (values.empresa) {
  if (!values.admin) throw new Error('Indica el correo del administrador con --admin');
  const password = tempPassword();
  const company = (await db.query(`INSERT INTO core_companies (name, timezone) VALUES ($1, $2) RETURNING id`, [values.empresa, timezone])).rows[0];
  await createUser(company.id, values.nombre ?? 'Administrador', values.admin, 'admin', password, null, false);
  console.log(`\nEmpresa creada: ${values.empresa} (zona horaria ${timezone})`);
  console.log(`Administrador: ${values.admin}\nContraseña temporal: ${password}\n(Se pedirá cambiarla en el primer inicio de sesión.)\n`);
} else {
  const exists = await db.query(`SELECT 1 FROM core_companies WHERE is_demo`);
  if (exists.rows.length) {
    console.log('La empresa de demostración ya existe. No se hizo ningún cambio.');
  } else {
    // Si ya existía un archivo de credenciales demo se conserva la misma contraseña.
    const credFile = join(config.dataDir, 'credenciales-demo.txt');
    const previous = existsSync(credFile) ? /Contraseña \(todas las cuentas\): (\S+)/.exec(readFileSync(credFile, 'utf8'))?.[1] : undefined;
    const password = previous ?? tempPassword();
    const company = (await db.query(`INSERT INTO core_companies (name, timezone, is_demo) VALUES ($1, $2, true) RETURNING id`, ['Empresa de demostración', timezone])).rows[0];
    const cid: string = company.id;
    const admin = await createUser(cid, 'Admin Demo', 'admin@demo.olympo.test', 'admin', password, null, true);
    const supervisor = await createUser(cid, 'Supervisora Demo', 'supervisora@demo.olympo.test', 'supervisor', password, null, true);
    const team = (await db.query(`INSERT INTO core_teams (company_id, name, supervisor_id) VALUES ($1, 'Equipo Demo', $2) RETURNING id`, [cid, supervisor])).rows[0];
    const sellers: string[] = [];
    for (const n of [1, 2, 3]) sellers.push(await createUser(cid, `Vendedora Demo ${n}`, `vendedora${n}@demo.olympo.test`, 'seller', password, team.id, true));

    for (const [i, userId] of sellers.entries()) {
      await db.query(`INSERT INTO argos_lines (company_id, label, channel, identifier, assigned_user_id) VALUES ($1, $2, 'whatsapp', $3, $4)`, [
        cid, `Línea demo ${i + 1}`, `+00 000 000 000${i + 1}`, userId,
      ]);
      await db.query(`INSERT INTO argos_schedules (user_id, company_id, weekdays, start_time, end_time) VALUES ($1, $2, '[1,2,3,4,5,6]'::jsonb, '08:00', '17:00')`, [userId, cid]);
    }
    await db.query(`INSERT INTO argos_tools (company_id, name, hosts) VALUES ($1, 'WhatsApp Web', '["web.whatsapp.com"]'::jsonb), ($1, 'Shopify Admin', '["admin.shopify.com"]'::jsonb)`, [cid]);
    await db.query(
      `INSERT INTO core_audit_log (company_id, actor_id, actor_name, action, entity_type, entity_id, summary) VALUES ($1, $2, 'Sistema', 'empresa.demo_creada', 'empresa', $3, 'Se creó la empresa de demostración')`,
      [cid, admin, cid],
    );

    const file = join(config.dataDir, 'credenciales-demo.txt');
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(
      file,
      [
        'OLYMPO · Argos — cuentas de DEMOSTRACIÓN (solo para desarrollo local)',
        '',
        `Contraseña (todas las cuentas): ${password}`,
        '',
        'admin@demo.olympo.test         Administrador',
        'supervisora@demo.olympo.test   Supervisora',
        'vendedora1@demo.olympo.test    Vendedora',
        'vendedora2@demo.olympo.test    Vendedora',
        'vendedora3@demo.olympo.test    Vendedora',
        '',
      ].join('\n'),
    );
    console.log(`\nEmpresa de demostración creada. Credenciales en: ${file}\n`);
  }
}

await db.close();
