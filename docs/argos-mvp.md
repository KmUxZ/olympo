# Argos · MVP: alcance, arquitectura y límites

## 1. Alcance del MVP

Flujo completo implementado:

1. El administrador crea usuarios y asigna equipo (con su supervisor), línea y turno programado.
2. La vendedora inicia sesión en la extensión, autoriza las herramientas e inicia su turno.
3. La extensión registra actividad agregada por minuto en los sitios autorizados y sincroniza con el servidor.
4. El supervisor ve el estado de su equipo, con la hora del último dato de cada persona.
5. La vendedora declara pausas y reporta novedades (desde la extensión o la web).
6. El turno termina y se genera un resumen con línea de tiempo.
7. Las acciones administrativas y los accesos quedan en auditoría.

Pantallas disponibles: Inicio de sesión · Dashboard · Mi turno · Novedades · Turnos (historial y programación) ·
Líneas · Usuarios y equipos · Auditoría · Configuración (herramientas y conservación) · Qué se registra.

Agenda, Reportes, Acompañamiento, Mensajes, Calidad y Alarmas se añadieron después (ver sección 11).

## 2. Arquitectura

```
Extensión Chrome (MV3) ──┐
                         ├──►  API (Fastify)  ──►  PostgreSQL
Plataforma web (React) ──┘        │
                                  ├─ core/   sesiones, usuarios, equipos, roles, auditoría, ajustes por empresa
                                  └─ argos/  herramientas, líneas, turnos, pausas, actividad, novedades, dashboard
```

- **Modular.** `core/` es la plataforma que compartirán todos los productos. Cada producto es un módulo hermano
  (`argos/`, luego `zeus/`, `athena/`, `hermes/`) con sus rutas y sus tablas con prefijo propio (`argos_*`).
- **Multiempresa.** Toda tabla lleva `company_id` y toda consulta filtra por la empresa de la sesión.
  Siguiente refuerzo antes de vender a terceros: políticas RLS de PostgreSQL como segunda barrera.
- **Permisos en el servidor.** Cada ruta declara los roles admitidos y además limita el alcance de los datos:
  administrador = toda la empresa · supervisor = su equipo · vendedora = solo lo suyo. La web solo oculta lo que el servidor ya negaría.
- **Sesiones.** Tokens opacos (en la base solo se guarda su hash), revocables. Cookie `httpOnly` en la web; token `Bearer` en la extensión.
  Contraseñas con scrypt; contraseña temporal de un solo uso al crear la cuenta; límite de intentos de acceso.

## 3. Modelo de datos

| Tabla | Contenido |
| --- | --- |
| `core_companies` | Empresa, zona horaria, ajustes (conservación, umbrales), marca de demostración |
| `core_users` | Cuenta, rol (`admin`, `supervisor`, `seller`), equipo, estado |
| `core_teams` | Equipo y su supervisor |
| `core_sessions` | Sesiones web y de extensión (hash del token, expiración, revocación) |
| `core_audit_log` | Quién hizo qué, cuándo, sobre qué, con el antes y el después |
| `argos_tools` | Herramientas autorizadas: nombre y dominios |
| `argos_lines` | Línea o canal y a quién está asignada |
| `argos_schedules` | Turno programado semanal por persona |
| `argos_shifts` | Turno real: inicio, fin, motivo de cierre, última sincronización, resumen |
| `argos_breaks` | Pausas declaradas |
| `argos_presence_minutes` | Un registro por minuto en que la extensión estuvo viva |
| `argos_activity_minutes` | Conteos por minuto y herramienta |
| `argos_incidents` | Novedades y su seguimiento |

## 4. Qué mide realmente la extensión

Por cada minuto de un turno activo y sin pausa, y solo dentro de los dominios autorizados:

- **Segundos en uso** de la herramienta (pestaña visible y con el foco).
- **Segundos activos**: segundos con algún evento de entrada en los 5 s anteriores.
- **Número** de pulsaciones de tecla, de clics y de desplazamientos.
- **Estado del equipo** que informa Chrome: activo, inactivo o pantalla bloqueada.
- **Presencia**: que la extensión estaba funcionando ese minuto, haya o no actividad.

