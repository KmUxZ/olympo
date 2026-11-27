// Hermes · archivo de carga masiva para el operador. Baja los pedidos confirmados en el formato exacto de la
// plantilla de Hoko, para subirlos allá y generar las guías. Solo sale lo que el cliente ya confirmó.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { badRequest, guard, notFound, parse } from '../core/http.ts';
import { buildXlsx, excelDate } from '../core/xlsx.ts';
import type { Cell } from '../core/xlsx.ts';
import { findCity } from './address.ts';
import { HOKO_HEADERS, HOKO_MUNICIPALITIES } from './hoko-cities.ts';
import * as bot from './bot.ts';

const configBody = z.object({
  carrier: z.string().trim().min(2).max(80),          // tal como aparece en la lista de transportadoras de Hoko
  stockId: z.coerce.number().int().positive(),         // producto de Hoko con el que se carga la orden
  height: z.coerce.number().positive().max(300).default(10),
  width: z.coerce.number().positive().max(300).default(10),
  length: z.coerce.number().positive().max(300).default(5),
  weight: z.coerce.number().positive().max(100).default(1),
  declaredValue: z.coerce.number().int().min(0).max(50_000_000).default(0),
  deliveryDays: z.coerce.number().int().min(0).max(30).default(3),
  paidLabel: z.string().trim().max(40).default(''),    // cómo se escribe en Hoko un pedido ya pagado
});
type Config = z.infer<typeof configBody>;

/** Mayúsculas sin tildes (conserva la Ñ), como va en el archivo que se sube a Hoko. */
export function hokoText(s: string): string {
  return s.replace(/[ñÑ]/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\u0001/g, 'Ñ').replace(/\s+/g, ' ').trim().toUpperCase();
}
const DEPARTMENT_OF = new Map<string, string>();
for (const [dep, cities] of Object.entries(HOKO_MUNICIPALITIES)) for (const c of cities.split('|')) DEPARTMENT_OF.set(c, dep);

