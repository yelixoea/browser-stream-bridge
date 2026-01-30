import { createServer } from 'http'
import { logger } from './logger'
import { destroyBrowser, initBrowser } from './browser'
import { handleFmp4ApiStreamRequest } from './fmp4'
import { handleHlsApiStreamRequest, handleHlsTsRequest, hlsCleanup } from './hls'

export const PAGE_BLOCK_LIST_FILE = 'assets/page_block_list.txt'
export const PAGE_PRELOAD_FILE = 'assets/page_preload.js'

export const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'

export const SERVER_SCHEME = process.env.SERVER_SCHEME || 'http'
export const SERVER_IP = process.env.SERVER_IP || '127.0.0.1'
export const SERVER_PORT = Number(process.env.SERVER_PORT || 3001)

export const VIDEO_BITRATE = Number(process.env.VIDEO_BITRATE || '4000000')
export const HLS_DIR = process.env.HLS_DIR || './hls'
export const BUFFER_SEC = Number(process.env.BUFFER_SEC || '0.2')

function startHttpServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '', 'http://localhost')
      if (url.pathname.startsWith('/hls/')) {
        await handleHlsTsRequest(url.pathname, res)
      } else if (url.pathname === '/api/stream') {
        const pageUrl = url.searchParams.get('url')
        const type = url.searchParams.get('type') || 'hls'

        if (!pageUrl) {
          res.writeHead(400)
          res.end('Missing url parameter')
          return
        }

        if (type == 'hls') {
          await handleHlsApiStreamRequest(pageUrl, res)
        } else if (type == 'fmp4') {
          await handleFmp4ApiStreamRequest(pageUrl, res)
        } else {
          res.writeHead(400)
          res.end('Invalid type parameter')
          return
        }
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
    logger.info('HTTP', `listening: ${SERVER_SCHEME}://${SERVER_IP}:${SERVER_PORT}/api/stream?url=...&type=...`)
  })
}

function logConfig() {
  logger.info('CONFIG', `PLAYWRIGHT_BROWSERS_PATH: ${process.env.PLAYWRIGHT_BROWSERS_PATH || 'default'}`)
  logger.info('CONFIG', `FFMPEG_PATH: ${FFMPEG_PATH}`)
  logger.info('CONFIG', `SERVER_IP: ${SERVER_IP}`)
  logger.info('CONFIG', `SERVER_PORT: ${SERVER_PORT}`)
  logger.info('CONFIG', `VIDEO_BITRATE: ${VIDEO_BITRATE}`)
  logger.info('CONFIG', `HLS_DIR: ${HLS_DIR}`)
  logger.info('CONFIG', `BUFFER_SEC: ${BUFFER_SEC}`)
}

/* ================== MAIN ================== */

async function main() {
  logConfig()
  await initBrowser(PAGE_BLOCK_LIST_FILE, PAGE_PRELOAD_FILE)
  startHttpServer()
}

process.on('SIGINT', async () => {
  logger.info('SYSTEM', 'shutdown...')
  await hlsCleanup()
  await destroyBrowser()
  process.exit(0)
})

main().catch(err => {
  logger.error('SYSTEM', 'uncaught error', err)
  process.exit(1)
})