Nunca lee qué tecla se pulsó, texto, formularios, portapapeles ni direcciones de página. En campos de contraseña no cuenta nada.

### Cómo se garantiza el ámbito

- La extensión **no pide el permiso `tabs`** ni acceso general: Chrome solo le deja ver los dominios que la vendedora autoriza
  expresamente, que son los que definió el administrador. No puede ver sitios personales.
- `"incognito": "not_allowed"` en el manifiesto.
- Los scripts solo se registran al iniciar el turno y se retiran al terminarlo; durante una pausa no cuentan.
- El icono muestra siempre el estado (`ON`, `II`, `!`) y la página «¿Qué se registra?» enseña los datos pendientes tal cual.

### Estados y su significado

| Estado | Evidencia |
| --- | --- |
| Actividad observada | Hubo eventos de entrada en una herramienta autorizada en la ventana reciente |
| Sin actividad observada | La extensión reporta, pero no hubo eventos. **No implica ausencia de trabajo** |
| En pausa | Pausa declarada |
| Sin señal | La extensión dejó de sincronizar (en vivo no se puede saber si es conexión o navegador cerrado) |
| Sin datos | Minuto sin registro de presencia: navegador cerrado o equipo suspendido |
| Sincronizado con retraso | El dato llegó tarde: hubo falta de conexión y se recuperó |

### Límites técnicos (conviene conocerlos)

- **No ve trabajo fuera del navegador**: llamadas, WhatsApp de escritorio, otra app o el móvil aparecen como «sin actividad observada».
- **No mide resultados**: mensajes enviados, ventas, conversaciones y tiempos de respuesta deben venir de integraciones verificables.
- La actividad dentro de marcos incrustados de otro dominio no se cuenta.
- La granularidad es de un minuto; el dashboard va entre 1 y 2 minutos por detrás de la realidad.
- Chrome suspende el proceso en segundo plano de la extensión; por eso todo el estado se guarda en disco y la presencia se marca con una alarma por minuto.
- Una persona con conocimientos podría desactivar la extensión: se vería como «sin señal» / «sin datos», no como actividad falsa.
- Si el reloj del equipo difiere más de 90 s del servidor, los minutos se corrigen con la hora del servidor.

## 5. Desconexiones, reintentos y duplicados

- La extensión guarda los minutos en una cola local (hasta 48 h) y reintenta cada minuto.
- Cada registro se identifica por `(turno, minuto, herramienta)`: reenviar un lote no duplica nada.
- Los datos que llegan después de cerrar el turno (hasta 24 h) recalculan el resumen.
- Un turno sin señal durante el plazo configurado (3 h por defecto) se cierra solo, con hora de fin igual al último dato recibido.

## 6. Conservación y eliminación

- Los registros por minuto se eliminan automáticamente tras el plazo de la empresa (90 días por defecto, configurable entre 7 y 730).
- Los resúmenes de turno (agregados) se conservan.
- Cada depuración queda en auditoría. Las sesiones caducadas se limpian a los 7 días.

## 7. Integración futura con Zeus, Athena y Hermes

- Comparten `core/`: empresas, usuarios, roles, sesiones y auditoría.
- Las métricas de resultado entrarán como **eventos verificables** de cada plataforma (mensaje enviado, venta, entrega),
  asociados a persona, línea y turno. Argos los mostrará junto a la actividad, sin mezclarlos ni inferirlos.

## 8. Integración con Pancake (retirada)

Se retiró el 23 de noviembre de 2026. En la operación real todas las vendedoras usan un mismo usuario de Pancake
y se distinguen por etiquetas puestas a mano, así que las estadísticas por usuario no permiten separar personas y
las etiquetas son inexactas. Argos queda con lo que observa la extensión: conexión, actividad, pausas y turnos.
No hay token de Pancake que configurar. La migración `013_sin_pancake.sql` elimina sus tablas.

## 9. Nivel de plataforma (implementado)

Quien opera OLYMPO tiene un rol aparte (`is_platform_admin`) con el panel **Empresas**:

