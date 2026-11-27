// Hermes · validador de datos de entrega (Colombia).
// Revisa la ESTRUCTURA de lo escrito: no confirma que la dirección exista en el mapa ni que la transportadora
// llegue hasta allí. Eso se conectará después (geocodificación y cobertura de la transportadora).

export interface Issue {
  code: string;
  message: string;
  /** error = impide crear el pedido · aviso = se puede crear, pero conviene corregir */
  severity: 'error' | 'aviso';
}
export interface AddressCheck {
  /** completa: no falta nada · revisar: solo avisos (zona rural, ciudad no reconocida) · incompleta: falta un dato obligatorio y el pedido no se puede crear */
  level: 'completa' | 'revisar' | 'incompleta';
  issues: Issue[];
  normalizedAddress: string;
  city: { name: string; department: string } | null;
  rural: boolean;
  /** Lo que conviene pedirle al cliente, en palabras para un mensaje. */
  missing: string[];
}

// Ciudades principales de Colombia. No es el listado completo de municipios: una ciudad que no esté aquí
// genera un aviso para verificar el nombre, no un error.
const CITIES: [string, string][] = [
  ['Bogotá', 'Bogotá D.C.'],
  ['Medellín', 'Antioquia'], ['Bello', 'Antioquia'], ['Itagüí', 'Antioquia'], ['Envigado', 'Antioquia'], ['Sabaneta', 'Antioquia'], ['Rionegro', 'Antioquia'], ['Apartadó', 'Antioquia'], ['Turbo', 'Antioquia'], ['Caucasia', 'Antioquia'], ['La Estrella', 'Antioquia'], ['Copacabana', 'Antioquia'], ['Girardota', 'Antioquia'],
  ['Cali', 'Valle del Cauca'], ['Palmira', 'Valle del Cauca'], ['Buenaventura', 'Valle del Cauca'], ['Tuluá', 'Valle del Cauca'], ['Cartago', 'Valle del Cauca'], ['Buga', 'Valle del Cauca'], ['Jamundí', 'Valle del Cauca'], ['Yumbo', 'Valle del Cauca'],
  ['Barranquilla', 'Atlántico'], ['Soledad', 'Atlántico'], ['Malambo', 'Atlántico'], ['Sabanalarga', 'Atlántico'], ['Puerto Colombia', 'Atlántico'],
  ['Cartagena', 'Bolívar'], ['Magangué', 'Bolívar'], ['Turbaco', 'Bolívar'], ['El Carmen de Bolívar', 'Bolívar'],
  ['Cúcuta', 'Norte de Santander'], ['Ocaña', 'Norte de Santander'], ['Pamplona', 'Norte de Santander'], ['Villa del Rosario', 'Norte de Santander'], ['Los Patios', 'Norte de Santander'],
  ['Bucaramanga', 'Santander'], ['Floridablanca', 'Santander'], ['Girón', 'Santander'], ['Piedecuesta', 'Santander'], ['Barrancabermeja', 'Santander'], ['San Gil', 'Santander'],
  ['Pereira', 'Risaralda'], ['Dosquebradas', 'Risaralda'], ['Santa Rosa de Cabal', 'Risaralda'],
  ['Manizales', 'Caldas'], ['La Dorada', 'Caldas'], ['Chinchiná', 'Caldas'], ['Villamaría', 'Caldas'],
  ['Armenia', 'Quindío'], ['Calarcá', 'Quindío'], ['Montenegro', 'Quindío'],
  ['Ibagué', 'Tolima'], ['Espinal', 'Tolima'], ['Melgar', 'Tolima'], ['Honda', 'Tolima'],
  ['Neiva', 'Huila'], ['Pitalito', 'Huila'], ['Garzón', 'Huila'],
  ['Villavicencio', 'Meta'], ['Acacías', 'Meta'],
  ['Pasto', 'Nariño'], ['Ipiales', 'Nariño'], ['Tumaco', 'Nariño'],
  ['Popayán', 'Cauca'], ['Santander de Quilichao', 'Cauca'],
  ['Montería', 'Córdoba'], ['Lorica', 'Córdoba'], ['Sahagún', 'Córdoba'], ['Cereté', 'Córdoba'],
  ['Sincelejo', 'Sucre'], ['Corozal', 'Sucre'],
  ['Valledupar', 'Cesar'], ['Aguachica', 'Cesar'],
  ['Santa Marta', 'Magdalena'], ['Ciénaga', 'Magdalena'], ['Fundación', 'Magdalena'],
  ['Riohacha', 'La Guajira'], ['Maicao', 'La Guajira'],
  ['Tunja', 'Boyacá'], ['Duitama', 'Boyacá'], ['Sogamoso', 'Boyacá'], ['Chiquinquirá', 'Boyacá'],
  ['Soacha', 'Cundinamarca'], ['Chía', 'Cundinamarca'], ['Zipaquirá', 'Cundinamarca'], ['Facatativá', 'Cundinamarca'], ['Fusagasugá', 'Cundinamarca'], ['Girardot', 'Cundinamarca'], ['Mosquera', 'Cundinamarca'], ['Madrid', 'Cundinamarca'], ['Funza', 'Cundinamarca'], ['Cajicá', 'Cundinamarca'],
  ['Yopal', 'Casanare'], ['Arauca', 'Arauca'], ['Florencia', 'Caquetá'], ['Quibdó', 'Chocó'], ['Mocoa', 'Putumayo'], ['Leticia', 'Amazonas'],
  ['San José del Guaviare', 'Guaviare'], ['Inírida', 'Guainía'], ['Mitú', 'Vaupés'], ['Puerto Carreño', 'Vichada'], ['San Andrés', 'San Andrés y Providencia'],
];
const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
const CITY_INDEX = new Map(CITIES.map(([name, department]) => [plain(name), { name, department }]));
CITY_INDEX.set('bogota dc', { name: 'Bogotá', department: 'Bogotá D.C.' });
CITY_INDEX.set('bogota d c', { name: 'Bogotá', department: 'Bogotá D.C.' });
CITY_INDEX.set('guadalajara de buga', { name: 'Buga', department: 'Valle del Cauca' });
CITY_INDEX.set('cartagena de indias', { name: 'Cartagena', department: 'Bolívar' });

