/**
 * Structured JSON logging. No emojis anywhere in anything this service emits:
 * explicit client rule, and it also keeps log lines greppable.
 */
type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields ?? {}),
  })
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
}