- Alta de empresas con su primer administrador y contraseña temporal.
- Suspender y reactivar: al suspender se cierran las sesiones de la empresa, nadie puede entrar y las extensiones dejan de registrar. Los datos se conservan.
- Límites del plan: máximo de vendedoras y de líneas activas, aplicados en el servidor.
- Estado de cada cliente: cuentas, líneas, turnos abiertos, último uso y errores de integración.
- Restablecer el acceso de un administrador.

**Privacidad entre plataforma y clientes.** El panel solo muestra datos de gestión. Para ver datos operativos de un cliente
hace falta el **modo soporte**: el administrador de la empresa concede acceso por 4 o 24 horas (Configuración → Acceso de soporte),
puede revocarlo en cualquier momento, y cada entrada y acción queda en la auditoría de esa empresa. Todas las acciones de
plataforma sobre una empresa (creación, suspensión, límites, restablecimientos) también quedan en su auditoría.

## 10. Consentimiento informado (implementado)

- Antes del primer turno, la extensión muestra qué se registra y qué no, y pide aceptarlo.
- El servidor rechaza iniciar turno sin esa aceptación (no depende solo de la extensión).
- Queda constancia por persona: versión del aviso, fecha, IP y cliente, además de una entrada en auditoría.
- El administrador ve en Usuarios quién ha aceptado y quién no.
- Si cambia lo que se registra, se sube `CONSENT_VERSION` (apps/server/src/config.ts) y todos deben aceptar de nuevo.
- Esto es una constancia técnica; el texto y su validez legal deben revisarse con un abogado según el país.

## 11. Módulos de operación y equipo (implementados)

| Módulo | Qué hace | Quién |
| --- | --- | --- |
| **Alarmas** | Cinco reglas configurables (turno sin iniciar, sin señal, pausa prolongada, sin actividad observada, novedad sin atender). Las alertas se abren y se cierran solas; «Enterado» indica que alguien ya la atiende. Aviso en el menú, en el dashboard y, opcionalmente, notificación del navegador. | Reglas: administrador. Alertas: administrador y supervisor (su equipo). |
| **Reportes** | Totales por persona y por día, con filtros de fecha, persona, equipo y línea. Exporta a CSV para Excel. Sin conteos de teclas. | Administrador y supervisor. |
| **Agenda** | Tareas, reuniones, compromisos y actividades para una persona, un equipo o toda la empresa. Cada quien marca lo suyo como hecho. | Todos; cada rol programa dentro de su alcance. |
| **Mensajes** | Mensajes directos, a un equipo o a toda la empresa, con contador de no leídos. Una vendedora escribe a su supervisión y a administración. | Todos. |
| **Acompañamiento** | Sesiones de seguimiento con notas y compromisos con fecha y estado. La persona ve las suyas. | Registra: supervisor y administrador. |
| **Calidad** | Criterios con peso definidos por la empresa; evaluación con nota por criterio, resultado ponderado sobre 100, observaciones y retroalimentación. La persona confirma que la leyó. Las evaluaciones guardan copia de los criterios usados. | Criterios: administrador. Evalúa: supervisor y administrador. |

La alarma «sin actividad observada» es un aviso para preguntar, no una falta: no se dispara durante una pausa, sin señal,
ni cuando la persona tiene una novedad abierta que explica la inactividad.

## 12. Hermes · logística (primera versión)

Segundo producto del ecosistema. Vive en `apps/server/src/hermes/` y `apps/web/src/pages/hermes/`, con tablas `hermes_*`.

**Recorrido de un pedido:** por confirmar → confirmado → despachado → en reparto → entregado, con las salidas
novedad, devuelto y cancelado.

**Qué hace el bot**
- Pide la confirmación al cliente con botones (confirmar, corregir datos, cancelar) y entiende un «sí» o «no» escrito.
- Si el cliente corrige la dirección, la actualiza, guarda la anterior en el historial y vuelve a pedir confirmación.
- Envía recordatorios configurables y, si nadie responde, pasa el pedido a una persona.
- Envía la guía al despachar y avisa el día del reparto con el valor a pagar.
- Ante una novedad de la transportadora, le escribe al cliente con opciones (reprogramar, corregir dirección, ya no lo quiero)
  y deja el caso en la bandeja con lo que respondió.
