# OLYMPO

Ecosistema de herramientas para e-commerce. Primer producto: **Argos** (operación y acompañamiento de equipos de venta).
Zeus CRM, Athena IA y Hermes IA son visión futura; la base ya está preparada para integrarlos.

> Los nombres son decisiones de trabajo; su disponibilidad legal no está confirmada.

## Estructura

```
apps/server      API (Fastify + TypeScript, Node 24). core/ = plataforma compartida · argos/ = producto
apps/web         Plataforma web (React + Vite)
apps/extension   Extensión de Chrome (Manifest V3, sin paso de compilación)
docs/            Alcance del MVP, arquitectura, modelo de datos y límites de la extensión
data/            Base de datos local de desarrollo y credenciales demo (no se versiona)
```

## Puesta en marcha (desarrollo)

Requisitos: Node 24 o superior.

```powershell
npm install
npm run seed     # crea la empresa de demostración; las credenciales quedan en data/credenciales-demo.txt
npm run dev      # API en http://localhost:4000 · web en http://localhost:5173
```

La base local de desarrollo solo admite **un servidor a la vez**: si ya hay uno en marcha, un segundo
`npm run dev` o `npm run seed` se detiene con un aviso. Para uso real con el equipo, usa PostgreSQL (`DATABASE_URL`).

### Instalar la extensión

1. Abre `chrome://extensions` y activa **Modo de desarrollador**.
2. **Cargar descomprimida** → elige la carpeta `apps/extension`.
3. Fija el icono de Argos, ábrelo e inicia sesión con una cuenta de vendedora.
4. Pulsa **Autorizar** (Chrome mostrará los sitios exactos) y luego **Iniciar turno**.

Las herramientas autorizadas se administran en la web: *Configuración → Herramientas de trabajo autorizadas*.

### Crear tu empresa real

```powershell
npm run seed -- --empresa "Nombre de la empresa" --admin tu@correo.com --nombre "Tu nombre"
```

Muestra una contraseña temporal que se cambia en el primer inicio de sesión.

### Operar la plataforma (gestionar empresas cliente)

```powershell
npm run seed -- --plataforma tu@correo.com
```

Da a esa cuenta el menú **Plataforma → Empresas**: crear empresas, suspenderlas, fijar límites del plan y
restablecer el acceso de sus administradores. Estos comandos se ejecutan con el servidor detenido.

## Producción (resumen)

- Define `DATABASE_URL` con un PostgreSQL real. Sin esa variable se usa PostgreSQL embebido (PGlite), pensado solo para desarrollo.
- `npm run build` compila la web; `npm run start` sirve API y web desde el mismo proceso.
- Sirve todo por HTTPS, define `NODE_ENV=production` y `WEB_ORIGINS` con el dominio público.
- En la extensión, cambia el servidor en el inicio de sesión (*Servidor*); Chrome pedirá permiso para ese dominio.

## Variables de entorno

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | Dónde escucha la API |
| `DATABASE_URL` | vacío (PGlite en `data/`) | Conexión a PostgreSQL |
| `DATA_DIR` | `./data` | Carpeta de la base embebida |
| `WEB_ORIGINS` | `http://localhost:5173` | Orígenes web permitidos |
| `OLYMPO_SECRET_KEY` | se genera en `data/secret.key` | Clave (32 bytes, base64) que cifra los tokens de integraciones. Obligatoria en producción |
| `API_URL` / `WEB_PORT` | `http://127.0.0.1:4000` / `5173` | Solo desarrollo web |

## Identidad visual

Sigue la "Propuesta visual 01" de OLYMPO (Obsidian, Electric Blue, Cloud, Slate y Argos Teal).

- **Colores, tipografías, radios y espaciados:** `apps/web/src/styles/tokens.css` (y el bloque `:root` de `apps/extension/ui.css`).
- **Logotipos:** `apps/web/src/components/brand.tsx`. Son una aproximación en SVG dibujada a partir de la propuesta;
  al tener los archivos oficiales se sustituyen ahí (y en `apps/extension/icons/`, `popup.html` y `apps/web/public/favicon.svg`).
- **Tipografía:** Montserrat para títulos y marca, alojada localmente (sin servicios externos).
- **Iconos:** `apps/web/src/components/Icon.tsx`.

Más detalle en [docs/argos-mvp.md](docs/argos-mvp.md).
