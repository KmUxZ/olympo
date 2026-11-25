// Zeus · seguimientos: lo que hay que hacer con cada cliente y qué pasó.
// La vendedora ve solo los suyos, con el nombre y el WhatsApp del cliente, sin su historial de pedidos.
import { useMemo, useState } from 'react';
import { useAuth } from '../../auth';
import { api, useApi } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, PageHero } from '../../components/ui';
import { CustomerModal, fmtDay, OUTCOME, WhatsLink } from './shared';
import type { Followup } from './shared';

interface User { id: string; name: string; status: string }

export function ZeusFollowups() {
  const { me } = useAuth();
  const seller = me?.user.role === 'seller';
  const [status, setStatus] = useState<'pendiente' | 'hecho' | 'descartado'>('pendiente');
  const [who, setWho] = useState('');
  const users = useApi<{ users: User[] }>(seller ? null : '/api/users');
  const path = useMemo(() => `/api/zeus/followups?status=${status}${who ? `&assignedUserId=${who}` : ''}`, [status, who]);
  const list = useApi<{ today: string; followups: Followup[] }>(path, 60_000);
  const [closing, setClosing] = useState<Followup | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = list.data?.followups ?? [];
  const today = list.data?.today ?? '';
  const overdue = status === 'pendiente' ? rows.filter((f) => f.dueOn < today).length : 0;
  const refresh = async () => {
    await list.reload();
    window.dispatchEvent(new Event('olympo:notifications'));
  };

  async function patch(f: Followup, body: Record<string, unknown>) {
    setError(null);
    try {
      await api('PATCH', `/api/zeus/followups/${f.id}`, body);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHero
        tone="zeus"
        title={seller ? 'Mis seguimientos' : 'Seguimientos'}
        subtitle={seller ? 'Clientes a los que debes escribirles. Cuando lo hagas, registra qué pasó.' : 'Lo que hay que hacer con cada cliente, quién lo hace y qué resultado tuvo.'}
        kpis={status === 'pendiente' ? [{ label: 'Pendientes', value: list.data ? rows.length : '—' }, { label: 'Vencidos', value: list.data ? overdue : '—' }] : []}
      />
      <div className="card card-pad row">
        <div className="tabs" role="tablist" style={{ borderBottom: 0 }}>
          {(['pendiente', 'hecho', 'descartado'] as const).map((s) => <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)}>{{ pendiente: 'Pendientes', hecho: 'Hechos', descartado: 'Descartados' }[s]}</button>)}
        </div>
        {!seller && (
          <select aria-label="Persona encargada" value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 240, marginLeft: 'auto' }}>
            <option value="">Todas las personas</option>
            {(users.data?.users ?? []).filter((u) => u.status === 'active').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
      </div>

      <div className="card">
        <ErrorNote error={error ?? list.error} />
        {!list.data ? <Loading /> : rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Cliente</th><th>WhatsApp</th><th>Qué hay que hacer</th><th>{status === 'pendiente' ? 'Para cuándo' : 'Resultado'}</th>{!seller && <th>Encargada</th>}<th></th></tr></thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id}>
                    <td><strong>{f.customerName}</strong></td>
                    <td><WhatsLink phone={f.phone} /></td>
                    <td>{f.title}{f.result && <span className="sub">{f.result}</span>}</td>
                    <td className="nowrap">
                      {status === 'pendiente'
                        ? <>{fmtDay(f.dueOn)} {f.dueOn < today ? <Badge tone="danger">Vencido</Badge> : f.dueOn === today ? <Badge tone="warn">Hoy</Badge> : null}</>
                        : <>{f.status === 'hecho' ? <Badge tone={OUTCOME[f.outcome]?.tone ?? 'ok'}>{OUTCOME[f.outcome]?.label ?? 'Hecho'}</Badge> : <Badge tone="plain">Descartado</Badge>}<span className="sub">{f.doneAt ? fmtDate(f.doneAt) : ''}</span></>}
                    </td>
                    {!seller && <td className="small">{f.assignedName ?? <span className="muted">Sin asignar</span>}</td>}
                    <td className="nowrap">
                      {status === 'pendiente' ? (
                        <>
                          <button className="btn sm primary" onClick={() => setClosing(f)}>Registrar resultado</button>{' '}
                          <button className="btn sm" onClick={() => window.confirm(`¿Descartar el seguimiento de ${f.customerName}?`) && void patch(f, { status: 'descartado' })}>Descartar</button>
                        </>
                      ) : <button className="btn sm" onClick={() => void patch(f, { status: 'pendiente' })}>Reabrir</button>}
                      {!seller && <>{' '}<button className="btn sm" onClick={() => setOpen(f.phone)}>Ficha</button></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{status === 'pendiente' ? (seller ? 'No tienes seguimientos pendientes.' : 'No hay seguimientos pendientes. Créalos desde «Recompra» o desde la ficha de un cliente.') : 'Nada por aquí todavía.'}</Empty>
        )}
      </div>
      {closing && <ResultModal followup={closing} onClose={() => setClosing(null)} onSaved={async () => { setClosing(null); await refresh(); }} />}
      {open && <CustomerModal phone={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </>
  );
}

function ResultModal({ followup, onClose, onSaved }: { followup: Followup; onClose: () => void; onSaved: () => Promise<void> }) {
  const [outcome, setOutcome] = useState('compro');
  const [result, setResult] = useState('');
  async function save() {
    await api('PATCH', `/api/zeus/followups/${followup.id}`, { status: 'hecho', outcome, result });
    await onSaved();
  }
  return (
    <FormModal title={`${followup.customerName} · ${followup.title}`} submitLabel="Guardar resultado" onClose={onClose} onSubmit={save}>
      <div className="checks" role="radiogroup" aria-label="Qué pasó">
        {Object.entries(OUTCOME).map(([key, o]) => <label key={key}><input type="radio" name="resultado" checked={outcome === key} onChange={() => setOutcome(key)} /> {o.label}</label>)}
      </div>
      <Field label="Detalle (opcional)" hint="Ej.: pide que le escriban la otra semana.">
        <textarea rows={3} maxLength={500} value={result} onChange={(e) => setResult(e.target.value)} />
      </Field>
      {outcome === 'compro' && <p className="small muted">Recuerda crear el pedido en Hermes: Zeus no lo crea por ti.</p>}
    </FormModal>
  );
}
