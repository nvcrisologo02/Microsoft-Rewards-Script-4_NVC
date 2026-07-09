import test from 'node:test'
import assert from 'node:assert/strict'

import { formatRunSummary, AccountSummary } from './RunSummary'

const rows: AccountSummary[] = [
    { email: 'pupela_32@outlook.com', collectedPoints: 285, finalPoints: 26831, durationSeconds: 252, success: true },
    { email: 'nvcrisologo02@gmail.com', collectedPoints: 0, finalPoints: 0, durationSeconds: 12, success: false }
]

test('incluye una fila por cuenta con ganados y total', () => {
    const out = formatRunSummary(rows, 300)
    assert.ok(out.includes('pupela_32@outlook.com'), 'aparece la 1ª cuenta')
    assert.ok(out.includes('nvcrisologo02@gmail.com'), 'aparece la 2ª cuenta')
    assert.ok(out.includes('+285'), 'ganados con signo +')
    assert.ok(out.includes('26.831'), 'total con separador de miles')
})

test('marca OK y FALLO según success', () => {
    const out = formatRunSummary(rows, 300)
    const lines = out.split('\n')
    const okLine = lines.find(l => l.startsWith('pupela_32@outlook.com'))
    const failLine = lines.find(l => l.startsWith('nvcrisologo02@gmail.com'))
    assert.ok(okLine && okLine.trimEnd().endsWith('OK'), 'la cuenta con éxito termina en OK')
    assert.ok(failLine && failLine.trimEnd().endsWith('FALLO'), 'la cuenta fallida termina en FALLO')
})

test('fila TOTAL: sumas, runtime y recuento k/N OK', () => {
    const out = formatRunSummary(rows, 300)
    const totalLine = out.split('\n').find(l => l.startsWith('TOTAL'))
    assert.ok(totalLine, 'existe la fila TOTAL')
    assert.ok(totalLine!.includes('+285'), 'total ganados = suma')
    assert.ok(totalLine!.includes('26.831'), 'total final = suma')
    assert.ok(totalLine!.includes('5.0m'), 'Dur = runtime total (300s → 5.0m)')
    assert.ok(totalLine!.includes('1/2 OK'), 'recuento de éxitos')
})

test('cabecera con el número de cuentas', () => {
    const out = formatRunSummary(rows, 300)
    assert.ok(out.includes('(2 cuentas)'), 'cabecera con N')
})

test('agrupación de miles: 0, 1273, 135532', () => {
    const out = formatRunSummary(
        [{ email: 'a@x.com', collectedPoints: 1273, finalPoints: 135532, durationSeconds: 60, success: true }],
        60
    )
    assert.ok(out.includes('+1.273'), '1273 → 1.273')
    assert.ok(out.includes('135.532'), '135532 → 135.532')

    const zero = formatRunSummary(
        [{ email: 'a@x.com', collectedPoints: 0, finalPoints: 0, durationSeconds: 0, success: true }],
        0
    )
    assert.ok(zero.includes('+0'), 'ganados 0 → +0')
})

test('filas de datos y TOTAL alineadas al mismo ancho', () => {
    const out = formatRunSummary(rows, 300)
    const lines = out.split('\n')
    const dataLines = lines.filter(
        l => l.startsWith('pupela_32') || l.startsWith('nvcrisologo02') || l.startsWith('TOTAL')
    )
    assert.equal(dataLines.length, 3, 'dos cuentas + TOTAL')
    const widths = new Set(dataLines.map(l => l.length))
    assert.equal(widths.size, 1, 'todas las filas de datos tienen el mismo ancho')
})

test('rows vacío no lanza y produce cabecera + TOTAL', () => {
    const out = formatRunSummary([], 0)
    assert.ok(out.includes('(0 cuentas)'), 'cabecera con 0')
    assert.ok(out.includes('TOTAL'), 'fila TOTAL presente')
    assert.ok(out.includes('0/0 OK'), 'recuento 0/0')
})
