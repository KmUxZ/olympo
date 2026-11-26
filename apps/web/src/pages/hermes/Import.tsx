// Hermes · importación de pedidos en lote: pegar desde Excel o subir un CSV, revisar y crear.
import { sheetFileText } from '../../lib/xlsx';
import { useState } from 'react';
import { api } from '../../lib/api';
import { downloadCsv } from '../../lib/format';
import { Badge, ErrorNote, Modal } from '../../components/ui';

type Row = Record<string, string>;
interface PreviewRow { index: number; ok: boolean; errors: string[]; warnings: string[]; customerName: string; phone: string; city: string; address: string }

// Nombres de columna aceptados (sin tildes ni mayúsculas) → campo del pedido.
const COLUMNS: Record<string, string[]> = {
  customerName: ['nombre', 'cliente', 'nombre cliente', 'nombre del cliente', 'destinatario'],
  phone: ['telefono', 'celular', 'whatsapp', 'tel', 'numero', 'movil'],
  address: ['direccion', 'direccion completa', 'domicilio'],
  neighborhood: ['barrio'],
  city: ['ciudad', 'municipio'],
  products: ['productos', 'producto', 'pedido', 'articulos', 'descripcion'],
  total: ['valor', 'total', 'valor total', 'valor a cobrar', 'precio', 'recaudo'],
  payment: ['pago', 'forma de pago', 'metodo de pago'],
  notes: ['indicaciones', 'notas', 'observaciones'],
  seller: ['vendedora', 'vendedor', 'asesora', 'asesor'],
  externalRef: ['referencia', 'ref', 'id', 'numero de pedido'],
};
const DEFAULT_ORDER = ['customerName', 'phone', 'address', 'neighborhood', 'city', 'products', 'total'];
const HEADERS = ['Nombre', 'Teléfono', 'Dirección', 'Barrio', 'Ciudad', 'Productos', 'Valor', 'Pago', 'Indicaciones', 'Vendedora', 'Referencia'];
const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim();

/** Separa una línea respetando comillas (formato CSV). */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Convierte lo pegado (Excel usa tabulaciones; un CSV, comas o punto y coma) en filas con campos del pedido. */
export function parseSheet(text: string): { rows: Row[]; usedHeader: boolean } {
  return parseColumns(text, COLUMNS, DEFAULT_ORDER, 3);
}

/** Lo mismo para cualquier hoja: `columns` dice qué títulos corresponden a cada campo. */
export function parseColumns(text: string, columns: Record<string, string[]>, defaultOrder: string[], minHeaders: number): { rows: Row[]; usedHeader: boolean } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], usedHeader: false };
  const sep = lines[0].includes('\t') ? '\t' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ',');
  const first = splitLine(lines[0], sep);
  const mapped = first.map((h) => Object.keys(columns).find((k) => columns[k].includes(plain(h))) ?? null);
  const usedHeader = mapped.filter(Boolean).length >= minHeaders;
  const fields = usedHeader ? mapped : defaultOrder;
  const rows = lines.slice(usedHeader ? 1 : 0).map((line) => {
    const cells = splitLine(line, sep);
    const row: Row = {};
    fields.forEach((f, i) => { if (f && cells[i] !== undefined) row[f] = cells[i]; });
    return row;
  });
  return { rows, usedHeader };
}

