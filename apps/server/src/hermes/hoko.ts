// Hermes · conector de Hoko. Hoko envía un aviso («Reporte de actualización de guía») cada vez que
// se crea o cambia una guía: trae el número de orden, la guía, el estado y el teléfono del cliente.
// Con eso Hermes encuentra el pedido (solo por teléfono), guarda la guía y mueve el estado.
// Referencia: https://hoko.com.co/api-documentation · modelos GuideWebhookPayload y GuideState.
import { db } from '../db/db.ts';
import * as bot from './bot.ts';

export interface HokoOperator { id: string; company_id: string; name: string; carrier: string }

/** Qué significa para Hermes cada estado de guía de Hoko. Un valor desconocido se trata como en tránsito. */
type Step = 'espera' | 'transito' | 'reparto' | 'oficina' | 'novedad' | 'entregado' | 'devuelto' | 'aviso';
/** Estados en los que el pedido todavía espera su guía. */
const WAITING = ['confirmado', 'por_confirmar'];
const STATES: Record<number, { step: Step; label: string; note?: string }> = {
  0: { step: 'aviso', label: 'Cancelada', note: 'Hoko canceló la guía de este pedido' },
  1: { step: 'espera', label: 'Activa' },
  2: { step: 'transito', label: 'Despachada' },
  3: { step: 'entregado', label: 'Entregada' },
  4: { step: 'aviso', label: 'Siniestro', note: 'La transportadora reportó un siniestro con este envío' },
  5: { step: 'espera', label: 'Generada' },
  6: { step: 'novedad', label: 'En Novedad' },
  7: { step: 'reparto', label: 'En Reparto' },
  8: { step: 'transito', label: 'En Bodega' },
  9: { step: 'transito', label: 'Transito' },
  10: { step: 'oficina', label: 'Reclamar Oficina' },
  11: { step: 'devuelto', label: 'Devolución' },
  13: { step: 'espera', label: 'En Proceso' },
  15: { step: 'transito', label: 'En espera de ruta doméstica' },
  17: { step: 'entregado', label: 'Pagado' },
  18: { step: 'aviso', label: 'Error por Saldo', note: 'Hoko no pudo generar la guía por saldo insuficiente' },
  19: { step: 'aviso', label: 'Transito Devolución', note: 'El envío va de regreso en devolución' },
  20: { step: 'devuelto', label: 'Devolución Cobrado' },
};

/** Tipo de novedad de Hermes según el texto que da la transportadora. */
function incidentType(text: string): string {
  const t = text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (/direcci|nomenclatura|no existe/.test(t)) return 'direccion';
  if (/rehus|rechaz|no quiere|no recibe/.test(t)) return 'rehusado';
  if (/ausente|no se encuentra|cerrado|nadie|no hay quien/.test(t)) return 'ausente';
  if (/telefono|no contesta|celular/.test(t)) return 'telefono';
  if (/zona|cobertura|dificil acceso/.test(t)) return 'zona';
  return 'otro';
}

const text = (v: unknown, max: number): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

type Row = bot.Order & { operator_id: string | null; operator_ref: string; operator_state: string };

