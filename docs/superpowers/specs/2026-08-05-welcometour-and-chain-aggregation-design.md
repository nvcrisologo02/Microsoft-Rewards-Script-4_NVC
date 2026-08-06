# Reclamación de welcometour y agregación de cadenas en Cuentas

Fecha: 2026-08-05
Estado: aprobado

## Problema

Tres cosas que salieron a la luz en la primera ejecución con repesca automática
(2026-08-05, ver [la repesca](2026-08-05-auto-rerun-and-account-pause-design.md)):

1. `ACTIVITY-GAPS` reportó un tipo de actividad sin soportar que **sí da
   puntos**: `welcometour`, 50 puntos, `offerId=Gamification_FRE_Offer6nonwindows`,
   título «Realice el paseo». Aparece solo en móvil y solo en las tres cuentas
   más nuevas — es el tour de bienvenida, una sola vez por cuenta. Son 150
   puntos parados hoy, y volverá a aparecer con cada cuenta nueva.

2. En la vista Cuentas, «Último run» sale **0 en las nueve cuentas**. La causa
   es la repesca: la última pasada de una cadena es, por construcción, la que ya
   no encuentra nada. Mirar solo el último proceso es mirar precisamente la
   pasada seca.

3. En cinco cuentas desapareció el contador de racha. **Los datos no se han
   perdido**: el historial guarda `streakProtection` en 24–42 registros por
   cuenta. Lo que falla es la lectura — `mergeAccountStats` se queda con el
   primer registro cuyo objeto `streakProtection` no es nulo, aunque el
   `streakCounter` de dentro venga a `null`. En esas cuentas los registros
   recientes traen `cnt=null, cnt=null, cnt=21, cnt=21`: el 21 sigue ahí, dos
   posiciones más atrás. Las repescas destaparon el fallo al añadir registros
   por delante, pero el fallo ya existía.

## Alcance

Los tres puntos van juntos porque los dos últimos comparten el mismo camino de
datos (historial → `mergeAccountStats` → vista Cuentas) y el primero es
independiente pero pequeño. La vista Ejecuciones **no se toca**: ahí sí interesa
ver cada pasada por separado, con su duración y su resultado.

## 1. Reclamación del welcometour

Las mecánicas son las mismas que las de un `urlreward`: reportar el offer con la
acción de servidor `reportActivity`. Por eso no se escribe un módulo casi
duplicado, sino que se parametriza el que ya existe.

`UrlReward.doUrlReward(promotion, options?)` acepta un segundo argumento
opcional `{ source, tag }`, con los valores de hoy por defecto
(`source: 'activity'`, `tag: 'URL-REWARD'`). El `source` es el que ya usa
[`reportOfferActivity`](../../../src/functions/activities/api/ReportPromotion.ts)
para atribuir los puntos en el desglose `bySource`, y el `tag` es la etiqueta de
log.

En el switch de [`Workers.solveActivities`](../../../src/functions/Workers.ts) se
añade:

```
case 'welcometour':  →  doUrlReward(promotion, { source: 'welcomeTour', tag: 'WELCOME-TOUR' })
```

gobernado por un flag nuevo `activities.welcomeTour`, por defecto `true`, con el
mismo tratamiento que `quiz` y `linkOffers`.

Esa atribución propia es lo que hace verificable el resultado: si la línea
`bySource=` de la cuenta incluye `welcomeTour 50`, la acción de servidor basta.
Si el log dice que no acredita, se añade el recorrido en navegador ya sabiendo
contra qué se pelea — el mismo camino incremental que se siguió con el quiz.

Al ser un offer de una sola vez, en cuanto se reclama deja de ser reportable y el
filtrado que ya existe lo descarta. No hace falta ninguna lógica de «cuenta
nueva».

La heurística `isNonCrediting` de `UrlReward` no estorba: sale por `false` en
cuanto los puntos son mayores que cero, y aquí son 50.

## 2. Agregación de cadenas en Cuentas

Cada registro del historial gana dos campos:

- `chainId`: el `startedAt` de la primera pasada de la cadena. Las pasadas
  siguientes lo heredan.
- `pass`: el número de pasada, 1-based.

