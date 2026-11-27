// Hermes · descargar los pedidos confirmados en el formato de carga masiva de Hoko.
import { useEffect, useState } from 'react';
import { api, useApi } from '../../lib/api';
import { ErrorNote, Field, Loading, Modal } from '../../components/ui';

interface Config { carrier: string; stockId: number; height: number; width: number; length: number; weight: number; declaredValue: number; deliveryDays: number; paidLabel: string }
interface Preview { config: Config | null; assigned: number; unassigned: number; already: number; paid: number; noDepartment: { code: string; city: string }[] }
const EMPTY = { carrier: '', stockId: '', height: '10', width: '10', length: '5', weight: '1', declaredValue: '', deliveryDays: '3', paidLabel: '' };

/** Entrega al navegador un archivo recibido del servidor. */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function ExportModal({ operators, onClose, onDone }: { operators: { id: string; name: string; active: boolean }[]; onClose: () => void; onDone: (message: string) => void }) {
  const active = operators.filter((op) => op.active);
  const [operatorId, setOperatorId] = useState(active[0]?.id ?? '');
  const preview = useApi<Preview>(operatorId ? `/api/hermes/export?operatorId=${operatorId}` : null);
  const [f, setF] = useState(EMPTY);
  const [editing, setEditing] = useState(false);
  const [includeUnassigned, setIncludeUnassigned] = useState(false);
  const [again, setAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;

  useEffect(() => {
    if (!p) return;
    const c = p.config;
    setF(c ? { carrier: c.carrier, stockId: String(c.stockId), height: String(c.height), width: String(c.width), length: String(c.length), weight: String(c.weight), declaredValue: c.declaredValue ? String(c.declaredValue) : '', deliveryDays: String(c.deliveryDays), paidLabel: c.paidLabel } : EMPTY);
    setEditing(!c);
  }, [p]);

  // Sin plantilla guardada siempre se muestra el formulario.
  const showForm = editing || !p?.config;
  const total = p ? p.assigned + (includeUnassigned ? p.unassigned : 0) + (again ? p.already : 0) : 0;
  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });

  async function download() {
    setBusy(true);
    setError(null);
    try {
      if (showForm) await api('PUT', `/api/hermes/operators/${operatorId}/export-config`, { ...f, declaredValue: f.declaredValue || 0 });
      const res = await fetch('/api/hermes/export', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operatorId, includeUnassigned, again }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? 'No se pudo generar el archivo.');
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'carga-hoko.xlsx';
      saveBlob(await res.blob(), name);
      onDone(`Se descargaron ${res.headers.get('x-hermes-count') ?? total} pedido(s) en «${name}». Súbelo a Hoko para generar las guías.`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      await preview.reload();
    }
  }

  return (
    <Modal
      title="Descargar para Hoko"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || !p || total === 0 || (showForm && (!f.carrier.trim() || !f.stockId.trim()))} onClick={() => void download()}>{busy ? 'Generando…' : `Descargar ${total || ''} pedido${total === 1 ? '' : 's'}`}</button>
      </>}
    >
      <div className="modal-body">
        <p className="small muted">Baja los pedidos que el cliente ya confirmó, en el formato de carga masiva de Hoko. Lo subes allá, generas las guías y Hermes las recibe solo.</p>
        <Field label="Operador">
          <select value={operatorId} onChange={(e) => { setOperatorId(e.target.value); setIncludeUnassigned(false); setAgain(false); }}>
            {active.map((op) => <option key={op.id} value={op.id}>{op.name}</option>)}
          </select>
        </Field>
        {!p ? (preview.error ? <ErrorNote error={preview.error} /> : <Loading />) : (
          <>
            <div className="card card-pad" style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
              <div><strong style={{ fontSize: 'var(--text-lg)' }}>{total}</strong> pedido{total === 1 ? '' : 's'} en el archivo</div>
              <span className="small muted">{p.assigned} confirmado{p.assigned === 1 ? '' : 's'} de este operador, sin descargar todavía.</span>
              {p.unassigned > 0 && <label className="row small"><input type="checkbox" checked={includeUnassigned} onChange={(e) => setIncludeUnassigned(e.target.checked)} /> Incluir {p.unassigned} confirmado{p.unassigned === 1 ? '' : 's'} sin operador (quedan asignados a este)</label>}
              {p.already > 0 && <label className="row small"><input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} /> Volver a incluir {p.already} que ya se descargaron y siguen sin guía</label>}
              {again && <span className="xs" style={{ color: 'var(--color-warn)' }}>Si ya los subiste a Hoko, subirlos otra vez crea órdenes repetidas.</span>}
              {p.noDepartment.length > 0 && <span className="xs" style={{ color: 'var(--color-warn)' }}>Sin departamento reconocido, revísalos en el archivo: {p.noDepartment.slice(0, 8).map((o) => `${o.code} · ${o.city}`).join('; ')}{p.noDepartment.length > 8 ? '…' : ''}</span>}
            </div>

            {showForm ? (
              <>
                <strong>Datos fijos de la plantilla</strong>
                <p className="xs muted">Son los mismos para todos los pedidos del archivo. Se guardan para la próxima vez.</p>
                <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div className="grow"><Field label="Transportadora" hint="Tal como aparece en Hoko. Ej.: HOKO ENVIOS NACIONAL"><input maxLength={80} value={f.carrier} onChange={set('carrier')} /></Field></div>
                  <div className="grow"><Field label="ID del stock" hint="El producto de Hoko con el que cargas las órdenes"><input inputMode="numeric" value={f.stockId} onChange={set('stockId')} /></Field></div>
                </div>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <Field label="Alto"><input inputMode="decimal" style={{ width: 80 }} value={f.height} onChange={set('height')} /></Field>
                  <Field label="Ancho"><input inputMode="decimal" style={{ width: 80 }} value={f.width} onChange={set('width')} /></Field>
                  <Field label="Largo"><input inputMode="decimal" style={{ width: 80 }} value={f.length} onChange={set('length')} /></Field>
                  <Field label="Peso"><input inputMode="decimal" style={{ width: 80 }} value={f.weight} onChange={set('weight')} /></Field>
                  <Field label="Días para la entrega"><input inputMode="numeric" style={{ width: 80 }} value={f.deliveryDays} onChange={set('deliveryDays')} /></Field>
                </div>
                <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div className="grow"><Field label="Valor declarado (opcional)"><input inputMode="numeric" value={f.declaredValue} onChange={set('declaredValue')} /></Field></div>
                  <div className="grow"><Field label="Forma de pago si ya pagó" hint="Como la escribes en Hoko. Los contraentrega salen como RECAUDO."><input maxLength={40} value={f.paidLabel} onChange={set('paidLabel')} /></Field></div>
                </div>
              </>
            ) : (
              <div className="row small" style={{ flexWrap: 'wrap' }}>
                <span className="muted grow">{p.config!.carrier} · stock {p.config!.stockId} · {p.config!.height}×{p.config!.width}×{p.config!.length} cm · {p.config!.weight} kg{p.config!.declaredValue ? ` · declarado $${p.config!.declaredValue.toLocaleString('es-CO')}` : ''}</span>
                <button className="btn sm" onClick={() => setEditing(true)}>Cambiar datos</button>
              </div>
            )}
            {p.paid > 0 && !f.paidLabel.trim() && <div className="alert warn" role="status">Hay {p.paid} pedido(s) ya pagado(s). Indica cómo se escribe esa forma de pago en Hoko para poder descargarlos.</div>}
          </>
        )}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
