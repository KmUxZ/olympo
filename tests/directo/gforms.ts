// Prueba del conector de formularios de Google. Lee las páginas reales guardadas (sin enviar nada a Google)
// y envía a un Google de mentira en el puerto 4192 (ATHENA_FORMS_URL).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const g = await import('../../apps/server/src/athena/gforms.ts');
const a = await import('../../apps/server/src/athena/address-parts.ts');
let f = 0; const check = (n: string, c: boolean, x: unknown = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n} ${c ? '' : JSON.stringify(x).slice(0, 500)}`); if (!c) f++; };
const fails = (fn: () => unknown, code: string) => { try { fn(); return false; } catch (e) { return (e as { code?: string }).code === code; } };

// Enlaces
check('acepta el enlace corto y el largo', g.isFormUrl('https://forms.gle/AbCdEfGh12345678') && g.isFormUrl('https://docs.google.com/forms/d/e/1FAIpQLSc-FORMULARIO-DE-EJEMPLO-000000000000000000000000/viewform?usp=send_form'));
check('rechaza enlaces que no son formularios de Google', !g.isFormUrl('https://evil.example/forms/d/e/1FAIpQLSc-FORMULARIO-DE-EJEMPLO-00000000/viewform') && !g.isFormUrl('http://forms.gle/AbCdEfGh12345678') && !g.isFormUrl('https://docs.google.com/spreadsheets/d/abc') && !g.isFormUrl('no es un enlace'));

// Lectura de los formularios reales
const pais = g.parseFormHtml('PAIS', readFileSync(dir + 'form-pais.html', 'utf8'));
const ofi = g.parseFormHtml('OFI', readFileSync(dir + 'form-oficina.html', 'utf8'));
check('lee el formulario de País y Bogotá', pais.title === 'VENTAS PAIS Y BOGOTA' && pais.questions.length === 17, [pais.title, pais.questions.length]);
check('lee el formulario de Oficina', ofi.title === 'VENTAS OFICINA' && ofi.questions.length === 10, [ofi.title, ofi.questions.length]);
const rp = g.mapRoles(pais), ro = g.mapRoles(ofi);
const need = ['vendedor', 'tipoVenta', 'pagina', 'nombre', 'viaTipo', 'viaNumero', 'numeral', 'placa1', 'guion', 'placa2', 'barrio', 'ciudad', 'celular1', 'celular2', 'valor', 'pedido', 'producto'];
check('País: reconoce las 17 preguntas, incluidas las dos sin título', need.every((r) => (rp as any)[r]) && Object.keys(rp).length === 17 && rp.placa1!.entry === '820046072' && rp.placa2!.entry === '83375407', Object.keys(rp));
check('Oficina: reconoce las 10 preguntas', ['vendedor', 'nombre', 'direccionOficina', 'pagina', 'ciudad', 'producto', 'celular1', 'celular2', 'valor', 'pedido'].every((r) => (ro as any)[r]) && Object.keys(ro).length === 10, Object.keys(ro));
check('opciones sin importar mayúsculas ni tildes', g.pickOption(rp.pagina!, 'TIENDA 1') === 'Tienda 1' && g.pickOption(ro.pagina!, 'tienda 1') === 'TIENDA 1' && g.pickOption(rp.vendedor!, 'asesora numero 6') === 'Asesora Número 6' && g.pickOption(rp.pagina!, 'No existe') === null);

// Armar la respuesta
const good = { vendedor: 'asesora numero 4', tipoVenta: 'país', pagina: 'tienda 35', nombre: 'Laura Gómez', viaTipo: 'KR', viaNumero: '15', placa1: '20', placa2: '19', barrio: 'Remanso', ciudad: 'VILLAVICENCIO-META', celular1: '3001234567', valor: '97800', pedido: '2 buzos talla L', producto: 'promo buzos' };
const ans = g.buildAnswers(pais, good);
check('arma la respuesta con cada dato en su casilla', ans['entry.1026698853'] === 'KR' && ans['entry.1777544353'] === '15' && ans['entry.2103579609'] === '#' && ans['entry.820046072'] === '20' && ans['entry.1162553361'] === '-' && ans['entry.83375407'] === '19' && ans['entry.372852446'] === 'País' && ans['entry.1888450940'] === 'Tienda 35' && ans['entry.1141661275'] === 'Promo buzos' && !('entry.2114539845' in ans), ans);
check('falta un dato obligatorio → no arma', fails(() => g.buildAnswers(pais, { ...good, barrio: '' }), 'falta_dato'));
check('una opción que no existe en la lista → no arma', fails(() => g.buildAnswers(pais, { ...good, vendedor: 'Athena' }), 'opcion_no_existe') && fails(() => g.buildAnswers(pais, { ...good, viaTipo: 'CALLE' }), 'opcion_no_existe'));
const changed = { ...pais, questions: [...pais.questions, { entry: '999', title: 'Pregunta nueva', kind: 'texto', required: true, options: [] }] };
check('si agregan una pregunta obligatoria, se detiene', fails(() => g.buildAnswers(changed, good), 'formulario_cambio'));
check('una pregunta nueva opcional no estorba', Object.keys(g.buildAnswers({ ...pais, questions: [...pais.questions, { entry: '998', title: 'Nota', kind: 'texto', required: false, options: [] }] }, good)).length === Object.keys(ans).length);
const ao = g.buildAnswers(ofi, { vendedor: 'asesora numero 4', nombre: 'Laura', direccionOficina: 'Oficina principal Interrapidísimo', pagina: 'tienda 35', ciudad: 'GRANADA-META', producto: 'tenis', celular1: '3001234567', valor: '120000', pedido: '1 tenis talla 40' });
check('arma la de Oficina', ao['entry.1984856248'] === 'Oficina principal Interrapidísimo' && ao['entry.213284690'] === 'TENIS' && Object.keys(ao).length === 9, ao);

// Envío a un Google de mentira
let got: { path: string; body: URLSearchParams } | null = null; let status = 200;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/forms/d/e/PAIS/viewform') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(readFileSync(dir + 'form-pais.html', 'utf8')); }
    if (req.method === 'GET' && req.url === '/forms/d/e/PRIVADO/viewform') { res.writeHead(302, { location: 'https://accounts.google.com/ServiceLogin' }); return res.end(); }
    if (req.method === 'POST' && req.url === '/forms/d/e/PAIS/formResponse') { got = { path: req.url, body: new URLSearchParams(body) }; res.writeHead(status); return res.end('ok'); }
    res.writeHead(404); res.end();
  });
});
await new Promise<void>((r) => mock.listen(4192, '127.0.0.1', r));
const live = await g.readForm('PAIS');
check('lee el formulario por la red', live.questions.length === 17);
await g.submitForm('PAIS', g.buildAnswers(live, good));
check('envía la respuesta con los nombres de casilla de Google', got !== null && got!.body.get('entry.1462057033') === 'Laura Gómez' && got!.body.get('entry.1945381881') === '97800' && got!.body.get('entry.169647275') === 'VILLAVICENCIO-META', got && Object.fromEntries(got!.body));
status = 400;
check('si Google rechaza, falla con motivo', await g.submitForm('PAIS', ans).then(() => false, (e: any) => e.code === 'rechazado'));
check('un formulario que pide sesión se detecta', await g.readForm('PRIVADO').then(() => false, (e: any) => e.code === 'pide_sesion'));
check('un formulario que no existe se detecta', await g.readForm('NADA').then(() => false, (e: any) => e.code === 'no_disponible'));
mock.close();

// Separar la dirección
const sp = (t: string) => { const p = a.splitAddress(t); return p ? `${a.joinAddress(p)}|${p.resto}` : null; };
const cases: [string, string | null][] = [
  ['Carrera 15 # 20-19', 'KR 15 # 20 - 19|'],
  ['carrera55b#183-36', 'KR 55B # 183 - 36|'],
  ['Cll 48 No 50 BW - 62 rincón de la paz casa 193', 'CL 48 # 50BW - 62|rincón de la paz casa 193'],
  ['calle 29 # 83A-60 torre 6 apto 306', 'CL 29 # 83A - 60|torre 6 apto 306'],
  ['Cra 7 45 10 apto 301', 'KR 7 # 45 - 10|apto 301'],
  ['Diagonal 12 sur # 3-45', 'DG 12 SUR # 3 - 45|'],
  ['Transversal 5 bis # 8a - 12', 'TV 5 BIS # 8A - 12|'],
  ['Av. 68 # 22-10', 'AV 68 # 22 - 10|'],
  ['Manzana 7 casa 8 barrio La Madrid', 'MZ 7 # CASA - 8|barrio La Madrid'],
  ['mz L lote 22', 'MZ L # LOTE - 22|'],
  ['por la iglesia, casa verde', null],
  ['Carrera 15', null],
  ['', null],
];
for (const [input, expected] of cases) check(`dirección: ${input || '(vacía)'}`, sp(input) === expected, sp(input));
console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
process.exit(f ? 1 : 0);