El `RerunController` es quien los conoce. Mantiene un `chainId` que
`noteExternalStart()` limpia y que se fija en el primer `run-complete` posterior
(cuando aún vale `null`) al `startedAt` de ese registro. Se expone en
`getState()` para que `server.js` lo estampe en `toHistoryRecord`.

**Los 51 registros que ya existen no tienen `chainId`.** Un registro sin ese
campo cuenta como una cadena de una sola pasada, con lo que el historial
histórico sigue leyéndose bien y no hay que migrar nada.

`mergeAccountStats` agrupa los registros de cada cuenta por cadena antes de
calcular, conservando el orden de más reciente a más antigua. Por cadena:

| Campo       | Cómo se agrega                                     |
| ----------- | -------------------------------------------------- |
| `collected` | suma de todas las pasadas                           |
| `balance`   | el último valor no nulo                             |
| `success`   | el de la última pasada de la cadena                 |
| `error`     | el de la última pasada de la cadena                 |
| `when`      | el `endedAt` más reciente de la cadena              |

Con eso, `lastCollected` pasa a ser el total de la última cadena (los +20 de hoy
en vez de 0), `runs` cuenta cadenas en lugar de procesos —que es lo que un
humano entiende por «ejecución»— y `successStreak` cuenta cadenas consecutivas
correctas. `totalCollected` no cambia de valor: sumar pasadas y sumar cadenas dan
lo mismo.

## 3. Arreglo del contador de racha

Hoy hay una sola búsqueda de la que cuelgan dos datos. Se separan en dos
búsquedas independientes, cada una retrocediendo hasta el registro más reciente
que de verdad tenga el dato:

- `streakProtection`: el primer objeto no nulo (comportamiento actual, del que
  salen `enabled` y `remainingDays`).
- `streakCounter`: el primer `streakProtection.streakCounter` no nulo, buscado
  por separado.

Mantenerlas separadas evita mezclar épocas en los campos de protección y hace
que el contador no pueda volver a quedar oculto tras un registro con el objeto
presente pero el contador vacío. La búsqueda recorre todas las cadenas, no solo
la última, así que una cadena entera con contadores nulos tampoco lo esconde.

## Pruebas

`mergeAccountStats` es pura y hoy no tiene ninguna cobertura. Se estrena
`scripts/api/accounts.test.js`:

- agregación por cadena: tres pasadas con 30/20/0 puntos dan una cadena de 50
- registros antiguos sin `chainId`: cada uno es su propia cadena
- mezcla de registros con y sin `chainId`
- `runs` cuenta cadenas, no pasadas
- el contador de racha se recupera cuando los registros recientes lo traen a
  `null` pero uno anterior no
- `streakProtection` y `streakCounter` se resuelven de forma independiente
- `totalCollected` no varía al reagrupar

Sobre el welcometour, en `src/functions/WelcomeTour.test.ts`:

- el origen de atribución es `welcomeTour` y la etiqueta `WELCOME-TOUR`
- ese origen no es el genérico `activity`, que es lo que permite distinguirlo en
  el desglose `bySource`

El despacho en sí —que el `case 'welcometour'` enrute al camino de reporte y que
con el flag desactivado haga `continue` en vez de caer en `default` y contarse
como hueco en `ACTIVITY-GAPS`— no se cubre con prueba unitaria: ejercitar ese
`switch` exige instanciar el bot entero con navegador y sesión. Queda cubierto
por revisión del código y, sobre todo, por el log del primer run: si aparece
`Found activity type "WelcomeTour"` y `welcometour` desaparece de
`ACTIVITY-GAPS`, el despacho funciona. La atribución propia existe precisamente
para que ese log sea concluyente.

Sobre el `chainId`, en `scripts/api/rerunController.test.js`:

- la primera pasada fija el `chainId` a su propio `startedAt`
- las pasadas siguientes lo heredan
- `noteExternalStart()` lo limpia, de modo que la cadena siguiente estrena uno

## Fuera de alcance

- Agrupar cadenas en la vista Ejecuciones: ahí interesa el detalle por pasada.
- Migrar los 51 registros existentes para darles `chainId`.
- El recorrido del tour en navegador, hasta saber si la acción de servidor basta.
