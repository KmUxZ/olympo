// El límite de intentos por IP no se puede evadir falsificando cabeceras. El servidor debe correr en modo producción,
// que es cuando confía en el proxy del hosting. Sin argumentos: no necesita cuentas.
const BASE = 'http://127.0.0.1:4100';
let f = 0;
const bad = async (i, headers) => (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email: `nadie${i}@ejemplo.test`, password: 'x' }) })).status;
/** Hace intentos fallidos con correos distintos y dice en cuál lo bloquearon. El límite por IP es 40. */
const run = async (label, from, make) => {
  let at = 0;
  for (let i = 0; i < 60; i++) if ((await bad(from + i, make(i))) === 429) { at = i + 1; break; }
  const ok = at === 41;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${at ? `bloqueó en el intento ${at}` : 'nunca bloqueó'}`);
  if (!ok) f++;
};
// Como en producción: el proxy añade al final la IP real; lo que va antes lo escribe el atacante.
await run('falsifica el inicio de X-Forwarded-For y el proxy añade la real al final', 1000, (i) => ({ 'x-forwarded-for': `198.51.100.${i}, 203.0.113.9` }));
// Con Cloudflare: su cabecera trae la IP real; un X-Forwarded-For falsificado no cuenta.
await run('con la cabecera de Cloudflare, X-Forwarded-For falsificado no cuenta', 2000, (i) => ({ 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-for': `198.51.100.${i}` }));
await run('un valor de Cloudflare que no es una IP se ignora', 3000, (i) => ({ 'cf-connecting-ip': `basura-${i}`, 'x-forwarded-for': `198.51.100.${i}, 203.0.113.77` }));

const h = (await fetch(BASE + '/api/health')).headers;
const hsts = /max-age=\d+/.test(h.get('strict-transport-security') ?? '');
console.log(`${hsts ? 'OK  ' : 'FAIL'} en producción se envía HSTS`);
if (!hsts) f++;
console.log(f ? `\n${f} FALLARON` : '\nTODO OK');
process.exit(f ? 1 : 0);
