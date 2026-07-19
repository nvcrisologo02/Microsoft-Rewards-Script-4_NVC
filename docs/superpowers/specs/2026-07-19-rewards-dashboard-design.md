# Rewards Control — Dashboard GUI (Diseño)

Fecha: 2026-07-19
Estado: aprobado en conversación de brainstorming

## Objetivo

Dashboard web moderno y sencillo para arrancar el bot, seguir su ejecución en vivo y
gestionar cuentas y configuración, apoyado en la Control API existente
(`scripts/api/`). Decisiones tomadas con el usuario:

1. **Entrega:** SPA estática servida por la propia Control API (sin proceso extra).
2. **Cuentas:** CRUD completo desde el GUI (escritura de `.env` tras opt-in).
3. **Historial:** persistente en fichero, con gráficas de evolución.

## Análisis de partida

La Control API ya cubre: start/stop/restart, `/status`, `/points`, `/logs`,
SSE `/events`, `/history` (memoria), `/accounts` (lectura), `/sessions` (+ borrado
por cuenta), `/config` (lectura y escritura validada opt-in), `/schedule` (lectura
y escritura opt-in), `/diagnostics`.

Huecos a cubrir:

| Hueco | Solución |
|---|---|
| Sin interfaz gráfica | SPA estática servida en `/ui` por `server.js` |
| Cuentas solo lectura (`.env`) | Endpoints CRUD nuevos con `API_ALLOW_ACCOUNT_WRITE=true`, escritura atómica de `.env` + backup `.env.bak` |
| Historial solo en memoria | Anexado NDJSON en `data/history.ndjson` al completar cada run |
| Sin gráficas | El frontend las construye desde el historial persistido (uPlot) |

## Arquitectura

```
Navegador ──HTTP/SSE──▶ Control API (127.0.0.1:3010)
   │  SPA /ui                 ├─ arranca/detiene el bot (child process)
   │  token Bearer            ├─ parsea logs → estado y puntos en vivo
   └─ EventSource /events     ├─ NUEVO: sirve la SPA estática (scripts/api/ui/)
                              ├─ NUEVO: CRUD cuentas → .env (atómico + .bak)
                              └─ NUEVO: historial → data/history.ndjson
```

### Stack frontend

**Preact + htm sin paso de build**, vendorizado como ficheros estáticos en
`scripts/api/ui/` (ESM). Gráficas con **uPlot** vendorizado. Mantiene la filosofía
de la API: cero dependencias de runtime, cero build; `npm run api` y abrir el
navegador.

Alternativas descartadas: vanilla JS puro (difícil de mantener con 7 vistas y
estado en vivo) y React+Vite como proyecto aparte (build y despliegue extra sin
justificación aquí).

### Extensiones de API (backend)

- `GET /ui/*` — estáticos de la SPA (sin token para los assets; las llamadas de
  datos siguen exigiendo token).
- `GET /accounts/full` *(opt-in + reveal explícito no incluye nunca password/TOTP;
  devuelve solo metadatos editables no sensibles)*.
- `POST /accounts`, `PUT /accounts/:index`, `DELETE /accounts/:index` — requieren
  `API_ALLOW_ACCOUNT_WRITE=true`. Escriben `.env` de forma atómica (tmp + rename)
  con copia previa a `.env.bak`. Password y TOTP son *write-only*: se aceptan en
  el body, jamás se devuelven. Renumeración densa de slots al borrar.
- Persistencia de historial: al finalizar un run, `processManager` anexa el
  registro (el mismo shape que `/history`) a `data/history.ndjson`;
  `GET /history?persisted=1` lee del fichero con paginación.

## Pantallas

Layout: sidebar izquierda (7 secciones) + topbar fija con pastilla de estado
(`idle/running/stopping`), puntos de la sesión y botón primario Start/Stop.

1. **Resumen** — Start/Stop/Restart (con "solo cuenta X" / "excluir cuentas"),
   4 KPI cards (puntos hoy, balance total, cuentas OK/fallo, próximo cron),
   progreso del run activo (cuenta actual + barra), mini-feed de errores.
2. **Cuentas** — tabla (email, locale, puntos, racha, sesiones desktop/mobile,
   último resultado); acciones por fila: ejecutar solo esta, editar, borrar
   sesiones, eliminar. Modal alta/edición con campos de `.env`; secretos
   enmascarados y write-only.
3. **Ejecuciones** — historial persistente; lista de runs (duración, puntos,
   resultado por cuenta), detalle expandible, gráficas: balance por cuenta y
   puntos/día.
4. **Logs** — consola en vivo (SSE) con autoscroll, filtros nivel/cuenta/
   plataforma, búsqueda, pausa, descarga.
5. **Configuración** — formularios agrupados por secciones de `config.json` +
   pestaña "JSON avanzado"; diff antes de guardar; validación con el validador
   real del bot (422 → errores por campo).
