# Repesca automática y pausa de cuentas

Fecha: 2026-08-05
Estado: aprobado

## Problema

Cuando una ejecución termina, con frecuencia quedan puntos sin recoger y hay que
lanzar un run manual para recuperarlos. Las causas son varias y todas
intermitentes: créditos de Bing daily offers que llegan de forma asíncrona
después de que la cuenta ya se cerró, actividades que fallan una vez y
funcionarían al segundo intento, y cuentas que crashean a mitad de flujo.

Aparte, la exclusión de cuentas que ya existe (`excludedAccountIndexes` en
`config/schedule.json`) solo la respetan los runs de cron: el botón *Iniciar run*
del dashboard manda `POST /start {}` y ejecuta todas las cuentas, incluidas las
que el usuario creía haber apartado.

## Objetivo

1. Tras cada run, repescar automáticamente las cuentas que probablemente dejaron
   puntos, sin intervención manual.
2. Que apartar una cuenta signifique realmente que no se ejecuta, venga el run
   de donde venga.

## Alcance

Solo `API_MODE=true`, que es el modo en el que corre el despliegue. La ruta de
`npm start` pelado queda sin repesca automática: duplicar el bucle en el bot
supondría dos implementaciones del mismo comportamiento sin un consumidor real.

## Arquitectura

El servidor API ya tiene todas las piezas: [`ProcessManager`](../../../scripts/api/processManager.js)
emite `run-complete` con el estado del run parseado del log (puntos ganados,
éxito y error por cuenta), y `POST /start` ya sabe ejecutar un subconjunto de
cuentas vía `excludedAccountIndexes`.

Se añade una unidad nueva, **`rerunController`**, con dos partes separadas a
propósito:

- **Decisión (pura).** `decideNextPass({ entry, schedule, pass, stopped })`
  devuelve `{ shouldRerun, accountIndexes, delayMs, reason }`. Sin E/S, sin
  temporizadores, sin estado global: es la parte que se testea.
- **Orquestación.** Un objeto con estado que se suscribe a `run-complete`,
  consulta la decisión, programa el temporizador y llama a `pm.start()`.

`ProcessManager` no se modifica. Su máquina de estados describe un proceso hijo;
la cadena de pasadas es un concepto de nivel superior y mezclarlos volvería
ambiguo el `state !== 'idle'` que guarda `start()`.

### Flujo

```
run termina → run-complete → decideNextPass
                                  │
                    shouldRerun ──┴── no → cadena terminada
                          │
                          ↓
              temporizador (delayMs)
                          │
                          ↓
     relee schedule.json → pm.start({ env: exclusiones, RERUN_PASS: n })
```

El schedule se relee justo antes de arrancar, no en el momento de decidir: así,
pausar una cuenta durante el cooldown surte efecto en la pasada siguiente.

## Comportamiento de la repesca

**Conjunto de la siguiente pasada**: las cuentas de la pasada anterior que
ganaron puntos **o** terminaron en error. Las que ganaron puntos probablemente
tengan más pendiente; las que fallaron casi con seguridad dejaron puntos sin
tocar y hoy nadie las reintenta. Una cuenta que terminó bien con cero puntos
ganados ya no tiene nada que recoger y sale de la cadena.

Si el conjunto queda vacío, la cadena termina.

**Tope**: `maxPasses` cuenta **pasadas totales, incluida la principal**. El run
principal es la pasada 1 y hay repesca mientras `pass < maxPasses`, así que el
valor por defecto de 3 permite hasta 2 repescas automáticas.

**Numeración y reinicio de la cadena**: cualquier run que no haya arrancado el
propio controller (cron, botón del dashboard, `RUN_ON_START`) reinicia el
contador a 1. Así una cadena nunca hereda el contador de la anterior.

**Un run detenido a mano no dispara repesca.** Si el usuario pulsa parar, la
cadena muere ahí. El endpoint `/stop` marca la cadena como cancelada antes de
señalar al proceso, y esa marca —no la inspección del código de salida— es lo
que consulta el controller. Sondear `lastExit` no serviría: en Windows el árbol
se mata con `taskkill`, que devuelve un código de error sin señal, indistinguible
de un crash. Un `SIGTERM` externo al proceso hijo sí se detecta por señal, como
red de seguridad secundaria.

**Arrancar un run manualmente durante el cooldown** cancela el temporizador
pendiente: el run nuevo pasa a ser la cadena vigente, con el contador a 1.

Cada pasada se ejecuta como un proceso propio y aparece como un run
independiente en el historial. El bot recibe `RERUN_PASS=<n>` en el entorno y lo
incluye en la línea `RUN-START` y en el asunto del email de resumen; sin eso
llegarían varios correos indistinguibles.

## Pausa de cuentas

`excludedAccountIndexes` en `config/schedule.json` pasa a ser la única fuente de
verdad de «esta cuenta no se ejecuta».

- `POST /start` sin parámetros de selección pasa a significar «todas menos las
  pausadas» en lugar de «todas». Este es el cambio que arregla el botón
  *Iniciar run*.
