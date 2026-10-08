import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types/index'
import { bandLines, statusText, truncate } from './format'

function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    nivel: 'ok',
    generadoAt: '2026-10-08T15:30:00Z',
    checks: [],
    sha: 'abcdef123456',
    error: null,
    fetchedAt: 0,
    ...patch,
  }
}

test('formatea estados ok, aviso, error y sin conexión', () => {
  expect(statusText(snapshot())).toBe('🟢 Juanito ok')
  expect(
    statusText(
      snapshot({
        nivel: 'warn',
        checks: [{ key: 'cola', label: 'Cola', level: 'warn', count: 2, detail: 'Lenta' }],
      }),
    ),
  ).toBe('🟡 Juanito: 1 aviso(s)')
  expect(
    statusText(
      snapshot({
        nivel: 'error',
        checks: [
          { key: 'db', label: 'Base', level: 'error', count: 1, detail: 'Caída' },
          { key: 'api', label: 'API', level: 'error', count: 1, detail: 'Caída' },
        ],
      }),
    ),
  ).toBe('🔴 Juanito: 2 error(es)')
  expect(statusText(snapshot({ error: 'No alcanzo el dashboard' }))).toBe(
    '⚪ Juanito: sin conexión',
  )
})

test('oculta la banda cuando todo está bien', () => {
  expect(bandLines(snapshot())).toEqual([])
})

test('trunca detalles largos', () => {
  expect(truncate('123456789', 6)).toBe('12345…')
})

test('limita la banda e indica cuántas alertas faltan', () => {
  const checks = Array.from({ length: 6 }, (_, index) => ({
    key: `check-${index}`,
    label: `Check ${index}`,
    level: 'warn' as const,
    count: 1,
    detail: 'Revisar',
  }))
  const lines = bandLines(snapshot({ nivel: 'warn', checks }), 4)

  expect(lines.length).toBe(5)
  expect(lines[4]).toBe('… y 2 más')
})