/** Procesa un aviso de guía. Devuelve qué hizo, que es también lo que queda en el registro. */
export async function handleGuideEvent(op: HokoOperator, raw: unknown): Promise<string> {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ref = text(p.order_id, 24);
  const number = text(p.number, 60);
  const stateNum = Number(p.last_state);
  const state = Number.isInteger(stateNum) && stateNum >= 0 ? stateNum : NaN;
  const phone = bot.normalizePhone(text(p.phone, 25));
  const meaning = STATES[state] ?? { step: 'transito' as Step, label: text(p.last_state_name, 60) || `Estado ${text(p.last_state, 10)}` };
  const histories = Array.isArray(p.guide_histories) ? p.guide_histories : [];
  const lastDescription = text((histories[0] as Record<string, unknown> | undefined)?.description, 300);

  let order: Row | null = null;
  const record = async (result: string) => {
    await db.query(
      `INSERT INTO hermes_operator_events (company_id, operator_id, external_ref, guide_number, state, state_name, phone, order_id, result) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [op.company_id, op.id, ref, number, Number.isNaN(state) ? '' : String(state), meaning.label, phone, order?.id ?? null, result],
    );
    await db.query(`UPDATE hermes_operators SET last_event_at = now() WHERE id = $1`, [op.id]);
    return result;
  };
  if (!ref || Number.isNaN(state)) return record('Aviso incompleto: sin número de orden o sin estado.');

  // 1. El pedido ya está enlazado con esa orden de Hoko.
  order = (await db.query<Row>(`SELECT * FROM hermes_orders WHERE company_id = $1 AND operator_id = $2 AND operator_ref = $3 LIMIT 1`, [op.company_id, op.id, ref])).rows[0] ?? null;
  // 2. Primera vez: se busca por el teléfono del cliente entre los pedidos confirmados sin orden enlazada.
  if (!order) {
    if (phone.length < 10) return record('El aviso no trae un teléfono válido para buscar el pedido.');
    const { rows } = await db.query<Row>(
      `SELECT * FROM hermes_orders WHERE company_id = $1 AND phone = $2 AND status IN ('confirmado', 'por_confirmar') AND operator_ref = '' AND (operator_id IS NULL OR operator_id = $3) ORDER BY created_at`,
      [op.company_id, phone, op.id],
    );
    if (rows.length > 1) return record(`Hay ${rows.length} pedidos abiertos con ese teléfono (${rows.map((r) => r.code).join(', ')}): enlázalo a mano.`);
    if (!rows.length) {
      const other = (await db.query<{ code: string; status: string }>(
        `SELECT code, status FROM hermes_orders WHERE company_id = $1 AND phone = $2 AND status NOT IN ('entregado', 'devuelto', 'cancelado') ORDER BY created_at DESC LIMIT 1`,
        [op.company_id, phone],
      )).rows[0];
      if (other) return record(`El pedido ${other.code} de ese teléfono ya tiene otra guía o es de otro operador.`);
      return record('No hay un pedido pendiente de guía con ese teléfono.');
    }
    order = rows[0];
    await db.query(`UPDATE hermes_orders SET operator_id = $2, operator_ref = $3, updated_at = now() WHERE id = $1`, [order.id, op.id, ref]);
    await bot.logEvent(order, 'operador_asignado', `Enlazado con la orden ${ref} de ${op.name}`, op.name);
  }

  // Hoko repite avisos con el mismo estado: solo se actúa cuando cambia.
  if (order.operator_state === String(state)) return record('Sin cambios: ese estado ya estaba registrado.');
  // Si el paquete ya salió de la oficina, se dejan de enviar los recordatorios de oficina.
  await db.query(`UPDATE hermes_orders SET operator_state = $2, office_at = CASE WHEN $2 = '10' THEN office_at ELSE NULL END WHERE id = $1`, [order.id, String(state)]);
  if (['entregado', 'devuelto', 'cancelado'].includes(order.status)) return record(`El pedido ya estaba cerrado (${order.status}); no se cambió.`);

  const fresh = async () => (await bot.getOrder(op.company_id, order!.id))!;
  const carrier = op.carrier || op.name;
  /** Si el pedido aún no figura despachado, se despacha con la guía (y el bot se la envía al cliente). */
  const ensureDispatched = async (): Promise<bot.Order | null> => {
    let o = await fresh();
    if (WAITING.includes(o.status)) {
      if (!number) return null;
      // La guía ya existe: se envía aunque el cliente no haya respondido la confirmación.
      if (o.status === 'por_confirmar') await bot.logEvent(o, 'confirmado', 'Se despacha sin esperar la confirmación: el operador ya generó la guía', op.name);
      await bot.dispatch(o, { carrier, trackingNumber: number, trackingUrl: '' }, op.name);
      o = await fresh();
    }
    return o;
  };

  switch (meaning.step) {
    case 'espera': {
      // Con la guía ya generada el cliente la recibe de una vez, sin esperar a que la transportadora la recoja.
      if (!number) return record(`Guía en preparación (${meaning.label}): se avisará al cliente cuando tenga número.`);
      const was = order.status;
      await ensureDispatched();
      return record(WAITING.includes(was) ? `Guía ${number} generada: se le envió al cliente.` : `${meaning.label}: sin cambio para el cliente.`);
    }
    case 'transito': {
      const was = order.status;
      const o = await ensureDispatched();
      if (!o) return record('El aviso no trae número de guía: no se pudo despachar.');
      return record(WAITING.includes(was) ? `Despachado con la guía ${number}.` : `${meaning.label}: sin cambio para el cliente.`);
    }
    case 'reparto': {
      const o = await ensureDispatched();
      if (!o) return record('El aviso no trae número de guía: no se pudo despachar.');
      if (o.status === 'despachado' || o.status === 'novedad') await bot.outForDelivery(o, op.name);
      return record('En reparto.');
    }
    case 'oficina': {
      const o = await ensureDispatched();
      if (!o) return record('El aviso no trae número de guía: no se pudo despachar.');
      if (await bot.readyForPickup(o, op.name)) return record('En oficina: se le avisó al cliente para que lo reclame.');
      // Sin plantilla aprobada el cliente no se entera: que lo vea una persona.
      await bot.setAttention(await fresh(), `${op.name}: el paquete está en la oficina de la transportadora y no se le pudo avisar al cliente`);
      return record('En oficina: no se pudo avisar al cliente; quedó para que una persona lo revise.');
    }
    case 'novedad': {
      const o = await ensureDispatched();
      if (!o) return record('El aviso no trae número de guía: no se pudo despachar.');
      if (o.status === 'despachado' || o.status === 'en_reparto') {
        await bot.reportIncident(o, incidentType(lastDescription), lastDescription, op.name);
        return record(`Novedad reportada${lastDescription ? `: ${lastDescription}` : ''}.`);
      }
      return record('Novedad: el pedido ya tenía una novedad abierta.');
    }
    case 'entregado': {
      const o = await ensureDispatched();
      if (!o) return record('El aviso no trae número de guía: no se pudo marcar.');
      await bot.delivered(o, op.name);
      return record('Entregado.');
    }
    case 'devuelto': {
      const o = await ensureDispatched();
      if (!o) return record('El aviso no trae número de guía: no se pudo marcar.');
      await bot.returned(o, op.name);
      return record('Devuelto.');
    }
    case 'aviso': {
      // Estados que una persona debe mirar: no se le escribe al cliente.
      const o = state === 0 || state === 18 ? await fresh() : (await ensureDispatched()) ?? (await fresh());
      await bot.setAttention(o, `${op.name}: ${meaning.note ?? meaning.label}`);
      return record(`${meaning.label}: se marcó para que una persona lo revise.`);
    }
  }
}

/**
 * Pedidos ya enlazados a una orden del operador cuya guía se conoce pero que siguen sin despachar
 * (el aviso llegó cuando la guía todavía no se enviaba al generarse, o el envío falló). Se ponen al día.
 */
export async function dispatchLinkedGuides(): Promise<void> {
  const { rows } = await db.query<{ id: string; company_id: string; guide: string; carrier: string; name: string }>(
    `SELECT o.id, o.company_id, op.carrier, op.name,
            (SELECT e.guide_number FROM hermes_operator_events e WHERE e.operator_id = o.operator_id AND e.external_ref = o.operator_ref AND e.guide_number <> '' ORDER BY e.at DESC LIMIT 1) AS guide
       FROM hermes_orders o JOIN hermes_operators op ON op.id = o.operator_id
      WHERE o.status IN ('confirmado', 'por_confirmar') AND o.operator_ref <> '' AND o.tracking_number = '' AND o.operator_state IN ('1', '5', '13')
      ORDER BY o.updated_at LIMIT 50`,
  );
  for (const r of rows) {
    if (!r.guide) continue;
    const o = await bot.getOrder(r.company_id, r.id);
    if (o && WAITING.includes(o.status)) await bot.dispatch(o, { carrier: r.carrier || r.name, trackingNumber: r.guide, trackingUrl: '' }, r.name);
  }
}