export function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [preview, setPreview] = useState<{ total: number; valid: number; rows: PreviewRow[] } | null>(null);
  const [result, setResult] = useState<{ created: { index: number; code: string }[]; skipped: { index: number; customerName: string; errors: string[] }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review(source = text) {
    setError(null);
    const parsed = parseSheet(source);
    if (!parsed.rows.length) return setError('No hay filas para revisar. Pega las filas desde Excel o elige un archivo.');
    if (parsed.rows.length > 300) return setError(`Son ${parsed.rows.length} filas; el máximo por lote es 300. Divide el archivo.`);
    setBusy(true);
    try {
      setRows(parsed.rows);
      setPreview(await api('POST', '/api/hermes/import/preview', { rows: parsed.rows }));
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
      setResult(await api('POST', '/api/hermes/import', { rows }));
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const template = () => downloadCsv('plantilla-pedidos-hermes.csv', HEADERS, [['Laura Gómez', '3001234567', 'Calle 10 # 5-20 apto 201', 'Centro', 'Cali', '2 fajas talla M y 1 crema', 120000, 'Contraentrega', 'Portería', '', '']]);

  return (
    <Modal title="Importar pedidos en lote" onClose={onClose} wide>
      <div className="modal-body">
        <ErrorNote error={error} />

        {result ? (
          <>
            <div className={`alert ${result.created.length ? 'ok' : 'warn'}`} role="status">
              <strong>{result.created.length} pedido(s) creados.</strong> {result.created.length > 0 && 'Hermes ya le pidió la confirmación a cada cliente.'}
              {result.skipped.length > 0 && ` ${result.skipped.length} fila(s) se omitieron.`}
            </div>
            {result.skipped.length > 0 && (
              <table>
                <thead><tr><th>Fila</th><th>Cliente</th><th>Por qué no se creó</th></tr></thead>
                <tbody>{result.skipped.map((s) => <tr key={s.index}><td>{s.index + 1}</td><td>{s.customerName || '—'}</td><td>{s.errors.join(' ')}</td></tr>)}</tbody>
              </table>
            )}
            <div className="actions"><button className="btn primary" onClick={onClose}>Listo</button></div>
          </>
        ) : !preview ? (
          <>
            <p className="small muted">
              Copia las filas en Excel o Google Sheets y pégalas aquí, o sube un archivo CSV. Columnas: <strong>Nombre, Teléfono, Dirección, Barrio, Ciudad, Productos, Valor</strong>,
              y opcionales Pago, Indicaciones, Vendedora y Referencia. Si incluyes la fila de títulos, el orden no importa.
            </p>
            <textarea aria-label="Filas a importar" value={text} onChange={(e) => setText(e.target.value)} placeholder={'Nombre\tTeléfono\tDirección\tBarrio\tCiudad\tProductos\tValor\nLaura Gómez\t3001234567\tCalle 10 # 5-20\tCentro\tCali\t2 fajas talla M\t120000'} className="mono" style={{ minHeight: 190 }} />
            <div className="actions">
              <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void review()}>{busy ? 'Revisando…' : 'Revisar antes de importar'}</button>
              <label className="btn" style={{ cursor: 'pointer' }}>
                Elegir archivo CSV
                <input type="file" accept=".xlsx,.xlsm,.xls,.csv,.txt,.tsv,text/csv,text/plain" className="sr-only" onChange={(e) => void loadFile(e.target.files?.[0])} />
              </label>
              <button className="btn ghost" onClick={template}>Descargar plantilla</button>
            </div>
            <p className="xs muted">Nada se crea todavía: primero verás qué filas están listas y cuáles tienen problemas. Máximo 300 filas por lote.</p>
          </>
        ) : (
          <>
            <div className="row">
              <div className="grow">
                <strong style={{ fontSize: 'var(--text-lg)' }}>{preview.valid} de {preview.total} filas listas para crear</strong>
                <div className="small muted">Las que tienen problemas no se crearán; puedes corregirlas en tu hoja y volver a importarlas.</div>
              </div>
              <div className="actions">
                <button className="btn" disabled={busy} onClick={() => setPreview(null)}>Volver a editar</button>
                <button className="btn primary" disabled={busy || preview.valid === 0} onClick={() => void run()}>{busy ? 'Creando…' : `Crear ${preview.valid} pedido(s)`}</button>
              </div>
            </div>
            <div className="table-wrap" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              <table>
                <thead><tr><th>Fila</th><th>Cliente</th><th>Dirección</th><th>Resultado</th><th>Detalle</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.index}>
                      <td>{r.index + 1}</td>
                      <td>{r.customerName || '—'}<span className="sub">{r.phone}</span></td>
                      <td style={{ maxWidth: 260 }}>{r.address || '—'}<span className="sub">{r.city}</span></td>
                      <td>{r.ok ? (r.warnings.length ? <Badge tone="warn">Lista, con avisos</Badge> : <Badge tone="ok">Lista</Badge>) : <Badge tone="danger">No se puede crear</Badge>}</td>
                      <td style={{ maxWidth: 380 }}>
                        {r.errors.map((e, i) => <div key={`e${i}`} style={{ color: 'var(--color-danger)' }}>{e}</div>)}
                        {r.warnings.map((w, i) => <div key={`w${i}`} className="muted">{w}</div>)}
                      </td>
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
