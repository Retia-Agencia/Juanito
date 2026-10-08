import type { Level, Snapshot } from '../types/index'

export function icon(level: Level): string {
  if (level === 'error') return '🔴'
  if (level === 'warn') return '🟡'
  return '🟢'
}

export function truncate(text: string, max = 100): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function statusText(snapshot: Snapshot): string {
  if (snapshot.error) return '⚪ Juanito: sin conexión'

  const errors = snapshot.checks.filter(check => check.level === 'error').length
  if (snapshot.nivel === 'error' || errors > 0) {
    return `🔴 Juanito: ${errors} error(es)`
  }

  const warnings = snapshot.checks.filter(check => check.level === 'warn').length
  if (snapshot.nivel === 'warn' || warnings > 0) {
    return `🟡 Juanito: ${warnings} aviso(s)`
  }

  return '🟢 Juanito ok'
}

export function bandLines(snapshot: Snapshot, max = 4): string[] {
  if (!snapshot.error && snapshot.nivel === 'ok') return []

  const lines = snapshot.checks
    .filter(check => check.level !== 'ok')
    .map(check => `${icon(check.level)} ${check.label} — ${truncate(check.detail)}`)

  if (snapshot.error) {
    lines.unshift(`⚪ Sin conexión — ${truncate(snapshot.error)}`)
  }

  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `… y ${lines.length - max} más`]
}
