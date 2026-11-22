// Contadores para el menú: alertas abiertas, mensajes sin leer y tareas pendientes de hoy.
import type { FastifyInstance } from 'fastify';
import { db } from '../db/db.ts';
import { guard, scopeSql } from '../core/http.ts';
import { startOfLocalDay } from '../core/time.ts';
import { agendaVisibility } from './agenda.routes.ts';
import { receivedSql } from './messages.routes.ts';

export function notificationRoutes(app: FastifyInstance): void {
  app.get('/api/argos/notifications', guard(), async (req) => {
    const ctx = req.ctx;

    let openAlerts = 0;
    let recentAlerts: { id: string; message: string }[] = [];
    if (ctx.role !== 'seller') {
      const params: unknown[] = [ctx.companyId];
      const scope = await scopeSql(ctx, 'a.user_id', params);
      const { rows } = await db.query(`SELECT a.id, a.message FROM argos_alerts a WHERE a.company_id = $1 AND a.resolved_at IS NULL AND a.ack_at IS NULL ${scope} ORDER BY a.started_at DESC LIMIT 20`, params);
      openAlerts = rows.length;
      recentAlerts = rows;
    }

    const mParams: unknown[] = [ctx.companyId];
    const received = await receivedSql(ctx, mParams);
    mParams.push(ctx.userId);
    const unread = await db.query(
      `SELECT count(*)::int AS n FROM argos_messages m
        WHERE m.company_id = $1 AND ${received}
          AND NOT EXISTS (SELECT 1 FROM argos_message_reads r WHERE r.message_id = m.id AND r.user_id = $${mParams.length})`,
      mParams,
    );

    // Pendientes hasta el final de hoy (incluye atrasados de los últimos 30 días).
    const dayStart = startOfLocalDay(ctx.company.timezone);
    const aParams: unknown[] = [ctx.companyId, new Date(dayStart.getTime() - 30 * 86400_000).toISOString(), new Date(dayStart.getTime() + 86400_000).toISOString()];
    const visible = await agendaVisibility(ctx, aParams);
    const tasks = await db.query(
      `SELECT count(*)::int AS n FROM argos_agenda a
        WHERE a.company_id = $1 AND a.status = 'pendiente' AND a.starts_at >= $2::timestamptz AND a.starts_at < $3::timestamptz ${visible}`,
      aParams,
    );

    // Pedidos de Hermes que esperan a una persona.
    const hParams: unknown[] = [ctx.companyId];
    let hScope = '';
    if (ctx.role === 'seller') {
      hParams.push(ctx.userId);
      hScope = ' AND seller_user_id = $2';
    }
    // Para la vendedora lo pendiente son las correcciones que le pidieron, no la atención de logística.
    const hermes = await db.query(`SELECT count(*)::int AS n FROM hermes_orders WHERE company_id = $1 AND ${ctx.role === 'seller' ? 'correction_requested_at IS NOT NULL' : 'attention'} ${hScope}`, hParams);

    return { hermesAttention: hermes.rows[0].n, openAlerts, recentAlerts, unreadMessages: unread.rows[0].n, pendingToday: tasks.rows[0].n };
  });
}
