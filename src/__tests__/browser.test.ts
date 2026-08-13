import { strict as assert } from 'node:assert'
import { beforeEach, test } from 'node:test'
import { createBrowserTracker } from '../browser.js'
import type { AnalyticsEvent } from '../types.js'

/**
 * Minimal browser globals for the tracker: location/search, storage, and a
 * sendBeacon that records payloads. Enough to exercise the internal-traffic
 * flag end to end without a DOM library.
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage
}

const sent: AnalyticsEvent[] = []

function stubBrowser(search: string): void {
  const localStorage = memoryStorage()
  const sessionStorage = memoryStorage()
  const win = {
    location: {
      hostname: 'www.example.com',
      href: `https://www.example.com/some/page${search}`,
      pathname: '/some/page',
      search,
      origin: 'https://www.example.com',
    },
    localStorage,
    sessionStorage,
    screen: { width: 1440 },
  }
  // navigator (and in some Node versions window) are getter-only on
  // globalThis, so plain assignment throws. defineProperty replaces them.
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  define('window', win)
  define('document', { title: 'Page', referrer: '' })
  define('navigator', {
    language: 'en-US',
    userAgent: 'test',
    sendBeacon: (_url: string, blob: Blob) => {
      void blob.text().then((text) => {
        const parsed = JSON.parse(text) as { events: AnalyticsEvent[] }
        sent.push(...parsed.events)
      })
      return true
    },
  })
}

function lastEvent(): Promise<AnalyticsEvent> {
  // sendBeacon's blob.text() resolves on a microtask; one tick is enough.
  return new Promise((resolve) => setTimeout(() => resolve(sent[sent.length - 1]!), 0))
}

/** Re-visit a URL while KEEPING localStorage, like a same-browser navigation. */
function navigate(search: string): void {
  const win = (globalThis as Record<string, unknown>).window as {
    location: { href: string; search: string }
    localStorage: Storage
  }
  win.location.search = search
  win.location.href = `https://www.example.com/some/page${search}`
}

beforeEach(() => {
  sent.length = 0
  stubBrowser('')
})

test('events carry no internal flag by default', async () => {
  const tracker = createBrowserTracker({ url: '/api/events' })
  tracker.track('thing_happened', { a: 1 })
  const event = await lastEvent()
  assert.equal(event.properties?.internal, undefined)
  assert.deepEqual(event.properties, { a: 1 })
})

test('?internal=1 marks the browser and every later event, across navigations', async () => {
  stubBrowser('?internal=1')
  const tracker = createBrowserTracker({ url: '/api/events' })
  tracker.track('first')
  assert.equal((await lastEvent()).properties?.internal, true)

  // Param gone on the next navigation; the stored flag persists.
  navigate('')
  tracker.track('second', { b: 2 })
  const second = await lastEvent()
  assert.equal(second.properties?.internal, true)
  assert.equal(second.properties?.b, 2)
})

test('?internal=0 clears the stored flag', async () => {
  stubBrowser('?internal=1')
  const tracker = createBrowserTracker({ url: '/api/events' })
  tracker.track('while_internal')
  navigate('?internal=0')
  tracker.track('after_clear')
  const event = await lastEvent()
  assert.equal(event.properties?.internal, undefined)
})

test('the explicit option overrides URL and storage', async () => {
  stubBrowser('?internal=1')
  const tracker = createBrowserTracker({ url: '/api/events', internal: false })
  tracker.track('forced_off')
  assert.equal((await lastEvent()).properties?.internal, undefined)
})

test('a caller-supplied internal property wins over the stamp', async () => {
  stubBrowser('?internal=1')
  const tracker = createBrowserTracker({ url: '/api/events' })
  tracker.track('override', { internal: 'qa-bot' })
  assert.equal((await lastEvent()).properties?.internal, 'qa-bot')
})
