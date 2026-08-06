# Reclamación del welcometour en navegador

Fecha: 2026-08-06
Estado: aprobado

## Problema

El [despacho del welcometour](2026-08-05-welcometour-and-chain-aggregation-design.md)
funciona —el log dice `Found activity type "WelcomeTour"` y el tipo ya no
aparece en `ACTIVITY-GAPS`— pero no cobra:

```
[WELCOME-TOUR] Skipping Gamification_FRE_Offer6nonwindows:
not present in page snapshot, even after refetching /earn and /dashboard
```

La apuesta era que se reclamaría con la misma acción de servidor que un
`urlreward`. No sale, y el motivo es anterior al reporte: el offer aparece en la
API del dashboard pero **no en el snapshot de `/earn`**, que es de donde
`ensureOffer` saca el hash que la acción de servidor necesita. Vive fuera de la
lista normal de ofertas.

Son 50 puntos por cuenta nueva, hoy 150 parados en pepelu997, pepelu998 y
pepelu999, y volverá a aparecer con cada cuenta que se cree.

## Objetivo

Cobrarlo por navegador, y —si no se cobra— registrar lo suficiente para que la
siguiente iteración sea quirúrgica en vez de otra apuesta a ciegas.

## Alcance

No se sabe qué hay detrás del tour ni a dónde apunta su `destinationUrl`: el log
actual no lo vuelca. El alcance elegido es **visitar y observar**, no recorrer el
tour a ciegas. Visitar una URL estando logueado es exactamente lo que ya hace
`LINK-OFFERS`, es de riesgo bajo, y muchas ofertas FRE acreditan solo con eso.
Clicar interfaz nunca vista queda fuera hasta tener el DOM delante.

## Arquitectura

Un módulo nuevo `src/functions/activities/browser/WelcomeTour.ts`, que es donde
viven las actividades de navegador. El `case 'welcometour'` de
`Workers.solveActivities` pasa a llamarlo a él en lugar de a `doUrlReward`
directamente.

Dos fases, al estilo del solver de quiz:

### Fase 1 — acción de servidor, en silencio

Sigue intentando `doUrlReward(promotion, welcomeTourOptions())`. Hoy falla, pero
cuesta cero y **se auto-cura**: si Microsoft añade el offer al snapshot algún
día, se cobrará solo sin tocar nada. Como `doUrlReward` no informa de si
acreditó, la fase se mide comparando el balance antes y después.

### Fase 2 — visitar y observar

Si la fase 1 no sumó:

1. Resolver el destino con `resolveTourDestination(promotion)`. Si devuelve
   `null` —vacío, relativo, o un esquema que no es `http(s)`— se avisa con el
   `offerId` y se termina. Navegar a ciegas no es una opción.
2. Navegar la página **móvil** (el offer solo aparece en móvil) con
   `domcontentloaded` y 30 s de timeout.
3. Esperar 8–12 s, el mismo margen que usa `LINK-OFFERS`.
4. **Registrar lo observado**: URL final tras redirecciones, título de la página
   y si hay algún contenedor reconocible de tour. Este es el payload que hace
   quirúrgica la siguiente vuelta.
5. Asentar 20–30 s antes de releer los puntos: los créditos FRE pueden llegar con
   retraso, igual que las ofertas de Bing.
6. Si sumó, `creditPoints('welcomeTour', gained, newBalance)` y línea verde. Si
   no, un aviso que incluye lo observado en el paso 4.
7. Volver siempre a un origen seguro, y que ningún fallo rompa el run de la
   cuenta.

## Idempotencia

No hace falta ledger. Es un offer de una sola vez: en cuanto queda `complete`, el
filtrado de aguas arriba lo descarta. Si nunca llega a acreditar se reintentará
una navegación por run, que es barato y acotado, y el aviso lo dirá cada vez.

## Configuración

Reutiliza el flag `activities.welcomeTour` que ya existe. No hay claves nuevas.

## Errores

Todo el módulo va envuelto: un fallo de navegación, un timeout o una página
inesperada se registran y devuelven el control, nunca abortan la cuenta. La
lectura de puntos usa `getCurrentPoints`, que ya tolera fallos.

## Pruebas

La superficie testeable es fina y conviene decirlo: la navegación no se puede
probar sin navegador, igual que la fase 3 del quiz, que tampoco tiene pruebas
unitarias. Lo que sí se extrae y se cubre es `resolveTourDestination`, en
`src/functions/WelcomeTour.test.ts` junto a las pruebas que ya existen:

- una URL `https` válida se devuelve tal cual
- `http` también vale
- cadena vacía, sólo espacios, o `undefined` → `null`
- una URL relativa (`/earn/tour`) → `null`
- un esquema que no es http (`javascript:`, `file:`) → `null`
- espacios alrededor se recortan

La verificación real es el log del siguiente run.

## Fuera de alcance

- Clicar el tour (siguiente/hecho/cerrar) hasta tener el DOM observado.
- Cualquier flag de configuración nuevo.
- Reintentos más allá de la navegación única por run.