- Lo que no entiende sin ambigüedad lo pasa a una persona; avisa al cliente una sola vez.
- Detecta posibles duplicados (mismo teléfono con un pedido abierto).

**Pantallas:** Pedidos (con la conversación de cada pedido y sus acciones), Novedades de entrega y Panel de entregas
(embudo, tasa de entrega por vendedora, ciudad y transportadora, novedades por tipo).

**Modo simulado.** Por defecto Hermes no envía nada: guarda los mensajes y permite simular las respuestas del cliente.
El envío real se conecta en `bot.send()` (canal) cuando exista el número de logística y las plantillas aprobadas por Meta.

**Pendiente:** conector de la transportadora (guías y estados automáticos), canal real de WhatsApp vía Pancake con su webhook
de mensajes entrantes, y la entrada automática de pedidos desde Pancake.

**Validador de datos de entrega (Hermes).** Antes de crear un pedido, y mientras se escribe en los formularios, Hermes revisa:
la estructura de la dirección según la nomenclatura colombiana (vía, placa `# 12-34`, barrio, apartamento si hay edificio),
la ciudad contra un catálogo de ciudades principales, el teléfono, el nombre y el historial del cliente (devoluciones y
rechazos previos con ese número). Los avisos no bloquean; un teléfono incompleto sí. Si falta algo de la dirección, el bot
se lo pide al cliente en el mensaje de confirmación. Un cliente con devoluciones y ninguna entrega queda marcado para atención.
Límite: valida la forma, no que la dirección exista ni la cobertura de la transportadora (pendiente: geocodificación y API de la transportadora).

**Chats (Hermes).** Bandeja de tres paneles con una conversación por pedido. Cada una indica quién tiene la pelota
(persona, cliente, en curso o cerrado) y cuánto lleva esperando; se ordena por la espera más larga. El hilo mezcla mensajes
e hitos del pedido. Una persona puede tomar la conversación (pausa el bot en ese pedido) y devolverla; responder como persona
quita el pendiente. Incluye respuestas sugeridas según el estado, reenvío de la confirmación y marca de no leídos.
Pendiente: conversaciones de números sin pedido (llegarán con el canal real) y asignación de chats a personas concretas.

## Hermes · importación en lote y clientes bloqueados

- **Importar en lote** (Pedidos → «Importar en lote», admin y supervisor): se pegan filas desde Excel/Sheets o se sube un CSV (hasta 300 filas). Si va la fila de títulos, el orden de columnas no importa. Primero hay una vista previa (`POST /api/hermes/import/preview`) que no crea nada y marca cada fila como lista, lista con avisos o no creable; luego `POST /api/hermes/import` crea solo las válidas y devuelve las omitidas con su motivo. Cada fila pasa por las mismas reglas que un pedido manual (teléfono, dirección completa, cliente bloqueado). Un teléfono repetido en el archivo o con pedido abierto es aviso, no bloqueo.
- **Clientes bloqueados** (`hermes_blocked`, por empresa y teléfono): se bloquea desde su pantalla o desde el chat, con motivo obligatorio. Hermes rechaza crearles pedidos (409 `cliente_bloqueado`) a mano, por importación y desde la extensión; el validador lo avisa mientras se escribe. Los pedidos en curso no cambian. Bloquear, desbloquear e importar quedan en auditoría.

## Hermes · qué ve la vendedora y correcciones

- **Vista de la vendedora («Mis pedidos»)**: solo los pedidos atribuidos a ella, con los datos que subió (cliente, dirección, productos, valor) y dos estados: *Recibido* o *Por corregir*. El servidor no le envía estado logístico, guía, entregas, devoluciones, cancelaciones, conversación, historial de eventos ni historial del cliente (tampoco en el validador ni en la respuesta al crear). El aviso de cliente bloqueado sí lo ve, porque le impide crear el pedido.
- **Correcciones**: logística pide la corrección desde el pedido con una nota (`POST /api/hermes/orders/:id/request-correction`; se puede retirar con `cancel-correction`). La vendedora corrige nombre, teléfono, dirección, ciudad e indicaciones (`PUT /api/hermes/orders/:id/correction`), con el mismo validador de dirección; productos y valor no se cambian ahí. Al guardar, el pedido vuelve a logística como «por atender» y, si el cliente aún no había confirmado, se le pide de nuevo la confirmación con los datos corregidos. Solo se puede corregir cuando hay una corrección pedida y el pedido no está cerrado.

