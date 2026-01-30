import { IncomingMessage, ServerResponse } from 'http'
import { spawn } from 'child_process'
import { logger } from './logger'
import { once } from 'events'
import { Page } from 'playwright'
import { newBrowserPage } from './browser'
import { BUFFER_SEC, FFMPEG_PATH, VIDEO_BITRATE } from '.'

type StreamContext = {
  id: string
  page: Page
  ffmpeg: ReturnType<typeof spawnFFmpeg>
}

class ChunkBuffer {
  private queue: Buffer[] = []
  private size = 0

  constructor(private maxBytes: number) { }

  push(buf: Buffer) {
    this.queue.push(buf)
    this.size += buf.length
    while (this.size > this.maxBytes) {
      const drop = this.queue.shift()
      if (!drop) break
      this.size -= drop.length
    }
  }

  pop(): Buffer | null {
    const buf = this.queue.shift()
    if (!buf) return null
    this.size -= buf.length
    return buf
  }

  get bufferedBytes() {
    return this.size
  }
}

async function createStreamContext(id: string, pageUrl: string): Promise<StreamContext> {
  const page = await newBrowserPage()
  const ffmpeg = spawnFFmpeg()
  const buffer = new ChunkBuffer(BUFFER_SEC * 2 * VIDEO_BITRATE / 8)
  let started = false

  page.on('close', () => {
    logger.info('FMP4', `[-] page closed ${id}`)
    ffmpeg.kill('SIGINT')
  })

  ffmpeg.on('exit', () => {
    logger.info('FMP4', `[-] ffmpeg exit ${id}`)
    page.close().catch(() => { })
  })

  await page.addInitScript((bitrate) => {
    (window as any).__VIDEO_BITRATE = bitrate
  }, VIDEO_BITRATE)

  await page.exposeFunction('__pushMediaChunk', async (chunk: Uint8Array) => {
    if (!ffmpeg.stdin.writable) return

    if (started) {
      buffer.push(Buffer.from(chunk))
    } else {
      try { ffmpeg.stdin.write(Buffer.from(chunk)) } catch { }
    }
  })

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })

  await page.waitForFunction(
    () => (window as any).__video_ready === true,
    { timeout: 30_000 }
  )
  logger.info('FMP4', `[=] video ready ${id}`)

  await page.waitForFunction(
    () => (window as any).__media_capture_ready === true,
    { timeout: 30_000 }
  )
  logger.info('FMP4', `[=] media capture ready ${id}`)

  setTimeout(() => {
    started = true
    startSendBuffer(buffer, ffmpeg)
  }, BUFFER_SEC * 1000)

  return {
    id,
    page,
    ffmpeg,
  }
}

async function startSendBuffer(buffer: ChunkBuffer, ffmpeg: ReturnType<typeof spawnFFmpeg>) {
  while (!ffmpeg.killed) {
    const seconds = buffer.bufferedBytes * 8 / VIDEO_BITRATE

    if (seconds < BUFFER_SEC) {
      await delay(50)
      continue
    }

    const chunk = buffer.pop()
    if (!chunk) continue

    try {
      const ok = ffmpeg.stdin.write(chunk)
      if (!ok) {
        await once(ffmpeg.stdin, 'drain')
      }
    } catch { }
    await delay(100)
  }
}

function spawnFFmpeg() {
  return spawn(
    FFMPEG_PATH,
    [
      '-loglevel', 'error',

      '-i', 'pipe:0',
      '-map', '0:v:0',
      '-map', '0:a?',

      '-flush_packets', '1',
      '-max_delay', '0',

      // '-c:v', 'copy',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-g', '30',
      '-keyint_min', '30',

      '-c:a', 'aac',
      '-b:a', '96k',

      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',

      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  )
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

export async function handleFmp4ApiStreamRequest(url: string, res: ServerResponse<IncomingMessage>) {
  const id = `stream_${hash(url)}`
  logger.info('FMP4', `[+] create stream ${id}`, { url })

  const ctx = await createStreamContext(id, url)

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*',
  })

  ctx.ffmpeg.stdout.on('data', (chunk) => {
    try {
      const ok = res.write(chunk)
      if (!ok) {
        ctx.ffmpeg.stdout.pause()
        res.once('drain', () => ctx.ffmpeg.stdout.resume())
      }
    } catch { }
  })

  res.on('close', async () => {
    logger.info('FMP4', `[-] client disconnected`)
    ctx.ffmpeg.kill('SIGINT')
    await ctx.page.close().catch(() => { })
  })
}
