type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

function log(
  level: LogLevel,
  tag: string,
  msg: string,
  extra?: any
) {
  const time = new Date().toLocaleString()
  if (extra !== undefined) {
    console.log(`[${time}] [${level}] [${tag}] ${msg}`, extra)
  } else {
    console.log(`[${time}] [${level}] [${tag}] ${msg}`)
  }
}

export const logger = {
  info: (tag: string, msg: string, extra?: any) =>
    log('INFO', tag, msg, extra),

  warn: (tag: string, msg: string, extra?: any) =>
    log('WARN', tag, msg, extra),

  error: (tag: string, msg: string, extra?: any) =>
    log('ERROR', tag, msg, extra),

  debug: (tag: string, msg: string, extra?: any) => {
    if (process.env.DEBUG) {
      log('DEBUG', tag, msg, extra)
    }
  },
}