- `POST /start {"excludedAccountIndexes": []}` explícito sigue ejecutándolas
  todas: una lista vacía enviada a propósito anula la pausa.
- `POST /start {"accountIndex": N}` ejecuta la cuenta aunque esté pausada. Pedir
  una cuenta por su índice es una orden explícita, no un descuido; la vista
  Cuentas marca el estado para que no sorprenda.
- La repesca nunca incorpora una cuenta pausada, ni siquiera si ganó puntos
  antes de que la pausaran.

En la interfaz, la vista **Cuentas** gana un conmutador *Pausada* por cuenta que
escribe el mismo campo que los chips de Programación. Los dos sitios editan el
mismo estado; no se introduce una segunda lista.

`buildStartBody()` de [`trigger.js`](../../../scripts/api/trigger.js) queda
redundante —el servidor ya aplica las exclusiones— y se elimina, con lo que la
lógica deja de estar duplicada en dos procesos.

## Configuración

En `schedule.json`, junto al resto de opciones de «cómo se ejecutan los runs»,
con el mismo patrón de override-de-fichero-sobre-defecto-de-entorno que ya usa
`cron`:

```json
"autoRerun": { "enabled": true, "delayMinutes": 5, "maxPasses": 3 }
```

Defectos por entorno cuando el fichero no trae override:
`AUTO_RERUN`, `AUTO_RERUN_DELAY_MINUTES`, `AUTO_RERUN_MAX_PASSES`. Editable desde
la vista Programación.

Validación, coherente con la que ya aplica `readSchedule` al resto de campos:
`enabled` booleano, `delayMinutes` entero de 1 a 120, `maxPasses` entero de 1 a
10. Un valor fuera de rango es `CORRUPT_SCHEDULE`, igual que un cron inválido.
`maxPasses: 1` desactiva la repesca de facto y es un valor legítimo.

## Estado y visibilidad

Durante el cooldown el proceso hijo no existe, así que `GET /status` devolvería
`idle` y [`trigger.js`](../../../scripts/api/trigger.js) daría el run por
terminado y soltaría el lockfile de cron a mitad de cadena. Peor aún, el
siguiente disparo de cron podría solaparse con la repesca.

El servidor compone el estado que publica: cuando el proceso está ocioso pero
hay una pasada programada, `state` es `cooldown` y la respuesta incluye

```json
"rerun": { "pass": 1, "maxPasses": 3, "nextPassAt": "…", "accountIndexes": [1,3] }
```

`trigger.js` trata `cooldown` como «aún no ha terminado» y sigue sondeando; su
timeout de `STUCK_PROCESS_TIMEOUT_HOURS` (8 h por defecto) cubre la cadena
completa. Las dos vistas de la interfaz que comprueban si hay actividad
(`resumen.js`, `cuentas.js`) añaden `cooldown` a esa comprobación, de modo que
los botones siguen deshabilitados y se muestra la cuenta atrás.

El controller registra sus decisiones con la etiqueta `AUTO-RERUN` a través de
`pm.note()`, con lo que aparecen tanto en `docker logs` como en el visor de logs
del dashboard.

## Errores

Todo lo del controller es best-effort y nunca tumba el servidor:

- `schedule.json` corrupto → se registra el aviso y **no** se repesca. Ante la
  duda es preferible no ejecutar a ejecutar cuentas que el usuario pausó.
- `pm.start()` devuelve `ALREADY_RUNNING` → se abandona la cadena con un aviso;
  otra cosa arrancó y esa pasa a ser la ejecución vigente.
- `SIGTERM`/`SIGINT` al contenedor → se cancela el temporizador pendiente.
- Los índices de cuenta se releen frescos en cada pasada, para que un borrado de
  cuenta a mitad de cadena (que renumera los slots) no acabe ejecutando la
  cuenta equivocada.

## Pruebas

Sobre `decideNextPass`, con `node:test` como el resto de `scripts/api`:

- pasada sin puntos ni errores → no repesca
- solo algunas cuentas ganaron → la siguiente pasada las contiene solo a ellas
- cuenta con error y cero puntos → entra en la repesca
- `pass === maxPasses` → no repesca; `pass < maxPasses` → sí
- cuenta pausada → nunca entra, aunque ganara puntos
- run detenido a mano → no repesca
- `autoRerun.enabled === false` → no repesca

Sobre el resto:

- `readSchedule`/`writeSchedule` con `autoRerun`: defectos, override, valores
  inválidos rechazados
- `POST /start` sin selección aplica las exclusiones persistidas
- `POST /start` con `excludedAccountIndexes: []` explícito las ignora
- el estado compuesto informa `cooldown` mientras hay una pasada pendiente

## Fuera de alcance

- Repesca fuera de `API_MODE`.
- Repesca condicionada a los puntos que el dashboard declara pendientes
  (`Earnable today`): la señal existe pero no es fiable como criterio de parada,
  y el criterio acordado es «mientras siga ganando».
- Cooldown variable o backoff entre pasadas.
