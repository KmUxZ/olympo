// Athena · separa una dirección colombiana en las casillas del formulario de ventas:
// tipo de vía · número de vía · # · número · - · número, y lo demás (apartamento, torre, referencia) aparte.
// Si no se puede separar con seguridad devuelve null: no se adivina, se le pregunta al cliente.

export interface AddressParts { viaTipo: string; viaNumero: string; placa1: string; placa2: string; resto: string }

/** Cómo escribe la gente cada tipo de vía → la sigla del formulario. El orden importa: primero las formas largas. */
const VIAS: [RegExp, string][] = [
  [/^(avenida\s+calle|av\.?\s+calle|ac)\b\.?/i, 'AV'],
  [/^(avenida\s+carrera|av\.?\s+carrera|ak)\b\.?/i, 'AV'],
  [/^(calle|cll|cl)\b\.?/i, 'CL'],
  [/^(carrera|cra|kra|kr|cr)\b\.?/i, 'KR'],
  [/^(diagonal|diag|dg)\b\.?/i, 'DG'],
  [/^(transversal|transv|trv|tv)\b\.?/i, 'TV'],
  [/^(circular|circ|cq)\b\.?/i, 'CQ'],
  [/^(circunvalar|cv)\b\.?/i, 'CV'],
  [/^(avenida|avda|av)\b\.?/i, 'AV'],
  [/^(autopista|aut|au)\b\.?/i, 'AU'],
  [/^(carretera|ct)\b\.?/i, 'CT'],
  [/^(kil[oó]metro|km)\b\.?/i, 'KM'],
  [/^(camino|cm)\b\.?/i, 'CM'],
];
// El número puede llevar letras (55B, 50BW), pero «No» o «Nro» después del número es la palabra «número», no una letra.
const NUM = String.raw`\d{1,3}(?:\s?(?!n[o°º]\b|nro\b|numero\b|número\b)[a-z]{1,2}\b)?(?:\s?bis)?(?:\s?(?:sur|norte|este|oeste))?`;
const PLATE = new RegExp(String.raw`^\s*(${NUM})\s*(?:#|n[o°º]\.?|numero|número|nro\.?)?\s*(${NUM})\s*[-–—\s]\s*(\d{1,3})\b\s*(.*)$`, 'i');
const BLOCK = /^(?:manzana|mza|mz)\b\.?\s*([a-z0-9]{1,4})\s*[,#-]?\s*(casa|cs|lote|lt)\b\.?\s*#?\s*([a-z0-9]{1,4})\b\s*(.*)$/i;
const tidy = (n: string) => n.replace(/\s+/g, ' ').trim().toUpperCase().replace(/^(\d+)\s([A-Z]{1,2})$/, '$1$2');
const rest = (s: string) => s.replace(/^[\s,.;-]+/, '').replace(/\s+/g, ' ').trim();

export function splitAddress(raw: string): AddressParts | null {
  // «carrera55b#183-36»: se separa la vía del número cuando vienen pegados.
  const text = raw.replace(/\s+/g, ' ').trim().replace(/^([a-záéíóú.]+?)(\d)/i, '$1 $2');
  const block = BLOCK.exec(text);
  if (block) {
    const kind = /^(casa|cs)$/i.test(block[2]) ? 'CASA' : 'LOTE';
    return { viaTipo: 'MZ', viaNumero: tidy(block[1]), placa1: kind, placa2: tidy(block[3]), resto: rest(block[4]) };
  }
  for (const [re, code] of VIAS) {
    const via = re.exec(text);
    if (!via) continue;
    const plate = PLATE.exec(text.slice(via[0].length));
    if (!plate) return null;
    return { viaTipo: code, viaNumero: tidy(plate[1]), placa1: tidy(plate[2]), placa2: plate[3], resto: rest(plate[4]) };
  }
  return null;
}

/** La dirección como queda en la hoja: «KR 15 # 20 - 19». */
export const joinAddress = (p: AddressParts) => `${p.viaTipo} ${p.viaNumero} # ${p.placa1} - ${p.placa2}`;
