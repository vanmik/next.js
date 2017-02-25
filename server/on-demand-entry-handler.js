import DynamicEntryPlugin from 'webpack/lib/DynamicEntryPlugin'
import { EventEmitter } from 'events'
import { createServer } from 'http'
import { join } from 'path'
import resolvePath from './resolve'
import touch from 'touch'
import WebSocket from 'ws'

const ADDED = Symbol()
const BUILDING = Symbol()
const BUILT = Symbol()

export default async function onDemandEntryHandler (devMiddleware, compiler, {
  dir,
  dev,
  maxInactiveAge = 1000 * 25
}) {
  const server = await getServer()
  const wss = new WebSocket.Server({ server })

  const entries = {}
  const lastAccessPages = ['']
  const doneCallbacks = new EventEmitter()
  let touchedAPage = false

  compiler.plugin('make', function (compilation, done) {
    const allEntries = Object.keys(entries).map((page) => {
      const { name, entry } = entries[page]
      entries[page].status = BUILDING
      return addEntry(compilation, this.context, name, entry)
    })

    Promise.all(allEntries)
      .then(() => done())
      .catch(done)
  })

  compiler.plugin('done', function (stats) {
    // Call all the doneCallbacks
    Object.keys(entries).forEach((page) => {
      const entryInfo = entries[page]
      if (entryInfo.status !== BUILDING) return

      // With this, we are triggering a filesystem based watch trigger
      // It'll memorize some timestamp related info related to common files used
      // in the page
      // That'll reduce the page building time significantly.
      if (!touchedAPage) {
        setTimeout(() => {
          touch.sync(entryInfo.pathname)
        }, 0)
        touchedAPage = true
      }

      entryInfo.status = BUILT
      entries[page].lastActiveTime = Date.now()
      doneCallbacks.emit(page)
    })
  })

  setInterval(function () {
    disposeInactiveEntries(devMiddleware, entries, lastAccessPages, maxInactiveAge)
  }, 5000)

  wss.on('connection', (conn) => {
    conn.on('message', (message) => {
      const parsedMessage = JSON.parse(message)
      const page = normalizePage(parsedMessage.page)
      const entryInfo = entries[page]

      // If there's no entry.
      // Then it seems like an weird issue.
      if (!entryInfo) {
        const message = `Client pings, but there's no entry for page: ${page}`
        console.error(message)
        conn.send(JSON.stringify({ invalid: true }))
        return
      }

      // We don't need to maintain active state of anything other than BUILT entries
      if (entryInfo.status !== BUILT) return

      // If there's an entryInfo
      lastAccessPages.pop()
      lastAccessPages.unshift(page)
      entryInfo.lastActiveTime = Date.now()
    })
  })

  return {
    async ensurePage (page) {
      page = normalizePage(page)

      const pagePath = join(dir, 'pages', page)
      const pathname = await resolvePath(pagePath)
      const name = join('bundles', pathname.substring(dir.length))

      const entry = [
        join(__dirname, '..', 'client/webpack-hot-middleware-client'),
        join(__dirname, '..', 'client', 'on-demand-entries-client'),
        `${pathname}?entry`
      ]

      await new Promise((resolve, reject) => {
        const entryInfo = entries[page]

        if (entryInfo) {
          if (entryInfo.status === BUILT) {
            resolve()
            return
          }

          if (entryInfo.status === BUILDING) {
            doneCallbacks.on(page, processCallback)
            return
          }
        }

        console.log(`> Building page: ${page}`)

        entries[page] = { name, entry, pathname, status: ADDED }
        doneCallbacks.on(page, processCallback)

        devMiddleware.invalidate()

        function processCallback (err) {
          if (err) return reject(err)
          resolve()
        }
      })
    },

    middleware () {
      return function (req, res, next) {
        if (!/^\/on-demand-entries-pinger-port/.test(req.url)) return next()

        sendJson(res, {
          port: server.address().port
        })
      }
    },

    close () {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }

          resolve()
        })
      })
    }
  }
}

function addEntry (compilation, context, name, entry) {
  return new Promise((resolve, reject) => {
    const dep = DynamicEntryPlugin.createDependency(entry, name)
    compilation.addEntry(context, dep, name, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

function disposeInactiveEntries (devMiddleware, entries, lastAccessPages, maxInactiveAge) {
  const disposingPages = []

  Object.keys(entries).forEach((page) => {
    const { lastActiveTime, status } = entries[page]

    // This means this entry is currently building or just added
    // We don't need to dispose those entries.
    if (status !== BUILT) return

    // We should not build the last accessed page even we didn't get any pings
    // Sometimes, it's possible our XHR ping to wait before completing other requests.
    // In that case, we should not dispose the current viewing page
    if (lastAccessPages[0] === page) return

    if (Date.now() - lastActiveTime > maxInactiveAge) {
      disposingPages.push(page)
    }
  })

  if (disposingPages.length > 0) {
    disposingPages.forEach((page) => {
      delete entries[page]
    })
    console.log(`> Disposing inactive page(s): ${disposingPages.join(', ')}`)
    devMiddleware.invalidate()
  }
}

// /index and / is the same. So, we need to identify both pages as the same.
// This also applies to sub pages as well.
function normalizePage (page) {
  return page.replace(/\/index$/, '/')
}

function sendJson (res, payload) {
  res.setHeader('Content-Type', 'application/json')
  res.status = 200
  res.end(JSON.stringify(payload))
}

function getServer () {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen((err) => {
      if (err) {
        reject(err)
        return
      }

      resolve(server)
    })
  })
}
