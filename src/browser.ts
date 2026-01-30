import { chromium, Browser, Page, BrowserContext } from 'playwright'
import fs from 'fs/promises'

let browser: Browser
let browserContext: BrowserContext
let pageBlockList: RegExp[] = []
let pagePreloadJs = ''

const assetsCache = new Map<string, Buffer>()

async function loadAssets(block_list_file: string, preload_file: string) {
  pageBlockList = (await fs.readFile(block_list_file, 'utf-8'))
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => new RegExp(l.replace(/\*/g, '.*')))

  pagePreloadJs = await fs.readFile(preload_file, 'utf-8')
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

  browserContext.addInitScript(pagePreloadJs)
}

export async function initBrowser(
  block_list_file: string,
  preload_file: string,
) {
  await loadAssets(block_list_file, preload_file)
  await loadBrowser()
}

export async function destroyBrowser() {
  if (browserContext) {
    try { await browserContext.close() } catch { }
  }
  if (browser) {
    try { await browser.close() } catch { }
  }
}

export async function newBrowserPage(): Promise<Page> {
  if (!browserContext) {
    throw new Error('Browser not initialized')
  }
  const page = await browserContext.newPage()
  return page
}
