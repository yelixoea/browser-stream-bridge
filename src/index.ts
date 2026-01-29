import { createServer, IncomingMessage, ServerResponse } from 'http'
import { chromium, Browser, Page, BrowserContext } from 'playwright'
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs/promises'
import { logger } from './logger'

/* ================== CONFIG ================== */

const PAGE_BLOCK_LIST_FILE = 'assets/page_block_list.txt'
const PAGE_PRELOAD_FILE = 'assets/page_preload.js'

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'

const SERVER_IP = process.env.SERVER_IP || '127.0.0.1'
const SERVER_PORT = Number(process.env.SERVER_PORT || 3001)

const HLS_DIR = process.env.HLS_DIR || './hls'

const VIDEO_BITRATE = Number(process.env.VIDEO_BITRATE || '6000000')

/* ================== TYPES ================== */

type StreamContext = {
  id: string
  page: Page
  ffmpeg: ChildProcess
  lastVisit: number
}

/* ================== GLOBAL STATE ================== */

let browser: Browser
let browserContext: BrowserContext
let pageBlockList: RegExp[] = []
let pagePreloadJs = ''

const assetsCache = new Map<string, Buffer>()
const streams = new Map<string, StreamContext | null>()

/* ================== HTTP SERVER ================== */

function startHttpServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '', 'http://localhost')

      if (url.pathname.startsWith('/hls/')) {
        await handleHlsRequest(url, res)
      } else if (url.pathname === '/api/stream') {
        await handleApiStreamRequest(url, res)
      } else {
        res.writeHead(404)
        res.end('Not Found')
      }
    } catch (err) {
      logger.error('HTTP', 'request failed', err)
      res.writeHead(500)
      res.end('Internal Server Error')
    }
  })

  server.listen(SERVER_PORT, '0.0.0.0', () => {
    logger.info('HTTP', `listening: http://${SERVER_IP}:${SERVER_PORT}/api/stream?url=...`)
  })
}

async function handleHlsRequest(url: URL, res: ServerResponse<IncomingMessage>) {
  const filePath = `.${url.pathname}`
  try {
    const data = await fs.readFile(filePath)
    res.writeHead(200, {
      'Content-Type': url.pathname.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t',
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

async function handleApiStreamRequest(url: URL, res: ServerResponse<IncomingMessage>) {
  const pageUrl = url.searchParams.get('url')
  if (!pageUrl) {
    res.writeHead(400)
    res.end('Missing url parameter')
    return
  }

  const id = `stream_${hash(pageUrl)}`

  if (streams.has(id)) {
    await waitStreamReady(id)
    if (streams.get(id) !== null) {
      streams.get(id)!.lastVisit = Date.now()
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

  logger.info('STREAM', `[+] create stream ${id}`, { pageUrl })
  streams.set(id, null)

  const ctx = await createStreamContext(id, pageUrl)
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

/* ================== STREAM CONTEXT ================== */

async function createStreamContext(id: string, pageUrl: string): Promise<StreamContext> {
  await createStream(id)

  const page = await browserContext.newPage()
  const ffmpeg = spawnFFmpeg(id)

  page.on('close', () => {
    logger.info('STREAM', `[-] page closed ${id}`)
    ffmpeg.kill('SIGINT')
    streams.delete(id)
  })

  ffmpeg.on('exit', () => {
    logger.info('STREAM', `[-] ffmpeg exit ${id}`)
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
  await page.addInitScript(pagePreloadJs)

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })

  await page.waitForFunction(
    () => (window as any).__video_ready === true,
    { timeout: 30_000 }
  )
  logger.info('STREAM', `[=] video ready ${id}`)

  await page.waitForFunction(
    () => (window as any).__media_capture_ready === true,
    { timeout: 30_000 }
  )
  logger.info('STREAM', `[=] media capture ready ${id}`)

  await waitStreamReady(id)
  logger.info('STREAM', `[=] stream ready ${id}`)

  return {
    id,
    page,
    ffmpeg,
    lastVisit: Date.now(),
  }
}

/* ================== FFMPEG ================== */

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
      '-hls_base_url', `http://${SERVER_IP}:${SERVER_PORT}/hls/${id}/`,
      `${HLS_DIR}/${id}/live.m3u8`
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  )
}

/* ================== STREAM ================== */

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
  throw new Error('stream not ready')
}

/* ================== CLEANUP ================== */

function startCleanupTimer() {
  setInterval(async () => {
    try {
      const now = Date.now()
      for (const [name, ctx] of streams.entries()) {
        if (ctx !== null && now - ctx.lastVisit > 10_000) {
          logger.info('STREAM', `[-] cleanup stream ${name}`)
          ctx.ffmpeg.kill('SIGINT')
          await ctx.page.close().catch(() => { })
          streams.delete(name)
        }
      }
    } catch (err) {
      logger.error('CLEANUP', 'failed to cleanup streams', err)
    }
  }, 10_000)
}

/* ================== UTIL ================== */

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

async function loadAssets() {
  pageBlockList = (await fs.readFile(PAGE_BLOCK_LIST_FILE, 'utf-8'))
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => new RegExp(l.replace(/\*/g, '.*')))

  pagePreloadJs = await fs.readFile(PAGE_PRELOAD_FILE, 'utf-8')
}

async function loadBrowser() {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--enable-features=WebRTC-H264HighProfile,WebCodecs',
      '--disable-web-security',
    ],
  })

  browserContext = await browser.newContext({
    acceptDownloads: false,
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0',
  })

  await browserContext.route('**/*', (route, req) => {
    const reqUrl = req.url()
    for (const rule of pageBlockList) {
      if (rule.test(reqUrl)) {
        return route.fulfill({ status: 200, body: '' })
      }
    }

    const cache = assetsCache.get(reqUrl)
    if (cache) {
      return route.fulfill({ body: cache })
    }

    route.continue()
  })

  await browserContext.route('**/*{.js,.css}', (route, req) => {
    req.response()
      .then(async (resp) => {
        if (resp && !assetsCache.get(resp.url())) {
          try {
            assetsCache.set(resp.url(), await resp.body())
          }
          catch { }
        }
      })

    route.fallback()
  })
}

function logConfig() {
  logger.info('CONFIG', `PLAYWRIGHT_BROWSERS_PATH: ${process.env.PLAYWRIGHT_BROWSERS_PATH || 'default'}`)
  logger.info('CONFIG', `FFMPEG_PATH: ${FFMPEG_PATH}`)
  logger.info('CONFIG', `SERVER_IP: ${SERVER_IP}`)
  logger.info('CONFIG', `SERVER_PORT: ${SERVER_PORT}`)
  logger.info('CONFIG', `HLS_DIR: ${HLS_DIR}`)
  logger.info('CONFIG', `VIDEO_BITRATE: ${VIDEO_BITRATE}`)
}

/* ================== MAIN ================== */

async function main() {
  logConfig()
  await loadAssets()
  await loadBrowser()
  startHttpServer()
  startCleanupTimer()
}

process.on('SIGINT', async () => {
  logger.info('SYSTEM', 'shutdown...')
  for (const ctx of streams.values()) {
    if (ctx !== null) {
      ctx.ffmpeg.kill('SIGINT')
      await ctx.page.close().catch(() => { })
    }
  }
  await browser.close()
  process.exit(0)
})

main().catch(err => {
  logger.error('SYSTEM', 'uncaught error', err)
  process.exit(1)
})
