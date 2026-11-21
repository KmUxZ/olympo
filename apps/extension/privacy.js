// Muestra a la persona, tal cual, lo que la extensión tiene guardado localmente.
const { state, buckets = {} } = await chrome.storage.local.get(['state', 'buckets']);

function cell(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}
function table(headers, rows) {
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  for (const h of headers) head.append(cell('th', h));
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of r) tr.append(cell('td', String(c)));
  }
  return t;
}

const tools = state?.tools ?? [];
if (tools.length) document.getElementById('tools').replaceChildren(table(['Herramienta', 'Sitios'], tools.map((t) => [t.name, t.hosts.join(', ')])));
else document.getElementById('tools').textContent = 'Inicia sesión para ver las herramientas autorizadas.';

const names = new Map(tools.map((t) => [t.id, t.name]));
const rows = [];
for (const minute of Object.keys(buckets).sort()) {
  const b = buckets[minute];
  const hora = new Date(minute).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const entries = Object.entries(b.tools ?? {});
  if (!entries.length) rows.push([hora, '—', 0, 0, 0, 0, 0]);
  for (const [id, v] of entries) rows.push([hora, names.get(id) ?? 'Herramienta', v.focusSeconds, v.activeSeconds, v.keys, v.clicks, v.scrolls]);
}
if (rows.length) document.getElementById('pending').replaceChildren(table(['Minuto', 'Herramienta', 'Seg. en uso', 'Seg. activos', 'Teclas (n.º)', 'Clics (n.º)', 'Desplaz. (n.º)'], rows));
else document.getElementById('pending').textContent = 'No hay datos pendientes.';
