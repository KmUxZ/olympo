import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { auditBy, badRequest, guard, notFound, parse } from '../core/http.ts';
import { encryptSecret } from '../core/secrets.ts';
import { fetchUsers, PancakeError, PROVIDER, syncAll, syncConnection } from './pancake.ts';

const idParam = z.object({ id: z.uuid() });

export function pancakeRoutes(app: FastifyInstance): void {
  /** Estado de la integración: líneas (conectadas o no) y usuarios de Pancake con su emparejamiento. El token nunca se devuelve. */
  app.get('/api/argos/integrations/pancake', guard('admin'), async (req) => {
    const [lines, staff] = await Promise.all([
      db.query(
        `SELECT l.id AS "lineId", l.label, l.identifier, l.active, c.external_page_id AS "pageId", c.status,
                c.last_sync_at AS "lastSyncAt", c.last_error AS "lastError", (c.line_id IS NOT NULL) AS connected
           FROM argos_lines l LEFT JOIN argos_line_connections c ON c.line_id = l.id AND c.provider = $2
          WHERE l.company_id = $1 ORDER BY l.active DESC, l.label`,
        [req.ctx.companyId, PROVIDER],
      ),
      db.query(
        `SELECT s.external_id AS "externalId", s.name, s.user_id AS "userId", u.name AS "userName"
           FROM argos_external_staff s LEFT JOIN core_users u ON u.id = s.user_id
          WHERE s.company_id = $1 AND s.provider = $2 ORDER BY s.name`,
        [req.ctx.companyId, PROVIDER],
      ),
    ]);
    return { lines: lines.rows, staff: staff.rows };
  });

  /** Conecta una línea con una página de Pancake. El token se valida contra Pancake antes de guardarlo cifrado. */
  app.put('/api/argos/lines/:id/pancake', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ pageId: z.string().trim().min(3).max(80).regex(/^[\w.-]+$/, 'identificador de página no válido'), token: z.string().trim().min(10).max(600) }), req.body);
    const line = (await db.query(`SELECT label FROM argos_lines WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId])).rows[0];
    if (!line) throw notFound('Línea no encontrada.');
    try {
      await fetchUsers(body.pageId, body.token);
    } catch (err) {
      throw badRequest(err instanceof PancakeError ? err.message : 'No se pudo validar la conexión con Pancake.', 'pancake_rechazado');
    }
    await db.query(
      `INSERT INTO argos_line_connections (line_id, company_id, provider, external_page_id, secret_enc) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (line_id) DO UPDATE SET external_page_id = EXCLUDED.external_page_id, secret_enc = EXCLUDED.secret_enc, status = 'ok', last_error = NULL`,
      [id, req.ctx.companyId, PROVIDER, body.pageId, encryptSecret(body.token)],
    );
    await auditBy(req.ctx, { action: 'integracion.pancake_conectada', entityType: 'linea', entityId: id, summary: `Conectó la línea ${line.label} con Pancake`, metadata: { pageId: body.pageId } });
    const conn = (await db.query(`SELECT c.line_id, c.company_id, c.external_page_id, c.secret_enc, $2::text AS timezone FROM argos_line_connections c WHERE c.line_id = $1`, [id, req.ctx.company.timezone])).rows[0];
    const result = await syncConnection(conn).catch(() => null);
    return { ok: true, synced: Boolean(result) };
  });

  app.delete('/api/argos/lines/:id/pancake', guard('admin'), async (req) => {
    const { id } = parse(idParam, req.params);
    const line = (await db.query(`SELECT label FROM argos_lines WHERE id = $1 AND company_id = $2`, [id, req.ctx.companyId])).rows[0];
    if (!line) throw notFound('Línea no encontrada.');
    const { count } = await db.query(`DELETE FROM argos_line_connections WHERE line_id = $1 AND company_id = $2`, [id, req.ctx.companyId]);
    if (count) await auditBy(req.ctx, { action: 'integracion.pancake_desconectada', entityType: 'linea', entityId: id, summary: `Desconectó la línea ${line.label} de Pancake` });
    return { ok: true };
  });

  /** Empareja un usuario de Pancake con una cuenta de Argos (o lo deja sin emparejar). */
  app.put('/api/argos/integrations/pancake/staff', guard('admin'), async (req) => {
    const body = parse(z.object({ externalId: z.string().min(1).max(100), userId: z.uuid().nullable() }), req.body);
    const staff = (await db.query(`SELECT name FROM argos_external_staff WHERE company_id = $1 AND provider = $2 AND external_id = $3`, [req.ctx.companyId, PROVIDER, body.externalId])).rows[0];
    if (!staff) throw notFound('Usuario de Pancake no encontrado.');
    let userName: string | null = null;
    if (body.userId) {
      const user = (await db.query(`SELECT name FROM core_users WHERE id = $1 AND company_id = $2`, [body.userId, req.ctx.companyId])).rows[0];
      if (!user) throw badRequest('La persona indicada no existe.');
      userName = user.name;
      // Una cuenta de Argos corresponde a un solo usuario de Pancake.
      await db.query(`UPDATE argos_external_staff SET user_id = NULL WHERE company_id = $1 AND provider = $2 AND user_id = $3`, [req.ctx.companyId, PROVIDER, body.userId]);
    }
    await db.query(`UPDATE argos_external_staff SET user_id = $4 WHERE company_id = $1 AND provider = $2 AND external_id = $3`, [req.ctx.companyId, PROVIDER, body.externalId, body.userId]);
    await auditBy(req.ctx, {
      action: 'integracion.pancake_emparejamiento', entityType: 'usuario', entityId: body.userId ?? undefined,
      summary: userName ? `Emparejó el usuario de Pancake «${staff.name}» con ${userName}` : `Quitó el emparejamiento del usuario de Pancake «${staff.name}»`,
    });
    return { ok: true };
  });

  app.post('/api/argos/integrations/pancake/sync', guard('admin'), async (req) => syncAll(req.ctx.companyId));
}