export function findCity(raw: string): { name: string; department: string } | null {
  const first = plain(raw.split(/[,\-/(]/)[0] ?? '');
  return CITY_INDEX.get(first) ?? CITY_INDEX.get(plain(raw)) ?? null;
}

const NUM = String.raw`\d{1,3}\s?[a-z]?(?:\s?bis)?(?:\s?(?:sur|norte|este|oeste|occidente|oriente))?`;
const VIA = String.raw`(calle|cll|cl|carrera|cra|kra|kr|cr|avenida calle|avenida carrera|avenida|avda|av|ak|ac|diagonal|diag|dg|transversal|transv|trv|tv|circular|circ|autopista|aut)`;
const VIA_RE = new RegExp(String.raw`\b${VIA}\b\.?`, 'i');
// vía + número + (# opcional) + número + (guion o espacio) + número
const PLATE_RE = new RegExp(String.raw`\b${VIA}\b\.?\s*(${NUM})\s*(?:#|n[o°º]\.?|numero|número|nro\.?)?\s*(${NUM})\s*[-–—\s]\s*(\d{1,3})\b`, 'i');
const BLOCK_RE = /\b(manzana|mza|mz)\b\.?\s*[a-z0-9]+.*\b(casa|cs|lote|lt)\b\.?\s*[a-z0-9]+/i;
const RURAL_RE = /\b(vereda|vda|corregimiento|finca|parcela|km|kil[oó]metro|v[ií]a a|zona rural)\b/i;
const BARRIO_RE = /\b(barrio|brr|br|urbanizaci[oó]n|urb|sector|ciudadela|etapa|conjunto|conj|unidad residencial)\b|b\//i;
const COMPLEX_RE = /\b(edificio|edif|torre|conjunto|conj|unidad|bloque|bl)\b/i;
const UNIT_RE = /\b(apartamento|apto|apt|ap|casa|cs|interior|int|local|oficina|of|piso)\b\.?\s*#?\s*[a-z0-9]+/i;

const VIA_NAMES: Record<string, string> = {
  calle: 'Calle', cll: 'Calle', cl: 'Calle', carrera: 'Carrera', cra: 'Carrera', kra: 'Carrera', kr: 'Carrera', cr: 'Carrera',
  avenida: 'Avenida', avda: 'Avenida', av: 'Avenida', ak: 'Avenida Carrera', ac: 'Avenida Calle', 'avenida calle': 'Avenida Calle', 'avenida carrera': 'Avenida Carrera',
  diagonal: 'Diagonal', diag: 'Diagonal', dg: 'Diagonal', transversal: 'Transversal', transv: 'Transversal', trv: 'Transversal', tv: 'Transversal',
  circular: 'Circular', circ: 'Circular', autopista: 'Autopista', aut: 'Autopista',
};
const tidy = (n: string) => n.replace(/\s+/g, ' ').trim().replace(/^(\d+)\s?([a-z])\b/i, (_m, d, l) => `${d}${l.toUpperCase()}`);

// «carrera55b#183-36»: mucha gente pega la vía al número. Se separa para que se reconozca igual.
const GLUED_VIA_RE = new RegExp(String.raw`\b${VIA}(?=\d)`, 'gi');
const unglue = (text: string) => text.replace(GLUED_VIA_RE, '$1 ');

/** Une la dirección y el barrio (que en los formularios va en su propio campo) en un solo texto. */
export function composeAddress(address: string, neighborhood?: string | null): string {
  const a = unglue(address).replace(/\s+/g, ' ').trim();
  const n = (neighborhood ?? '').replace(/\s+/g, ' ').trim().replace(/^barrio\s+/i, '');
  if (!n || plain(a).includes(plain(n))) return a;
  return `${a}, barrio ${n}`;
}

export function checkAddress(rawAddress: string, rawCity: string): AddressCheck {
  const address = unglue(rawAddress).replace(/\s+/g, ' ').trim();
  const issues: Issue[] = [];
  const missing: string[] = [];
  // Los datos obligatorios (vía, número, barrio, apartamento si hay edificio, ciudad) son errores:
  // sin ellos el pedido no se crea. Zona rural y ciudad no reconocida son avisos.
  const add = (code: string, message: string, ask?: string, severity: Issue['severity'] = 'error') => {
    issues.push({ code, message, severity });
    if (ask) missing.push(ask);
  };

  const plate = PLATE_RE.exec(address);
  const block = BLOCK_RE.test(address);
  const rural = RURAL_RE.test(address);
  const hasVia = VIA_RE.test(address);
  let essential = true;

  if (rural) {
    add('rural', 'Parece una zona rural (vereda, finca o kilómetro). Muchas transportadoras no entregan en puerta: confirma un punto de referencia y que el cliente pueda recoger en oficina.', 'un punto de referencia claro para la entrega', 'aviso');
  } else if (!plate && !block) {
    essential = false;
    if (!hasVia) add('sin_via', 'No se reconoce el tipo de vía (Calle, Carrera, Avenida, Diagonal, Transversal o Manzana).', 'la dirección con calle o carrera y su número');
    else add('sin_placa', 'Falta el número completo de la dirección. Formato esperado: Calle 10 # 5-20.', 'el número completo de la dirección (por ejemplo, # 5-20)');
  }

  if (!rural && !BARRIO_RE.test(address)) add('sin_barrio', 'Falta el barrio.', 'el barrio');
  if (COMPLEX_RE.test(address) && !UNIT_RE.test(address)) add('sin_unidad', 'Menciona edificio, torre o conjunto pero no el apartamento o la casa.', 'el número de apartamento o casa');

  const city = findCity(rawCity);
  if (!rawCity.trim()) add('sin_ciudad', 'Falta la ciudad.', 'la ciudad');
  else if (!city) add('ciudad_desconocida', `No reconocemos «${rawCity.trim()}» entre las ciudades principales. Verifica el nombre y, si es un municipio pequeño, la cobertura de la transportadora.`, undefined, 'aviso');

  // Forma estándar de la parte principal, conservando el resto tal como se escribió.
  let normalized = address;
  if (plate) {
    const head = `${VIA_NAMES[plate[1].toLowerCase()] ?? plate[1]} ${tidy(plate[2])} # ${tidy(plate[3])}-${plate[4]}`;
    normalized = (address.slice(0, plate.index) + head + address.slice(plate.index + plate[0].length)).replace(/\s+/g, ' ').trim();
  }

  const blocking = !essential || issues.some((i) => i.severity === 'error');
  const level: AddressCheck['level'] = blocking ? 'incompleta' : issues.length ? 'revisar' : 'completa';
  return { level, issues, normalizedAddress: normalized, city, rural, missing };
}

/** Revisa el teléfono (celular colombiano) y el nombre. */
export function checkContact(normalizedPhone: string, customerName: string): Issue[] {
  const issues: Issue[] = [];
  if (!/^57 ?3\d{9}$/.test(normalizedPhone)) {
    if (normalizedPhone.length < 10) issues.push({ code: 'telefono_corto', message: 'El teléfono está incompleto: un celular tiene 10 dígitos.', severity: 'error' });
    else issues.push({ code: 'telefono_no_celular', message: 'El número no parece un celular colombiano (10 dígitos que empiezan por 3). El bot escribe por WhatsApp: verifica que lo tenga.', severity: 'aviso' });
  }
  if (customerName.trim().split(/\s+/).length < 2) issues.push({ code: 'nombre_incompleto', message: 'Escribe nombre y apellido: la transportadora los pide para entregar.', severity: 'aviso' });
  return issues;
}

export interface CustomerHistory {
  delivered: number;
  returned: number;
  cancelled: number;
  refused: number;
  open: number;
  /** alto: ya devolvió o rechazó y nunca ha recibido · medio: historial mixto · bueno: solo entregas · nuevo: sin historial */
  risk: 'alto' | 'medio' | 'bueno' | 'nuevo';
  message: string;
}

export function summarizeHistory(h: Omit<CustomerHistory, 'risk' | 'message'>): CustomerHistory {
  const bad = h.returned + h.refused;
  let risk: CustomerHistory['risk'] = 'nuevo';
  let message = 'Cliente nuevo: sin pedidos anteriores con este número.';
  if (bad > 0 && h.delivered === 0) {
    risk = 'alto';
    message = `Este número ya tuvo ${bad} pedido(s) devueltos o rechazados y ninguno entregado. Confirma por llamada antes de despachar.`;
  } else if (bad > 0) {
    risk = 'medio';
    message = `Este número tiene ${h.delivered} pedido(s) entregados y ${bad} devueltos o rechazados.`;
  } else if (h.delivered > 0) {
    risk = 'bueno';
    message = `Cliente conocido: ${h.delivered} pedido(s) entregados sin devoluciones.`;
  } else if (h.cancelled > 0) {
    risk = 'medio';
    message = `Este número canceló ${h.cancelled} pedido(s) antes y aún no ha recibido ninguno.`;
  }
  return { ...h, risk, message };
}