## Athena · vendedora IA (MVP)

- **Qué hace**: atiende al cliente con el catálogo, las políticas y las reglas de la empresa; reúne los datos; crea el pedido en Hermes (origen `athena`) cuando el cliente confirma; y pasa la conversación a una persona cuando no tiene el dato, el cliente lo pide o algo falla. Producto aparte (`athena` en `core_companies.products`), con su menú, marca provisional y rutas `/api/athena/*`. Lo gestionan administrador y supervisor; los ajustes de fondo, solo el administrador.
- **Regla central**: Athena solo afirma lo que está escrito en «Catálogo y respuestas» y en los ajustes. Si la IA falla, declina o se queda sin respuesta, no se le inventa nada al cliente: la conversación pasa a una persona con el motivo.
- **Cerebro** (`apps/server/src/athena/brain.ts`): con credenciales de Anthropic en el servidor (`ANTHROPIC_API_KEY`) usa Claude por la API de Mensajes con tres herramientas (`guardar_datos`, `crear_pedido`, `pasar_a_humano`); modelo por empresa (por defecto `claude-opus-5-5`), esfuerzo bajo, contexto fijo cacheado y respaldo automático ante declinaciones. Sin credenciales funciona en **modo básico**: repite lo escrito y pasa todo lo demás (incluida una compra) a una persona; cada respuesta queda marcada como «modo básico, sin IA».
- **Motor** (`engine.ts`): un mensaje a la vez por conversación; valida la dirección con el validador de Hermes; respeta clientes bloqueados (no crea el pedido y pasa a una persona); no crea dos pedidos en la misma conversación. Si la empresa no tiene Hermes, o el administrador desactiva «crear pedidos», reúne los datos y entrega la conversación.
- **Pruebas desde la plataforma** («Probar Athena»): conversaciones marcadas como prueba, aparte de la bandeja; no crean pedidos reales ni escriben a nadie.
- **Pendiente para el final (accesos)**: credencial de IA, número de WhatsApp (hoy el canal es `simulado`; la entrada real es `POST /api/athena/inbound`) y plantillas. No verificado todavía contra la API real de Anthropic: las pruebas usan una API imitada.

## Instalación de la extensión guiada desde la plataforma

- **Descarga configurada**: `GET /api/argos/extension.zip` entrega la extensión con la dirección pública del servidor ya puesta (y su permiso en el manifiesto), así nadie escribe la dirección a mano. La dirección sale de `PUBLIC_URL`, o de `RENDER_EXTERNAL_URL`, o del servidor local en desarrollo. Con dominio propio hay que definir `PUBLIC_URL`.
- **Guía ilustrada** (`/instalar-extension`, también en el menú de Argos): 5 pasos, uno a la vez, con un dibujo de lo que se ve en pantalla y dónde hacer clic. Los dibujos son ilustraciones propias, no capturas de Chrome.
- **Puerta de entrada**: una vendedora de una empresa con Argos que aún no ha iniciado sesión en la extensión ve la guía antes que la plataforma. La guía consulta `GET /api/argos/extension/status` cada 3 segundos y termina sola cuando la extensión inicia sesión. Hay una salida («no puedo instalarla en este equipo») que vale solo para esa sesión del navegador.
- El cambio de contraseña temporal ocurre antes de la guía, porque la extensión no acepta contraseñas temporales.

## Malla de turnos

