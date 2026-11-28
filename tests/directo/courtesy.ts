const { isCourtesy } = await import('../../apps/server/src/hermes/bot.ts');
let f = 0;
const yes = ['Gracias', 'Ok perfecto! Gracias', 'Listo', 'muchas gracias 🙏', '👍', 'Vale, quedo atenta', 'Dios le bendiga', 'ok ok', 'Sí señor, gracias', 'Bueno'];
const no = ['Gracias, pero cuándo llega?', 'ok pero cambie la dirección', 'ya no lo quiero', 'Hola', '[Archivo adjunto]', '', 'a qué hora pasan', 'gracias mi número es 3001234567', 'no'];
for (const t of yes) if (!isCourtesy(t)) { console.log('FAIL debería ser cortesía:', t); f++; }
for (const t of no) if (isCourtesy(t)) { console.log('FAIL no es cortesía:', t); f++; }
console.log(f ? `${f} FALLARON` : 'TODO OK');
process.exit(0);