6. **Programación** — editor de cron con presets, vista "próximas 5 ejecuciones",
   timezone (solo lectura), exclusión de cuentas.
7. **Diagnósticos** — galería de capturas (screenshot, error.txt, dump.html)
   enlazadas desde el run fallido.

Acceso: si `API_TOKEN` está configurado, vista de login que pide el token una vez
y lo guarda en el navegador (localStorage).

## Guías de diseño

- Tono: panel de operaciones sobrio y calmado. Referencias: Grafana, Vercel,
  Portainer.
- Tema oscuro por defecto (fondo `#0f1115`, superficies `#171a21`, borde sutil
  1px, radio 12px); tema claro disponible; respeta `prefers-color-scheme`.
- Color: acento único azul `#3b82f6`; éxito/puntos `#22c55e`; warning `#f59e0b`;
  error `#ef4444`; idle gris. El color nunca es el único indicador (icono+texto,
  AA).
- Tipografía: `Inter, system-ui`; monoespaciada para logs, emails y cifras.
- Componentes: cards con borde en vez de sombra; filas de tabla 44px; acciones
  destructivas con confirmación; toasts; skeletons en carga.
- Datos en vivo: transición suave de color al actualizarse un valor; sin
  parpadeos.
- Responsive: sidebar colapsable a iconos < 1024px; en móvil, consultar estado y
  parar el bot.

## Casos de uso

1. Arranque supervisado con seguimiento de puntos en vivo.
2. Run selectivo de una sola cuenta desde su fila.
3. Alta de cuenta (email/password/TOTP/proxy) con reescritura segura de `.env`.
4. Borrado de sesiones caducadas y relanzamiento.
5. Cambio de horario cron con presets y vista de próximas ejecuciones.
6. Investigación de fallo saltando del run al diagnóstico (screenshot/HTML).
7. Seguimiento a largo plazo: gráfica de balance 90 días por cuenta.
8. Ajuste de workers/comportamiento desde formularios sin editar JSON.

## Seguridad

- Loopback por defecto; token obligatorio si se expone.
- Cada capacidad de escritura tras su opt-in: `API_ALLOW_CONFIG_WRITE`,
  `API_ALLOW_SCHEDULE_WRITE`, `API_ALLOW_ACCOUNT_WRITE` (nuevo).
- Secretos write-only en toda la API; máscara en UI.
- Backup antes de cada escritura (`.env.bak`, `config.json.bak`).
- Confirmación explícita para acciones destructivas (borrar cuenta/sesiones).

## Manejo de errores

- API caída → banner de reconexión con reintento exponencial del SSE.
- 401 → volver a la vista de token.
- 409 (run activo) → la UI deshabilita acciones conflictivas según estado.
- 422 en config → errores mapeados a campos del formulario.
- Escritura de `.env` fallida → se conserva el original; error visible en toast.

## Testing

- Backend: tests de nodo (node:test) para el módulo de escritura de `.env`
  (round-trip, atomicidad, renumeración, no-fuga de secretos) y para el anexado
  y lectura de historial NDJSON.
- Frontend: smoke test de arranque de la SPA contra la API en modo mock; el resto
  se valida manualmente en Fase 1 (alcance pragmático, sin framework de e2e).

## Fases

1. **Ver y controlar** — servir SPA en `/ui`, login por token, Resumen, Logs en
   vivo, Cuentas solo lectura, start/stop/restart. (Solo requiere servir
   estáticos; el resto de la API ya existe.)
2. **Gestionar** — CRUD de cuentas (endpoints nuevos + `.env`), editor de
   configuración y programación.
3. **Seguimiento profundo** — historial NDJSON persistente, gráficas uPlot,
   diagnósticos integrados.

## Prompt para generador de imágenes

> High-fidelity UI design of a modern desktop web dashboard for an automation bot
> called "Rewards Control", dark theme (#0f1115 background, #171a21 surface cards,
> subtle 1px borders, 12px rounded corners), left sidebar navigation with icons and
> labels (Overview, Accounts, Runs, Logs, Config, Schedule, Diagnostics), top bar
> with a green "RUNNING" status pill, live points counter "12,480 pts" in monospace
> font, and a prominent blue "Stop" button. Main content: a row of 4 KPI stat cards
> (Points today +312, Total balance, Accounts 4/5 OK, Next run 07:00), below it a
> progress panel showing the currently processing account with a progress bar, and
> a line chart of points growth over 30 days with a blue line and soft gradient
> fill. Right column shows a live log console with colored log levels on dark
> monospace background. Accent color #3b82f6 blue, success green #22c55e, error red
> #ef4444, Inter typeface, clean spacing, information-dense but calm, inspired by
> Grafana and Vercel dashboard aesthetics, Figma-style UI mockup, 16:10 screen, no
> watermark.
