import { useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { api, useApi, useNow } from '../lib/api';
import { ago, fmtDateTime } from '../lib/format';
import { Badge, Empty, ErrorNote, Freshness, Loading, PageHero } from '../components/ui';

interface Alert { id: string; type: string; typeLabel: string; userName: string; message: string; startedAt: string; resolvedAt: string | null; ackAt: string | null; ackByName: string | null }
interface Rule { type: string; label: string; help: string; defaultMinutes: number; enabled: boolean; thresholdMinutes: number }

export function Alarms() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const [state, setState] = useState<'open' | 'all'>('open');
  const alerts = useApi<{ alerts: Alert[] }>(`/api/argos/alerts?state=${state}`, 20_000);
  const rules = useApi<{ rules: Rule[] }>('/api/argos/alarms/rules');
  const now = useNow(15_000);
  const [form, setForm] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  useEffect(() => {
    if (rules.data && !form) setForm(rules.data.rules);
  }, [rules.data, form]);

  async function ack(id: string) {
    setError(null);
    try {
      await api('POST', `/api/argos/alerts/${id}/ack`);
      await alerts.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function save() {
    if (!form) return;
    setError(null);
    setSaved(false);
    try {
      await api('PUT', '/api/argos/alarms/rules', { rules: form.map((r) => ({ type: r.type, enabled: r.enabled, thresholdMinutes: r.thresholdMinutes })) });
      setSaved(true);
      await alerts.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const openAlerts = (alerts.data?.alerts ?? []).filter((a) => !a.resolvedAt);
  const patch = (type: string, change: Partial<Rule>) => setForm((f) => f && f.map((r) => (r.type === type ? { ...r, ...change } : r)));

  return (
    <>
      <PageHero kpis={[{ label: 'Sin atender', value: openAlerts.filter((a) => !a.ackAt).length }, { label: 'En atención', value: openAlerts.filter((a) => a.ackAt).length }, { label: 'Reglas activas', value: form ? form.filter((r) => r.enabled).length : '—' }]} title="Alarmas" subtitle="Avisos automáticos sobre situaciones operativas. Se abren y se cierran solas según lo que está pasando.">
        <Freshness updatedAt={alerts.updatedAt} error={alerts.error} staleAfterMs={60_000} />
        {permission === 'default' && (
          <button className="btn sm" onClick={() => void Notification.requestPermission().then(setPermission)}>Activar avisos del navegador</button>
        )}
      </PageHero>
      <ErrorNote error={error} />
      {permission === 'granted' && <p className="small muted">Avisos del navegador activados: recibirás una notificación mientras tengas Argos abierto en una pestaña.</p>}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={state === 'open'} onClick={() => setState('open')}>Abiertas</button>
        <button role="tab" aria-selected={state === 'all'} onClick={() => setState('all')}>Historial</button>
      </div>
      <div className="card">
        {!alerts.data ? (alerts.error ? <ErrorNote error={alerts.error} /> : <Loading />) : alerts.data.alerts.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Situación</th><th>Tipo</th><th>Desde</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {alerts.data.alerts.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.message}</strong></td>
                    <td>{a.typeLabel}</td>
                    <td className="nowrap">{fmtDateTime(a.startedAt)}<span className="sub">{a.resolvedAt ? `Terminó ${fmtDateTime(a.resolvedAt)}` : ago(a.startedAt, now)}</span></td>
                    <td>
                      {a.resolvedAt ? <Badge tone="plain">Terminada</Badge> : a.ackAt ? <Badge tone="info">En atención</Badge> : <Badge tone="danger">Sin atender</Badge>}
                      {a.ackByName && <span className="sub">Enterado: {a.ackByName}</span>}
                    </td>
                    <td>{!a.resolvedAt && !a.ackAt && <button className="btn sm" onClick={() => void ack(a.id)}>Enterado</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{state === 'open' ? 'No hay alertas abiertas.' : 'Aún no hay alertas registradas.'}</Empty>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>Reglas</h2>{!isAdmin && <span className="xs muted">Solo un administrador puede cambiarlas</span>}</div>
        {!form ? <Loading /> : (
          <>
            <table>
              <thead><tr><th>Activa</th><th>Regla</th><th>Avisar tras (minutos)</th></tr></thead>
              <tbody>
                {form.map((r) => (
                  <tr key={r.type}>
                    <td><input type="checkbox" aria-label={`Activar ${r.label}`} checked={r.enabled} disabled={!isAdmin} onChange={(e) => patch(r.type, { enabled: e.target.checked })} /></td>
                    <td><strong>{r.label}</strong><span className="sub">{r.help}</span></td>
                    <td><input type="number" aria-label={`Minutos para ${r.label}`} min={1} max={600} value={r.thresholdMinutes} disabled={!isAdmin || !r.enabled} onChange={(e) => patch(r.type, { thresholdMinutes: Number(e.target.value) })} style={{ maxWidth: 110 }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isAdmin && (
              <div className="card-pad row" style={{ borderTop: '1px solid var(--color-border)' }}>
                <button className="btn primary" onClick={() => void save()}>Guardar reglas</button>
                {saved && <span className="small" role="status" style={{ color: 'var(--color-ok)' }}>Reglas guardadas.</span>}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
