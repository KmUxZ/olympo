// Lee la primera hoja de un archivo de Excel (.xlsx) y la devuelve como texto separado por tabulaciones,
// igual que si se hubieran copiado y pegado las celdas. Un .xlsx es un ZIP con XML dentro: no hace falta ninguna librería.

interface ZipEntry { name: string; method: number; size: number; offset: number }

function entriesOf(view: DataView): ZipEntry[] {
  // El índice del ZIP está al final del archivo.
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('El archivo no es un Excel válido (.xlsx).');
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const out: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count && view.getUint32(p, true) === 0x02014b50; i++) {
    const nameLen = view.getUint16(p + 28, true);
    out.push({
      name: decoder.decode(new Uint8Array(view.buffer, p + 46, nameLen)),
      method: view.getUint16(p + 10, true),
      size: view.getUint32(p + 20, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return out;
}

async function readEntry(view: DataView, e: ZipEntry): Promise<string> {
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const raw = new Uint8Array(view.buffer as ArrayBuffer, start, e.size);
  if (e.method === 0) return new TextDecoder().decode(raw);
  if (e.method !== 8) throw new Error('El archivo de Excel usa una compresión que no se puede leer.');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

const xml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
const pad = (n: number) => String(n).padStart(2, '0');

/** Excel guarda fechas y horas como números: los días desde 1900 y la hora como fracción del día. */
function numberText(raw: string, isHeader: boolean): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (isHeader && n > 30000 && n < 80000) {
    const d = new Date(Math.round((n - 25569) * 86400_000));
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  if (n > 0 && n < 1) {
    const minutes = Math.round(n * 1440);
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }
  return raw;
}

const columnOf = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export async function xlsxToText(file: Blob): Promise<string> {
  const view = new DataView(await file.arrayBuffer());
  const entries = entriesOf(view);
  const sheet = entries.filter((e) => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  if (!sheet) throw new Error('El archivo de Excel no tiene hojas.');
  const stringsEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const strings = stringsEntry
    ? [...xml(await readEntry(view, stringsEntry)).getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].filter((t) => t.parentElement?.tagName !== 'rPh').map((t) => t.textContent ?? '').join(''))
    : [];

  const lines: string[] = [];
  let first = true;
  for (const row of xml(await readEntry(view, sheet)).getElementsByTagName('row')) {
    const cells: string[] = [];
    let next = 0;
    for (const c of row.getElementsByTagName('c')) {
      const ref = c.getAttribute('r');
      const col = ref ? columnOf(ref) : next;
      next = col + 1;
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      const value = type === 's' ? strings[Number(v)] ?? '' : type === 'inlineStr' ? [...c.getElementsByTagName('t')].map((t) => t.textContent ?? '').join('') : type === 'str' || type === 'b' || type === 'e' ? v : numberText(v, first);
      cells[col] = value.replace(/[\t\r\n]+/g, ' ').trim();
    }
    const line = Array.from(cells, (x) => x ?? '');
    if (line.some(Boolean)) {
      lines.push(line.join('\t'));
      first = false;
    }
  }
  return lines.join('\n');
}

/** Texto de un archivo de hoja de cálculo: .xlsx se convierte; CSV o texto se leen tal cual. */
export async function sheetFileText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xls')) throw new Error('Ese es un Excel antiguo (.xls). Ábrelo y guárdalo como «Libro de Excel (.xlsx)», o copia y pega las celdas.');
  return name.endsWith('.xlsx') || name.endsWith('.xlsm') ? xlsxToText(file) : file.text();
}
