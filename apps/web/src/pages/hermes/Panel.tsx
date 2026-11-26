import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth';
import { api, useApi } from '../../lib/api';
import { fmtMinutes } from '../../lib/format';
import { Badge, Empty, ErrorNote, Field, Loading, PageHero } from '../../components/ui';
import { money } from './shared';
import { ChannelCard } from './Channel';
import { OperatorsCard } from './Operators';

interface Agg { name?: string; total: number; confirmed: number; dispatched: number; delivered: number; returned: number; cancelled: number; deliveredValue: number }
interface PanelData { days: number; totals: Agg & { pending: number; attention: number }; bySeller: Agg[]; byCity: Agg[]; byCarrier: Agg[]; byOperator: Agg[]; byIncident: { type: string; label: string; total: number; resolved: number; returned: number }[]; messages: { sent: number; received: number }; minutesToConfirm: number | null }

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
/** Tasa de entrega: entregados entre los pedidos despachados que ya terminaron (entregados + devueltos). */
const deliveryRate = (r: Agg) => pct(r.delivered, r.delivered + r.returned);
const rateTone = (p: number) => (p >= 80 ? 'ok' : p >= 60 ? 'warn' : 'danger');

export function HermesPanel() {
  const [days, setDays] = useState(30);
  const panel = useApi<PanelData>(`/api/hermes/panel?days=${days}`, 60_000);
  const d = panel.data;
  const t = d?.totals;

  return (
    <>
      <PageHero
        tone="hermes"
        title="Panel de entregas"
        subtitle="Cuántos pedidos se confirman y cuántos llegan de verdad. En contraentrega, la venta que cuenta es la entregada."
        kpis={[
          { label: 'Pedidos', value: t?.total ?? '—' },
          { label: 'Confirmación', value: t && pct(t.confirmed, t.total) !== null ? `${pct(t.confirmed, t.total)} %` : '—' },
          { label: 'Tasa de entrega', value: t && deliveryRate(t) !== null ? `${deliveryRate(t)} %` : '—' },
          { label: 'Valor entregado', value: t ? money(t.deliveredValue) : '—' },
        ]}
      >
        <select aria-label="Periodo" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Últimos 7 días</option><option value={30}>Últimos 30 días</option><option value={90}>Últimos 90 días</option>
        </select>
      </PageHero>
      <ErrorNote error={panel.error} />

      {!d || !t ? <Loading /> : t.total === 0 ? (
        <div className="card"><Empty>Aún no hay pedidos en este periodo.</Empty></div>
      ) : (
        <>
          <div className="grid cols-2">
            <div className="card">
              <div className="card-head"><h2>Embudo</h2><span className="xs muted">De los {t.total} pedidos del periodo</span></div>
              <div className="funnel">
                {[['Pedidos creados', t.total], ['Confirmados', t.confirmed], ['Despachados', t.dispatched], ['Entregados', t.delivered]].map(([label, value]) => (
                  <div className="funnel-row" key={label as string}>
                    <span>{label}</span>
                    <div className="funnel-track"><i style={{ width: `${((value as number) / t.total) * 100}%` }} /></div>
                    <strong>{value}</strong><span className="muted">{pct(value as number, t.total)} %</span>
                  </div>
                ))}
              </div>
              <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
                Fuera del embudo: {t.pending} por confirmar · {t.cancelled} cancelados · {t.returned} devueltos.
                {d.minutesToConfirm !== null && ` El cliente tarda en promedio ${fmtMinutes(d.minutesToConfirm)} en confirmar.`}
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Novedades por tipo</h2></div>
              {d.byIncident.length ? (
                <table>
                  <thead><tr><th>Tipo</th><th>Total</th><th>Gestionadas</th><th>En devolución</th></tr></thead>
                  <tbody>{d.byIncident.map((i) => <tr key={i.type}><td>{i.label}</td><td>{i.total}</td><td>{i.resolved}</td><td>{i.returned}</td></tr>)}</tbody>
                </table>
              ) : <Empty>Sin novedades en el periodo.</Empty>}
              <div className="card-pad small muted" style={{ borderTop: '1px solid var(--color-border)' }}>
                Mensajes del periodo: {d.messages.sent} enviados y {d.messages.received} recibidos.
              </div>
            </div>
          </div>

          <RateTable title="Por vendedora" note="Quién vende pedidos que sí llegan" first="Vendedora" rows={d.bySeller} />
          <div className="grid cols-2">
            <RateTable title="Por ciudad" first="Ciudad" rows={d.byCity} compact />
            <RateTable title="Por transportadora" first="Transportadora" rows={d.byCarrier} compact />
            {d.byOperator.length > 0 && <RateTable title="Por operador logístico" first="Operador" rows={d.byOperator} compact />}
          </div>
        </>
      )}

      <SettingsCard />
      <OperatorsCard />
      <AdminChannel />
    </>
  );
}