- **Qué es**: el turno de cada vendedora por fecha (`argos_roster`: persona, día, inicio y fin; sin horas = descanso). En un día con malla, la malla manda sobre el horario fijo semanal (`argos_schedules`); donde no hay malla se sigue aplicando el horario fijo.
- **Dónde**: Turnos → «Malla de turnos». Cuadrícula semanal, edición por celda (aplicable a varios días), «Copiar semana anterior» y «Subir malla» (archivo de Excel .xlsx, CSV o pegar las celdas: una fila por vendedora, una columna por fecha; acepta `08:00-17:00`, `8am a 5pm`, `Descanso`). Editan administrador y supervisor (su equipo); la vendedora ve su semana en «Mi turno».
- **Control**: cada celda de hoy o pasada muestra la hora real de inicio, los minutos de retraso (más de 5) o «No inició turno». La alerta de turno no iniciado, el tablero («programada ahora») y «Semana de un vistazo» usan la malla del día.
- **Límites conocidos**: un turno de malla que cruza la medianoche deja de contarse como «programado ahora» al pasar las 00:00; la extensión sigue mostrando el horario fijo, no la malla.
- **Tablero**: la columna «Actividad hoy» muestra «% con actividad» y «% conectada», ambos con verde ≥ 90, amarillo 80–89 y rojo < 80.

## Seguridad (revisión de noviembre de 2026)