/** Ciudad y departamento en la forma de Hoko. El departamento queda vacío si el nombre no se reconoce o existe en dos. */
export function hokoPlace(rawCity: string, rawDepartment: string): { city: string; department: string } {
  const known = findCity(rawCity);
  const first = hokoText(known?.name ?? rawCity.split(/[,(/]/)[0] ?? '');
  const typed = hokoText(rawDepartment || rawCity.split(/[,(/-]/)[1] || '');
  const typedDep = typed === 'VALLE' ? 'VALLE DEL CAUCA' : typed;
  const department = (typedDep && Object.hasOwn(HOKO_MUNICIPALITIES, typedDep) ? typedDep : '') || (known ? hokoText(known.department).replace(/^BOGOTA D\.?C\.?$/, 'BOGOTA') : '') || DEPARTMENT_OF.get(first) || '';
  return { city: first, department };
}

interface Row { id: string; code: string; customer_name: string; phone: string; address: string; city: string; department: string; notes: string; items: { name: string; qty: number; free?: boolean }[]; total: number; payment: string; operator_id: string | null; exported_at: string | null }

async function operatorOf(companyId: string, id: string) {
  const { rows } = await db.query<{ id: string; name: string; export_config: Config | null }>(`SELECT id, name, export_config FROM hermes_operators WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!rows[0]) throw notFound('Operador no encontrado.');
  return rows[0];
}

async function candidates(companyId: string, operatorId: string, includeUnassigned: boolean, again: boolean): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, code, customer_name, phone, address, city, department, notes, items, total, payment, operator_id, exported_at
       FROM hermes_orders
      WHERE company_id = $1 AND status = 'confirmado' AND tracking_number = ''
        AND (operator_id = $2 OR ($3 AND operator_id IS NULL))
        AND ($4 OR exported_at IS NULL)
      ORDER BY created_at ASC LIMIT 2000`,
    [companyId, operatorId, includeUnassigned, again],
  );
  return rows;
}

const local10 = (phone: string) => Number(phone.startsWith('57') && phone.length === 12 ? phone.slice(2) : phone);

export function exportRoutes(app: FastifyInstance): void {
  /** Cuántos pedidos saldrían en el archivo y con qué valores fijos. */
  app.get('/api/hermes/export', guard('admin', 'supervisor'), async (req) => {
    const q = parse(z.object({ operatorId: z.uuid() }), req.query);
    const op = await operatorOf(req.ctx.companyId, q.operatorId);
    const all = await candidates(req.ctx.companyId, op.id, true, true);
    const fresh = all.filter((o) => !o.exported_at);
    return {
      config: op.export_config,
      assigned: fresh.filter((o) => o.operator_id).length,
      unassigned: fresh.filter((o) => !o.operator_id).length,
      already: all.length - fresh.length,
      paid: fresh.filter((o) => o.payment === 'pagado').length,
      noDepartment: fresh.filter((o) => !hokoPlace(o.city, o.department).department).map((o) => ({ code: o.code, city: o.city })),
    };
  });

  app.put('/api/hermes/operators/:id/export-config', guard('admin', 'supervisor'), async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(configBody, req.body);
    const op = await operatorOf(req.ctx.companyId, id);
    await db.query(`UPDATE hermes_operators SET export_config = $2::jsonb WHERE id = $1`, [op.id, JSON.stringify(b)]);
    return { ok: true };
  });

  /** Devuelve el archivo .xlsx y deja marcados los pedidos como descargados. */
  app.post('/api/hermes/export', guard('admin', 'supervisor'), async (req, reply) => {
    const b = parse(z.object({ operatorId: z.uuid(), includeUnassigned: z.boolean().default(false), again: z.boolean().default(false) }), req.body);
    const op = await operatorOf(req.ctx.companyId, b.operatorId);
    const cfg = op.export_config;
    if (!cfg) throw badRequest('Primero guarda los datos de la plantilla de este operador.', 'sin_plantilla');
    const orders = await candidates(req.ctx.companyId, op.id, b.includeUnassigned, b.again);
    if (!orders.length) throw badRequest('No hay pedidos confirmados por descargar.', 'sin_pedidos');
    if (!cfg.paidLabel && orders.some((o) => o.payment === 'pagado')) throw badRequest('Hay pedidos ya pagados y falta indicar cómo se escribe esa forma de pago en Hoko.', 'sin_forma_pago');

    const bogota = new Date(Date.now() - 5 * 3_600_000 + cfg.deliveryDays * 86_400_000);
    const eta = { date: excelDate(bogota.getUTCFullYear(), bogota.getUTCMonth() + 1, bogota.getUTCDate()) };
    const rows: Cell[][] = [HOKO_HEADERS];
    for (const o of orders) {
      const place = hokoPlace(o.city, o.department);
      const phone = local10(o.phone);
      const contents = o.items.map((i) => (i.free ? i.name : `${i.qty} × ${i.name}`)).join(', ').slice(0, 200);
      rows.push([
        o.customer_name, phone, null, phone, place.city, place.department, o.address, o.notes || null, cfg.carrier, null, eta,
        o.payment === 'pagado' ? cfg.paidLabel : 'RECAUDO', cfg.height, cfg.width, cfg.length, cfg.weight, contents, cfg.declaredValue || null,
        cfg.stockId, 1, o.total,
      ]);
    }
    const file = buildXlsx('ordenes', rows);

    const ids = orders.map((o) => o.id);
    await db.query(`UPDATE hermes_orders SET exported_at = now(), operator_id = COALESCE(operator_id, $2), updated_at = now() WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`, [JSON.stringify(ids), op.id]);
    for (const o of orders) {
      const full = await bot.getOrder(req.ctx.companyId, o.id);
      if (full) await bot.logEvent(full, 'exportado', `Descargado en el archivo de carga de ${op.name}`, req.ctx.name);
    }
    const stamp = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 16).replace(/[T:]/g, '-');
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="carga-${hokoText(op.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}.xlsx"`)
      .header('x-hermes-count', String(orders.length))
      .send(file);
  });
}