function RateTable({ title, note, first, rows, compact }: { title: string; note?: string; first: string; rows: Agg[]; compact?: boolean }) {
  return (
    <div className="card">
      <div className="card-head"><h2>{title}</h2>{note && <span className="xs muted">{note}</span>}</div>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{first}</th><th>Pedidos</th>{!compact && <th>Confirmados</th>}<th>Entregados</th><th>Devueltos</th><th>Tasa de entrega</th>{!compact && <th>Valor entregado</th>}</tr></thead>
            <tbody>
              {rows.map((r) => {
                const rate = deliveryRate(r);
                return (
                  <tr key={r.name}>
                    <td><strong>{r.name}</strong></td>
                    <td>{r.total}</td>
                    {!compact && <td>{r.confirmed}<span className="sub">{pct(r.confirmed, r.total)} %</span></td>}
                    <td>{r.delivered}</td>
                    <td>{r.returned}</td>
                    <td style={{ minWidth: 150 }}>
                      {rate === null ? <span className="muted">Sin entregas cerradas</span> : (
                        <div className="rate"><div className="rate-track"><i className={rateTone(rate)} style={{ width: `${rate}%` }} /></div><Badge tone={rateTone(rate)}>{rate} %</Badge></div>
                      )}
                    </td>
                    {!compact && <td className="nowrap">{money(r.deliveredValue)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <Empty>Sin datos todavía.</Empty>}
    </div>
  );
}

/** La conexión del canal lleva un token: solo la ve el administrador. */
function AdminChannel() {
  const { me } = useAuth();
  return me?.user.role === 'admin' ? <ChannelCard /> : null;
}

function SettingsCard() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const settings = useApi<{ settings: { driver: string; reminderMinutes: number[]; escalateMinutes: number; botName: string; noReplyAction: string } }>('/api/hermes/settings');
  const [reminders, setReminders] = useState('');
  const [botName, setBotName] = useState('');
  const [noReply, setNoReply] = useState('persona');
  const [escalate, setEscalate] = useState(360);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) {
      setReminders(settings.data.settings.reminderMinutes.join(', '));
      setEscalate(settings.data.settings.escalateMinutes);
      setBotName(settings.data.settings.botName);
      setNoReply(settings.data.settings.noReplyAction);
    }
  }, [settings.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const list = reminders.split(/[\s,]+/).filter(Boolean).map(Number);
      if (list.some((n) => !Number.isFinite(n))) throw new Error('Los recordatorios deben ser números de minutos separados por comas.');
      await api('PUT', '/api/hermes/settings', { reminderMinutes: list, escalateMinutes: escalate, botName: botName.trim(), noReplyAction: noReply });
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="card-head">
        <h2>Ajustes del bot</h2>
        {settings.data?.settings.driver === 'simulado' ? <Badge tone="warn">Modo simulado</Badge> : <Badge tone="ok">Enviando por WhatsApp</Badge>}
      </div>
      <div className="card-pad stack">
        {settings.data?.settings.driver === 'simulado' && (
          <div className="alert info">
            Hermes está en <strong>modo simulado</strong>: recorre todo el proceso y guarda los mensajes, pero no envía nada al cliente. Sirve para probar.
            Para enviar de verdad, conecta el WhatsApp en «WhatsApp por Pancake», más abajo.
          </div>
        )}
        <ErrorNote error={error ?? settings.error} />
        {saved && <div className="alert ok" role="status">Ajustes guardados.</div>}
        <Field label="Nombre con el que el bot se presenta" hint="Es quien firma el primer mensaje: «Soy Valentina de tu tienda». Si lo dejas vacío, se presenta como Hermes.">
          <input maxLength={30} value={botName} disabled={!isAdmin} onChange={(e) => setBotName(e.target.value)} placeholder="Ej.: Valentina" style={{ maxWidth: 320 }} />
        </Field>
        <div className="grid cols-2">
          <Field label="Recordatorios de confirmación (minutos)" hint="Separados por comas. Cada uno cuenta desde el mensaje anterior. Ej.: 30, 180">
            <input value={reminders} disabled={!isAdmin} onChange={(e) => setReminders(e.target.value)} />
          </Field>
          <Field label="Esperar tras el último recordatorio (minutos)" hint="Pasado este tiempo sin respuesta se aplica lo que elijas abajo.">
            <input type="number" min={15} max={4320} value={escalate} disabled={!isAdmin} onChange={(e) => setEscalate(Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Si el cliente no responde" hint={noReply === 'confirmar' ? 'El pedido queda confirmado y listo para despachar, sin escribirle al cliente. Los clientes con riesgo alto de devolución siguen pasando a una persona. Si después el cliente pide corregir o cancelar, el pedido pasa a una persona.' : 'El pedido queda en «Por atender» para que alguien lo llame o lo cancele. No se despacha sin confirmación.'}>
          <select value={noReply} disabled={!isAdmin} onChange={(e) => setNoReply(e.target.value)} style={{ maxWidth: 420 }}>
            <option value="persona">Pasarlo a una persona</option>
            <option value="confirmar">Confirmar el pedido automáticamente</option>
          </select>
        </Field>
        {isAdmin && <div><button className="btn primary">Guardar ajustes</button></div>}
      </div>
    </form>
  );
}