- **Acceso**: contraseñas con scrypt y sal; el token de sesión solo se guarda como hash; cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` en producción). Límite de intentos fallidos: 10 por cuenta y 40 por IP cada 15 minutos (en memoria: se reinicia con el servidor). Una cuenta inexistente responde igual y tarda lo mismo que una contraseña incorrecta.
- **Permisos**: cada ruta exige sesión y rol (`guard`); cada consulta filtra por empresa; los productos se validan en el servidor.
- **CSRF**: las escrituras con cookie solo se aceptan del propio origen o de `WEB_ORIGINS`; sin `Origin`, se rechaza lo que el navegador marca como de otro sitio.
- **Cabeceras**: CSP (solo recursos propios, sin marcos), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS en producción y `Cache-Control: no-store` en la API.
- **Datos que entran**: validación con zod en todas las rutas, SQL siempre con parámetros, enlaces de rastreo solo `http(s)`, exportaciones CSV protegidas contra fórmulas.
- **Athena**: no crea un pedido cuyo total esté por debajo del precio más bajo del catálogo (o de la cifra más baja escrita en una oferta); lo pasa a una persona.
- **Pendiente conocido**: el límite de intentos es por instancia (si algún día hay varias, debe ir a la base de datos); no hay segundo factor de autenticación; `/api/athena/simulate` y `/inbound` no tienen límite de uso propio (solo administrador/supervisor); la extensión se instala sin firma de la Chrome Web Store.

## Hermes · canal real de WhatsApp por Pancake

- **Qué hace**: con el canal activo (`hermes_settings.driver = 'pancake'`), Hermes envía por la API pública de Pancake (`hermes/pancake.ts`) y recibe las respuestas por un aviso (webhook). Se configura en Hermes → Panel de entregas → «WhatsApp por Pancake» (solo administrador): página, token (cifrado), dirección de avisos, identificadores de plantillas, prueba y activación.
- **Regla de las 24 horas**: si el cliente escribió en las últimas 23 h, el mensaje va como texto libre (los botones se escriben como opciones). Fuera de esa ventana va como plantilla aprobada. Sin plantilla: los avisos obligatorios quedan `fallido` y piden atención; los opcionales quedan `omitido` sin molestar.
- **Plantillas** (`bot.TEMPLATES`): obligatorias `hermes_confirmacion`, `hermes_recordatorio`, `hermes_guia`, `hermes_novedad`; opcionales `hermes_en_reparto`, `hermes_entregado`, `hermes_confirmado`, `hermes_cancelado`. Variables por nombre, enviadas en `template_params.BODY_PARAMS`.
- **Avisos entrantes (opcional)**: `POST /api/hermes/webhook/pancake/<clave>` (sin sesión; la clave es secreta y por empresa). Pancake no firma sus avisos, así que nunca se actúa sobre su contenido: solo indican qué conversación leer. Lo que escribe el equipo desde Pancake se anota en la conversación; los mensajes ya vistos se descartan por `external_id`.
- **Cola de envíos**: `send()` no llama a Pancake; deja el mensaje `en_cola` y `deliverQueued` lo entrega en orden, con una pausa entre llamadas (Pancake admite 5 por segundo por página). Un fallo pasajero se reintenta a los 30 s, 1, 2 y 4 minutos; uno definitivo queda `fallido` y pide atención.
- **Respuestas sin webhook** (`hermes/inbound.ts`): cada minuto se pide a Pancake la lista de conversaciones con movimiento y se leen solo las de teléfonos con pedido. Si esa lista no responde como se espera, se consulta pedido a pedido con una frecuencia que baja según hace cuánto hubo movimiento (1, 3, 15 y 60 minutos). Los mensajes anteriores a la activación del canal no se procesan. El webhook es opcional (en Pancake consume 2 ranuras del plan): del aviso solo se usa de qué conversación es, y los mensajes se leen igual de la API.
- **Límites y pendientes**: una sola página de Pancake por empresa; no verificado todavía contra el Pancake real (las pruebas usan uno imitado): falta confirmar en vivo la forma exacta de las variables, el identificador de conversación para números nuevos (`<página>_<teléfono>`) y el contenido del aviso. Athena aún no usa este canal.

## Zeus · CRM de clientes y recompra (MVP)

- **Qué es**: producto aparte (`zeus` en `core_companies.products`, rutas `/api/zeus/*`, menú y marca provisional propios). Un cliente es un teléfono. Su ficha se **calcula** de los pedidos de Hermes en cada consulta (`zeus/routes.ts`, subconsulta `CUSTOMERS`): no hay copia que sincronizar. Zeus solo guarda lo que añaden las personas: etiquetas (`zeus_profiles`), notas (`zeus_notes`), seguimientos (`zeus_followups`) y los días de recompra (`zeus_settings`).
- **Segmentos** (el primero que cumpla): bloqueado (lista de Hermes) → riesgoso (2 o más pedidos devueltos o cancelados, y no menos que los entregados) → VIP (3+ entregas) → recurrente (2) → compró una vez (1) → en proceso (aún no recibe, tiene pedido en curso) → sin entrega.
- **Recompra**: clientes con al menos una entrega, sin pedido en curso, no riesgosos ni bloqueados, sin seguimiento pendiente y con la última entrega hace N días o más (N por empresa, 30 por defecto). Desde ahí se crean seguimientos en lote; por defecto se asignan a quien le vendió la última vez.
- **Seguimientos**: pendiente / hecho (con resultado: compró, interesado, no le interesa, no contesta) / descartado. El menú cuenta los que vencen hoy o ya vencieron.
- **Permisos**: clientes, fichas y recompra, solo administrador y supervisor. La vendedora ve únicamente «Mis seguimientos»: nombre, WhatsApp y qué hacer, sin historial de pedidos ni cifras; no puede reasignar ni cambiar fechas.
- **Fuera del MVP**: embudo de prospectos, campañas por WhatsApp, clientes que no vienen de un pedido de Hermes, creación del pedido desde el seguimiento (hoy se crea en Hermes a mano) y segmentos configurables.
- **En pausa para el público**: Zeus solo está activo en la empresa que opera la plataforma. A las demás no se les muestra en el selector ni se les puede activar (`INTERNAL_PRODUCTS` en `platform.routes.ts`, `internal` en `PRODUCT_INFO`). Para abrirlo al público basta quitarlo de esas dos listas.

## Hermes · operadores logísticos y guías en lote

- Un **operador logístico** es la plataforma intermediaria por la que sale un pedido y que genera la guía con la transportadora. Cada empresa define los suyos en Hermes → Panel de entregas (solo el administrador los crea o desactiva).
- Cada pedido guarda su operador (`operator_id`) y su número dentro de ese operador (`operator_ref`). La persona encargada (administrador o supervisor) lo elige en «Pedidos», uno a uno o varios a la vez, mientras el pedido no se haya despachado.
- **Subir guías**: se pega o se sube el archivo de guías del operador (columnas Teléfono y Guía; opcionales Pedido y Transportadora). Cada fila se cruza con el pedido **confirmado** de ese teléfono —solo por teléfono, nunca por nombre—, se despacha y el bot le envía la guía al cliente. Hay vista previa y no se despacha nada dudoso: teléfono con dos pedidos confirmados, pedido de otro operador, pedido sin confirmar o guía ya cargada.
- El panel compara la tasa de entrega por operador. La vendedora no ve ningún dato de operador.
- Pendiente: conectores automáticos por operador (`driver` distinto de `manual`) que traigan guía y estados sin archivo.
