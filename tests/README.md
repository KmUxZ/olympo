# Pruebas de OLYMPO

Comprueban que la plataforma sigue haciendo lo que debe después de cada cambio.

## Cómo correrlas

```
npm test                       todas
npm test -- hermes hoko        solo las que se nombren
npm test -- --lista            ver cuáles hay y qué cubre cada una
npm test -- hermes --detalle   mostrar la salida completa de una que falla
```

Al final dice cuántas pasan. Si alguna falla, muestra qué comprobación falló y el comando termina con error.

**Antes de subir un cambio, corre `npm test`.** Si tocaste una sola parte, puedes correr solo sus pruebas mientras
trabajas, pero la batería completa antes de subir.

## Qué garantizan sobre los datos

- Cada prueba usa una **base de datos temporal nueva**, que se borra al terminar. No tocan la base de desarrollo ni producción.
- El servidor de prueba arranca apuntando a **servicios simulados**. No puede escribirle a Hoko, a Pancake, a Google
  ni a la IA reales, aunque la máquina tenga sus credenciales: el lanzador se las quita antes de arrancar.
- Necesitan libre el puerto `4100`. Los simuladores usan `4191` (Hoko), `4192` (Google), `4199` (Pancake) y `4200` (IA).

## Cómo están organizadas

| Carpeta | Qué hay |
|---|---|
| `run.mjs` | El lanzador: crea la base temporal, arranca el servidor, corre la prueba y limpia |
| `suites.mjs` | La lista de pruebas, con qué necesita cada una |
| `api/` | Pruebas que le hablan al servidor por HTTP, como lo haría la web |
| `directo/` | Pruebas que usan el código del servidor sin arrancarlo (reglas, tareas programadas) |
| `prep/` | Datos que algunas pruebas necesitan antes de empezar |
| `fixtures/` | Copias de los formularios de Google, para probar sin consultar a Google |

## Cómo añadir una prueba

1. Crea el archivo en `api/` o `directo/`. Copia la cabecera de una parecida.
2. Cada comprobación imprime una línea que empieza por `OK  ` o por `FAIL`.
3. Al final imprime `TODO OK` si todo pasó, y termina con código distinto de cero si algo falló.
4. Añádela a `suites.mjs` con un nombre y una frase que diga qué cubre.

Una regla: **cada error que se corrija debe dejar una comprobación** que lo habría detectado. Así no vuelve.

## La prueba de seguridad

`seguridad` saca el inventario de rutas del código cada vez que corre. Una ruta nueva entra sola: si se publica sin
protección, la prueba falla. Si la ruta de verdad debe ser pública, hay que añadirla a la lista `PUBLIC` de
`api/sec.mjs`, y ese cambio queda a la vista en la revisión.
