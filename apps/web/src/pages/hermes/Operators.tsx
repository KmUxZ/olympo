// Hermes · operadores logísticos: las plataformas por las que salen los pedidos (cada una genera sus guías)
// y la subida de guías en lote desde el archivo que entrega el operador.
import { useState } from 'react';
import { useAuth } from '../../auth';
import { api, useApi } from '../../lib/api';
import { downloadCsv } from '../../lib/format';
import { sheetFileText } from '../../lib/xlsx';
import { Badge, Empty, ErrorNote, Field, FormModal, Loading, Modal } from '../../components/ui';
import { parseColumns } from './Import';

export interface Operator { id: string; name: string; carrier: string; driver: string; active: boolean; toDispatch: number; onTheWay: number }
export interface OperatorList { operators: Operator[]; unassignedToDispatch: number }

/** Tarjeta del panel: qué operadores hay y cuántos pedidos tiene cada uno. Solo el administrador los edita. */
export function OperatorsCard() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const list = useApi<OperatorList>('/api/hermes/operators');
  const [editing, setEditing] = useState<Operator | 'nuevo' | null>(null);
  const rows = list.data?.operators ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Operadores logísticos</h2>
          <span className="xs muted">Las plataformas por las que despachas. La persona encargada elige el operador de cada pedido en «Pedidos».</span>
        </div>
        {isAdmin && <button className="btn sm" onClick={() => setEditing('nuevo')}>Añadir operador</button>}
      </div>
      <ErrorNote error={list.error} />
      {!list.data ? <Loading /> : rows.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Operador</th><th>Transportadora</th><th>Guías</th><th>Por despachar</th><th>En camino</th><th></th></tr></thead>
            <tbody>
              {rows.map((op) => (
                <tr key={op.id}>
                  <td><strong>{op.name}</strong>{!op.active && <> <Badge tone="plain">Desactivado</Badge></>}</td>
                  <td>{op.carrier || '—'}</td>
                  <td className="small">Por archivo o a mano</td>
                  <td>{op.toDispatch}</td>
                  <td>{op.onTheWay}</td>
                  <td>{isAdmin && <button className="btn sm" onClick={() => setEditing(op)}>Editar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>{isAdmin ? 'Aún no hay operadores. Añade las plataformas por las que despachas para saber por cuál sale cada pedido.' : 'Aún no hay operadores. El administrador los añade aquí.'}</Empty>}
      {list.data && list.data.unassignedToDispatch > 0 && rows.length > 0 && (
        <p className="card-pad small muted" style={{ margin: 0 }}>{list.data.unassignedToDispatch} pedido(s) por despachar todavía sin operador.</p>
      )}
      {editing && <OperatorModal operator={editing === 'nuevo' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await list.reload(); }} />}
    </div>
  );
}

function OperatorModal({ operator, onClose, onSaved }: { operator: Operator | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(operator?.name ?? '');
  const [carrier, setCarrier] = useState(operator?.carrier ?? '');
  const [active, setActive] = useState(operator?.active ?? true);
  async function save() {
    await api(operator ? 'PATCH' : 'POST', operator ? `/api/hermes/operators/${operator.id}` : '/api/hermes/operators', { name: name.trim(), carrier: carrier.trim(), active });
    await onSaved();
  }
  return (
    <FormModal title={operator ? `Editar ${operator.name}` : 'Añadir operador logístico'} onClose={onClose} onSubmit={save}>
      <Field label="Nombre" hint="Como lo conoce tu equipo. Ej.: el nombre de la plataforma donde generas las guías."><input required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Transportadora (opcional)" hint="Con cuál despacha. Es el nombre que el cliente ve en el aviso de la guía."><input maxLength={60} value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Ej.: Interrapidísimo" /></Field>
      {operator && <div className="checks"><label><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo (se puede elegir en pedidos nuevos)</label></div>}
    </FormModal>
  );
}

// ───────── Guías en lote ─────────
type Row = Record<string, string>;
interface GuidePreview { index: number; ok: boolean; phone: string; trackingNumber: string; customerName: string; code: string | null; detail: string; carrier: string }

const GUIDE_COLUMNS: Record<string, string[]> = {
  phone: ['telefono', 'celular', 'whatsapp', 'tel', 'movil', 'telefono destinatario', 'celular destinatario', 'telefono cliente', 'telefono del cliente'],
  trackingNumber: ['guia', 'numero de guia', 'numero guia', 'no guia', 'n guia', 'guia transportadora', 'tracking', 'numero de rastreo', 'rastreo'],
  operatorRef: ['pedido', 'numero de pedido', 'id', 'id pedido', 'orden', 'numero de orden', 'referencia', 'ref'],
  carrier: ['transportadora', 'empresa de envio', 'operador de transporte'],
  customerName: ['nombre', 'cliente', 'destinatario', 'nombre cliente', 'nombre del cliente', 'nombre destinatario'],
};

/** Sube el archivo de guías de un operador: cruza cada fila con un pedido confirmado por el teléfono y lo despacha. */
export function GuidesModal({ operators, onClose, onDone }: { operators: Operator[]; onClose: () => void; onDone: () => void }) {
  const active = operators.filter((op) => op.active);
  const [operatorId, setOperatorId] = useState(active.length === 1 ? active[0].id : '');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [preview, setPreview] = useState<{ total: number; valid: number; rows: GuidePreview[] } | null>(null);
  const [result, setResult] = useState<{ dispatched: { index: number; code: string }[]; skipped: { index: number; phone: string; code: string | null; detail: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operator = active.find((op) => op.id === operatorId);

  async function review(source = text) {
    setError(null);
    if (!operatorId) return setError('Elige primero de qué operador son las guías.');
    const parsed = parseColumns(source, GUIDE_COLUMNS, ['phone', 'trackingNumber'], 2);
    const clean = parsed.rows.filter((r) => (r.phone ?? '').trim() || (r.trackingNumber ?? '').trim());
    if (!clean.length) return setError('No hay filas para revisar. Pega las filas desde Excel o elige el archivo del operador.');
    if (clean.length > 500) return setError(`Son ${clean.length} filas; el máximo por lote es 500. Divide el archivo.`);
    setBusy(true);
    try {
      setRows(clean);
      setPreview(await api('POST', '/api/hermes/guides/preview', { operatorId, rows: clean }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadFile(file: File | undefined) {
    if (!file) return;
    try {
      const content = await sheetFileText(file);
      setText(content);
      await review(content);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api('POST', '/api/hermes/guides', { operatorId, rows }));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const template = () => downloadCsv('plantilla-guias-hermes.csv', ['Teléfono', 'Guía', 'Pedido', 'Transportadora'], [['3001234567', '240012345678', '', '']]);

  return (
    <Modal title="Subir guías en lote" onClose={onClose} wide>
      <div className="modal-body">
        <ErrorNote error={error} />
        {result ? (
          <>
            <div className={`alert ${result.dispatched.length ? 'ok' : 'warn'}`} role="status">
              <strong>{result.dispatched.length} pedido(s) despachados.</strong> {result.dispatched.length > 0 && 'Hermes ya le envía la guía a cada cliente.'}
              {result.skipped.length > 0 && ` ${result.skipped.length} fila(s) se omitieron.`}
            </div>
            {result.skipped.length > 0 && (
              <table>
                <thead><tr><th>Fila</th><th>Teléfono</th><th>Pedido</th><th>Por qué no se despachó</th></tr></thead>
                <tbody>{result.skipped.map((s) => <tr key={s.index}><td>{s.index + 1}</td><td>{s.phone || '—'}</td><td>{s.code ?? '—'}</td><td>{s.detail}</td></tr>)}</tbody>
              </table>
            )}
            <div className="actions"><button className="btn primary" onClick={onClose}>Listo</button></div>
          </>
        ) : !preview ? (
          <>
            <Field label="Operador logístico" hint="De qué plataforma descargaste este archivo.">
              <select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
                <option value="">Elegir…</option>
                {active.map((op) => <option key={op.id} value={op.id}>{op.name}</option>)}
              </select>
            </Field>
            <p className="small muted">
              Pega las filas del archivo de guías o súbelo tal como lo descargas. Hacen falta dos columnas: <strong>Teléfono</strong> del cliente y <strong>Guía</strong>.
              Opcionales: Pedido (el número en el operador) y Transportadora. Cada guía se cruza con el pedido confirmado de ese teléfono.
            </p>
            <textarea aria-label="Filas de guías" value={text} onChange={(e) => setText(e.target.value)} placeholder={'Teléfono\tGuía\n3001234567\t240012345678'} className="mono" style={{ minHeight: 170 }} />
            <div className="actions">
              <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void review()}>{busy ? 'Revisando…' : 'Revisar antes de despachar'}</button>
              <label className="btn" style={{ cursor: 'pointer' }}>
                Elegir archivo
                <input type="file" accept=".xlsx,.xlsm,.csv,.txt,.tsv,text/csv,text/plain" className="sr-only" onChange={(e) => void loadFile(e.target.files?.[0])} />
              </label>
              <button className="btn ghost" onClick={template}>Descargar plantilla</button>
            </div>
            <p className="xs muted">Nada se despacha todavía: primero verás qué guías encontraron su pedido. Máximo 500 filas por lote.</p>
          </>
        ) : (
          <>
            <div className="row">
              <div className="grow">
                <strong style={{ fontSize: 'var(--text-lg)' }}>{preview.valid} de {preview.total} guías encontraron su pedido</strong>
                <div className="small muted">Al despachar, cada cliente recibe su número de guía{operator ? ` y el pedido queda con ${operator.name}` : ''}. Las demás filas no cambian nada.</div>
              </div>
              <div className="actions">
                <button className="btn" disabled={busy} onClick={() => setPreview(null)}>Volver a editar</button>
                <button className="btn primary" disabled={busy || preview.valid === 0} onClick={() => void run()}>{busy ? 'Despachando…' : `Despachar ${preview.valid} pedido(s)`}</button>
              </div>
            </div>
            <div className="table-wrap" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              <table>
                <thead><tr><th>Fila</th><th>Teléfono</th><th>Guía</th><th>Pedido</th><th>Resultado</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.index}>
                      <td>{r.index + 1}</td>
                      <td>{r.phone || '—'}<span className="sub">{r.customerName}</span></td>
                      <td><span className="mono">{r.trackingNumber || '—'}</span><span className="sub">{r.carrier}</span></td>
                      <td>{r.code ?? '—'}</td>
                      <td style={{ maxWidth: 380 }}>{r.ok ? <Badge tone="ok">Lista</Badge> : <><Badge tone="danger">No se despacha</Badge><div className="small muted">{r.detail}</div></>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
