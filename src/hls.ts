import { IncomingMessage, ServerResponse } from 'http'
import { Page } from 'playwright'
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs/promises'
import { logger } from './logger'
import { FFMPEG_PATH, HLS_DIR, SERVER_IP, SERVER_PORT, SERVER_SCHEME, VIDEO_BITRATE } from '.'
import { newBrowserPage } from './browser'

type StreamContext = {
  id: string
  page: Page
  ffmpeg: ChildProcess
  lastVisit: number
}

const streams = new Map<string, StreamContext | null>()

async function createStreamContext(id: string, pageUrl: string): Promise<StreamContext> {
  await createStream(id)

  const page = await newBrowserPage()
  const ffmpeg = spawnFFmpeg(id)

  page.on('close', () => {
    logger.info('HLS', `[-] page closed ${id}`)
    ffmpeg.kill('SIGINT')
    streams.delete(id)
  })

  ffmpeg.on('exit', () => {
    logger.info('HLS', `[-] ffmpeg exit ${id}`)
    page.close().catch(() => { })
    streams.delete(id)
  })

  await page.exposeFunction('__pushMediaChunk', (chunk: Uint8Array) => {
    if (!ffmpeg.stdin.writable) return
    try {
      ffmpeg.stdin.write(Buffer.from(chunk))
    } catch { }
  })

  await page.addInitScript((bitrate) => {
    (window as any).__VIDEO_BITRATE = bitrate
  }, VIDEO_BITRATE)

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })

  await page.waitForFunction(
    () => (window as any).__video_ready === true,
    { timeout: 30_000 }
  )
  logger.info('HLS', `[=] video ready ${id}`)

  await page.waitForFunction(
    () => (window as any).__media_capture_ready === true,
    { timeout: 30_000 }
  )
  logger.info('HLS', `[=] media capture ready ${id}`)

  await waitStreamReady(id)
  logger.info('HLS', `[=] stream ready ${id}`)

  return {
    id,
    page,
    ffmpeg,
    lastVisit: Date.now(),
  }
}

function spawnFFmpeg(id: string) {
  return spawn(
    FFMPEG_PATH,
    [
      '-loglevel', 'error',

      '-i', 'pipe:0',
      '-map', '0:v:0',
      '-map', '0:a?',

      '-c:v', 'copy',

      '-c:a', 'aac',
      '-b:a', '96k',

      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_base_url', `${SERVER_SCHEME}://${SERVER_IP}:${SERVER_PORT}/hls/${id}/`,
      `${HLS_DIR}/${id}/live.m3u8`
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  )
}

async function createStream(id: string) {
  await fs.rm(`${HLS_DIR}/${id}`, { recursive: true, force: true })
  await fs.mkdir(`${HLS_DIR}/${id}`, { recursive: true })
}

async function waitStreamReady(id: string) {
  const start = Date.now()
  while (Date.now() - start < 30_000) {
    try {
      const files = await fs.readdir(`${HLS_DIR}/${id}`).catch(() => [] as string[])
      if (files.length >= 3 && files.includes('live.m3u8')) return
    } catch { }
    await delay(100)
  }
  throw new Error(`stream: ${id} not ready`)
}

function startCleanupTimer() {
  setInterval(async () => {
    const now = Date.now()
    for (const [name, ctx] of streams.entries()) {
      if (ctx !== null && now - ctx.lastVisit > 10_000) {
        try {
          logger.info('HLS', `[-] cleanup stream ${name}`)
          ctx.ffmpeg.kill('SIGINT')
          await ctx.page.close().catch(() => { })
          streams.delete(name)
        } catch (err) {
          logger.error('HLS', `failed to cleanup stream ${name}:`, err)
        }
      }
    }
  }, 10_000)
}

function delay(ms: number) {
  return new Promise(res => setTimeout(res, ms))
}

function hash(input: string) {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h).toString()
}

export async function handleHlsTsRequest(path: string, res: ServerResponse<IncomingMessage>) {
  const filePath = `.${path}`
  try {
    const data = await fs.readFile(filePath)
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
  return
}

export async function handleHlsApiStreamRequest(url: string, res: ServerResponse<IncomingMessage>) {
  const id = `stream_${hash(url)}`

  if (streams.has(id)) {
    await waitStreamReady(id)
    const context = streams.get(id)
    if (context !== null) {
      context!.lastVisit = Date.now()
    }

    const data = await fs.readFile(`${HLS_DIR}/${id}/live.m3u8`)
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': data.length.toString(),
    })
    res.end(data)
    return
  }

  logger.info('HLS', `[+] create stream ${id}`, { url })
  streams.set(id, null)

  const ctx = await createStreamContext(id, url)
  streams.set(id, ctx)

  const data = await fs.readFile(`${HLS_DIR}/${id}/live.m3u8`)
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': data.length.toString(),
  })
  res.end(data)
}

export async function hlsCleanup() {
  logger.info('HLS', 'cleanup all streams')
  for (const ctx of streams.values()) {
    if (ctx !== null) {
      ctx.ffmpeg.kill('SIGINT')
      await ctx.page.close().catch(() => { })
    }
  }
}

startCleanupTimer()
