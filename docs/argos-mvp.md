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

Previsto para después (visible en el menú como «Próximamente»): Agenda, Reportes, Acompañamiento, Mensajes, Calidad, Alarmas.

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

## 8. Integración con Pancake (implementada)

- Cada **línea** de Argos se conecta a una **página** de Pancake con su identificador y su token de página
  (Configuración → Integración con Pancake). El token se valida, se guarda cifrado y nunca se devuelve.
- Cada usuario de Pancake se **empareja** con una cuenta de Argos.
- Cada 5 minutos se consulta `GET /pages/{page_id}/statistics/users` y se guardan, por hora, línea y usuario:
  mensajes atendidos, conversaciones distintas, comentarios, teléfonos captados y tiempo medio de respuesta.
- El dashboard muestra por vendedora los mensajes atendidos hoy y su respuesta media, con la hora del último dato.
- Límites: la granularidad es de una hora; el tiempo medio diario es una media ponderada por mensajes;
  las horas se interpretan en la zona horaria de la empresa (debe coincidir con la de la página en Pancake).
- Pendiente: ventas/pedidos, vista por línea y por rango de fechas (módulo Reportes), y webhooks para tiempo real.

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
