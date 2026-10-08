export type Level = 'ok' | 'warn' | 'error'

export type HealthCheck = {
  key: string
  label: string
  level: Level
  count: number
  detail: string
}

export type Snapshot = {
  nivel: Level
  generadoAt: string
  checks: HealthCheck[]
  sha: string
  error: string | null
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'juanito-status': { snapshot: Snapshot }
  }
}
