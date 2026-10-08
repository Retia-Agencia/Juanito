import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HealthCheck, Level, Snapshot } from '../types/index'
import { bandLines, icon, statusText, truncate } from './format'

const BASE = 'https://juanito.tail2df10b.ts.net'
const PANE = 'juanito'
const POLL_MS = 60_000
const TIMEOUT_MS = 10_000
const UNREACHABLE = 'No alcanzo el dashboard (¿Tailscale prendido?)'

const initial: Snapshot = {
  nivel: 'ok',
  generadoAt: '',
  checks: [],
  sha: '',
  error: null,
  fetchedAt: 0,
}

const snapshotState = atom(
  { plugin: 'juanito-status', key: 'snapshot' } as const,
  initial,
)

type HealthResponse = {
  nivel: Level
  generadoAt: string
  checks: HealthCheck[]
}

type MetaResponse = { sha: string }

function withTimeout<T>($: EngineInterface, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = $.clock.after(TIMEOUT_MS, () => reject(new Error('timeout')))
    work.then(
      value => {
        timeout.cancel()
        resolve(value)
      },
      error => {
        timeout.cancel()
        reject(error)
      },
    )
  })
}

async function getJson<T>($: EngineInterface, path: string): Promise<T> {
  const response = await $.http.fetch(`${BASE}${path}`, { method: 'GET' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return JSON.parse(response.text) as T
}

async function refresh($: EngineInterface): Promise<void> {
  const previous = await read($, snapshotState)

  try {
    const [health, meta] = await withTimeout(
      $,
      Promise.all([
        getJson<HealthResponse>($, '/api/salud'),
        getJson<MetaResponse>($, '/api/meta'),
      ]),
    )
    const next: Snapshot = {
      nivel: health.nivel,
      generadoAt: health.generadoAt,
      checks: health.checks,
      sha: meta.sha,
      error: null,
      fetchedAt: await $.clock.now(),
    }
    await $.state.set(snapshotState, next)
    $.ui.status(statusText(next))
  } catch {
    const next = { ...previous, error: UNREACHABLE, fetchedAt: await $.clock.now() }
    await $.state.set(snapshotState, next)
    $.ui.status(statusText(next))
  }
}

function generatedTime(value: string): string {
  if (!value) return '--:--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--'
  return date.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'juanito',
      description: 'Muestra el estado de salud de Juanito',
    })
    // Sin await: si el dashboard no responde, la sesión no espera los 10 s del timeout.
    void refresh($)
    $.clock.every(POLL_MS, () => {
      void refresh($)
    })

    return next(e)
  })

  on('command.run', { command: 'juanito' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Juanito' })
    return { text: 'Panel de Juanito abierto.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const lines = bandLines(await read($, snapshotState))
    if (lines.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text key={`juanito-${index}`}>{line}</Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snapshot = await read($, snapshotState)
    const overall = snapshot.error ? '⚪' : icon(snapshot.nivel)

    return (
      <Box flexDirection="column">
        <Text>
          {overall} generado {generatedTime(snapshot.generadoAt)} · deploy{' '}
          {snapshot.sha ? snapshot.sha.slice(0, 7) : '-------'}
        </Text>
        {snapshot.error && <Text>⚪ {snapshot.error}</Text>}
        {snapshot.checks.map(check => (
          <Text key={check.key} dimColor={check.level === 'ok'}>
            {icon(check.level)} {check.label} — {truncate(check.detail)}
          </Text>
        ))}
      </Box>
    )
  })
}
