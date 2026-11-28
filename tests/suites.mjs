// Lista de pruebas. `api`: se arranca un servidor de prueba y la prueba le habla por HTTP.
// `directo`: la prueba usa el código del servidor sin arrancarlo, contra la base temporal.
export const SUITES = [
  // ── Núcleo y seguridad ──
  { name: 'seguridad', kind: 'api', file: 'sec.mjs', what: 'Acceso sin sesión, permisos, aislamiento entre empresas, CSRF, inyección, fuerza bruta', prep: [{ file: 'sec-setup.ts', args: ['{secreto}'] }], args: ['{credenciales}', '{secreto}'] },
  { name: 'seguridad-ip', kind: 'api', file: 'sec-ip.mjs', what: 'El límite por IP no se evade falsificando cabeceras (modo producción)', env: { NODE_ENV: 'production' }, args: [] },
  { name: 'plataforma', kind: 'api', file: 'platform.mjs', what: 'Panel de plataforma: empresas, planes, soporte', platform: true },
  { name: 'flujo', kind: 'api', file: 'flow.mjs', what: 'Recorrido de extremo a extremo de la API' },
  { name: 'ajustes', kind: 'api', file: 'settings.mjs', what: 'Ajustes de la empresa' },

  // ── Argos ──
  { name: 'turno', kind: 'api', file: 'shift.mjs', what: 'Un turno completo desde la extensión' },
  { name: 'consentimiento', kind: 'api', file: 'consent.mjs', what: 'Aviso de qué se registra' },
  { name: 'extension', kind: 'api', file: 'ext.mjs', what: 'Descarga de la extensión', env: { RENDER_EXTERNAL_URL: 'https://olympo-prueba.onrender.com' } },
  { name: 'modulos', kind: 'api', file: 'modules.mjs', what: 'Alarmas, reportes, agenda, mensajes, acompañamiento y calidad' },
  { name: 'sin-senal', kind: 'api', file: 'gap.mjs', what: 'Turnos que se quedan sin señal', prep: [{ file: 'gap-prep.ts' }] },
  { name: 'horarios', kind: 'api', file: 'roster.mjs', what: 'Horarios y asistencia' },

  // ── Hermes ──
  { name: 'hermes', kind: 'api', file: 'hermes.mjs', what: 'Pedidos: confirmación, despacho, novedades, entrega' },
  { name: 'vendedora', kind: 'api', file: 'seller.mjs', what: 'Lo que puede hacer una vendedora con sus pedidos' },
  { name: 'validar', kind: 'api', file: 'validate.mjs', what: 'Validación de dirección, teléfono y duplicados al crear' },
  { name: 'importar', kind: 'api', file: 'import.mjs', what: 'Importación de pedidos en lote' },
  { name: 'chats', kind: 'api', file: 'chats.mjs', what: 'Bandeja de conversaciones de Hermes' },
  { name: 'modo-confirmacion', kind: 'api', file: 'modo.mjs', what: 'Confirmación obligatoria, informativa o sin mensaje' },
  { name: 'operadores', kind: 'api', file: 'operators.mjs', what: 'Operadores logísticos y subida de guías' },
  { name: 'hoko', kind: 'api', file: 'hoko.mjs', what: 'Avisos de guía de Hoko' },
  { name: 'guia-pdf', kind: 'api', file: 'pdf.mjs', what: 'Enlace al PDF de la guía y cuenta de Hoko' },
  { name: 'oficina', kind: 'api', file: 'office2.mjs', what: 'Bandeja de pedidos en oficina' },
  { name: 'descarga-hoko', kind: 'api', file: 'export.mjs', what: 'Archivo de carga masiva para Hoko' },
  { name: 'pancake', kind: 'api', file: 'pancake2.mjs', what: 'WhatsApp por Pancake: cola, plantillas, lectura de respuestas' },
  { name: 'sin-pancake', kind: 'api', file: 'nopancake.mjs', what: 'Comportamiento sin canal conectado' },
  { name: 'oficina-avisos', kind: 'directo', file: 'office.ts', what: 'Recordatorios de paquetes en oficina' },
  { name: 'sin-respuesta', kind: 'directo', file: 'silence.ts', what: 'Qué pasa cuando el cliente no responde' },
  { name: 'guias-pendientes', kind: 'directo', file: 'backfill.ts', what: 'Puesta al día y recuperación de guías' },
  { name: 'cortesias', kind: 'directo', file: 'courtesy.ts', what: 'Mensajes de cortesía que no se contestan' },
  { name: 'direcciones', kind: 'directo', file: 'address.ts', what: 'Validador de direcciones' },
  { name: 'direcciones-pegadas', kind: 'directo', file: 'addr-glue.ts', what: 'Direcciones con la vía pegada al número' },

  // ── Athena ──
  { name: 'athena', kind: 'api', file: 'athena.mjs', what: 'Conversaciones, catálogo y paso a una persona (sin IA)' },
  { name: 'athena-ia', kind: 'api', file: 'athena.mjs', what: 'Venta completa con una IA simulada', env: { ANTHROPIC_API_KEY: 'sk-ant-prueba-local', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4200' }, args: ['{credenciales}', 'ia'] },
  { name: 'catalogo', kind: 'api', file: 'products.mjs', what: 'Productos contratados por empresa', platform: true },
  { name: 'formularios', kind: 'directo', file: 'gforms.ts', what: 'Formularios de Google y separación de direcciones' },

  // ── Zeus ──
  { name: 'zeus', kind: 'api', file: 'zeus.mjs', what: 'Clientes, segmentos, recompra y seguimientos', platform: true, prep: [{ file: 'zeus-prep.ts' }] },
];
