import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as dbus from 'dbus-next'

export const BUS_NAME = 'org.awakenedpoetrade.Tracker'
export const OBJ_PATH = '/Tracker'
export const IFACE = 'org.awakenedpoetrade.Tracker'

/** Events sent by our KWin scripts via `callDBus(..., 'Event', type, json)`. */
export const scriptEvents = new EventEmitter()

// Commands for the tracker script. KWin scripts can't receive D-Bus calls, so
// the tracker long-polls `NextCommand` (callDBus with a callback) and we reply
// once a command is available, or with a no-op before KWin's 25s call timeout.
const NOOP = JSON.stringify({ cmd: 'noop' })
const KEEPALIVE_MS = 20_000
const commandQueue: string[] = []
let waiting: ((json: string) => void) | undefined

export function sendCommand (cmd: object) {
  const json = JSON.stringify(cmd)
  if (waiting) {
    const reply = waiting
    waiting = undefined
    reply(json)
  } else {
    commandQueue.push(json)
  }
}

function nextCommand (): Promise<string> {
  if (commandQueue.length) return Promise.resolve(commandQueue.shift()!)
  // a newer poll (e.g. a reloaded tracker) replaces the old one
  waiting?.(NOOP)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (waiting === reply) waiting = undefined
      resolve(NOOP)
    }, KEEPALIVE_MS)
    timer.unref?.() // the D-Bus connection keeps the process alive, not this
    const reply = (json: string) => { clearTimeout(timer); resolve(json) }
    waiting = reply
  })
}

class EventsInterface extends dbus.interface.Interface {
  constructor () { super(IFACE) }

  Event (type: string, json: string) {
    let payload: any = {}
    try { payload = JSON.parse(json) } catch {}
    scriptEvents.emit(type, payload)
  }

  NextCommand () {
    return nextCommand()
  }
}
EventsInterface.configureMembers({
  methods: {
    Event: { inSignature: 'ss' },
    NextCommand: { inSignature: '', outSignature: 's' }
  }
})

let busPromise: Promise<dbus.MessageBus> | undefined

/** Session bus connection shared by all KDE modules, with our service exported. */
export function getBus (): Promise<dbus.MessageBus> {
  if (!busPromise) {
    busPromise = (async () => {
      const bus = dbus.sessionBus()
      bus.on('error', (e) => console.error('[kde/bus]', e))
      bus.export(OBJ_PATH, new EventsInterface())
      const DO_NOT_QUEUE = 4
      // the first call also waits for the connection; don't let a broken bus hang silently
      const reply = await Promise.race([
        bus.requestName(BUS_NAME, DO_NOT_QUEUE),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
          `No reply from the D-Bus session bus within 5s (DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS})`
        )), 5000))
      ])
      if (reply !== 1 /* PRIMARY_OWNER */ && reply !== 4 /* ALREADY_OWNER */) {
        throw new Error(`Cannot own D-Bus name ${BUS_NAME} (reply ${reply})`)
      }
      return bus
    })()
  }
  return busPromise
}

/**
 * Calls a D-Bus method with an explicit signature and returns the first reply
 * value. Used instead of dbus-next proxy objects: a proxy keeps a single method
 * per name, but Qt exports C++ default arguments as overloads (KWin has both
 * `loadScript(s)` and `loadScript(ss)`), so the proxy can pick the wrong one.
 */
export async function callMethod (
  destination: string, path: string, iface: string, member: string,
  signature = '', body: any[] = []
): Promise<any> {
  const bus = await getBus()
  const reply = await bus.call(new dbus.Message({
    destination, path, interface: iface, member, signature, body
  }))
  return reply?.body[0]
}

/** Common config every script gets, so it can call back into Node. */
export const CALLBACK_CFG = { service: BUS_NAME, path: OBJ_PATH, iface: IFACE }

const KWIN = 'org.kde.KWin'
const SCRIPTING_IFACE = 'org.kde.kwin.Scripting'

/** Loads/unloads KWin scripts through org.kde.KWin /Scripting. */
export class KWinScripts {
  private tmpDir?: string
  private loaded = new Set<string>()

  async run (plugin: string, template: string, config: object) {
    if (!this.tmpDir) {
      this.tmpDir = fs.mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'apt-kwin-'))
    }
    const file = path.join(this.tmpDir, `${plugin}.js`)
    fs.writeFileSync(file, template.replace('__CONFIG__', () => JSON.stringify(config)))

    // stale instance from a previous run/crash
    await callMethod(KWIN, '/Scripting', SCRIPTING_IFACE, 'unloadScript', 's', [plugin])
    const id: number = await callMethod(KWIN, '/Scripting', SCRIPTING_IFACE, 'loadScript', 'ss', [file, plugin])
    if (id < 0) throw new Error(`KWin refused to load script "${plugin}"`)
    this.loaded.add(plugin)

    // Plasma 6: /Scripting/Script<id>; Plasma 5: /<id>
    let lastError: unknown
    for (const p of [`/Scripting/Script${id}`, `/${id}`]) {
      try {
        await callMethod(KWIN, p, 'org.kde.kwin.Script', 'run')
        return
      } catch (e) {
        lastError = e
      }
    }
    throw new Error(`Cannot run KWin script "${plugin}" (id ${id}): ${(lastError as Error)?.message}`)
  }

  async unload (plugin: string) {
    this.loaded.delete(plugin)
    try {
      await callMethod(KWIN, '/Scripting', SCRIPTING_IFACE, 'unloadScript', 's', [plugin])
    } catch {}
  }

  async dispose () {
    await Promise.all([...this.loaded].map(p => this.unload(p)))
    if (this.tmpDir) fs.rmSync(this.tmpDir, { recursive: true, force: true })
  }
}
