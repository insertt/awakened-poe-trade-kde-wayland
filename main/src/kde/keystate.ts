import { EventEmitter } from 'node:events'
import net from 'node:net'
import path from 'node:path'

/**
 * Modifier key state from KWin through the `org_kde_kwin_keystate` Wayland
 * protocol (plasma-wayland-protocols, keystate.xml).
 *
 * Since Plasma 6.3 (protocol version 5) KWin pushes the state of
 * Ctrl/Alt/Shift/Meta/AltGr to every bound client on each modifier change,
 * regardless of which window has focus. That is the only unprivileged way to
 * learn on Wayland that the user released Ctrl while the game is focused.
 * It reports modifiers and lock keys only, never other keys.
 *
 * Electron doesn't expose this protocol, so this is a minimal Wayland client
 * speaking the wire protocol directly over the compositor socket:
 *   wl_display.get_registry -> wl_registry.global* ; wl_display.sync -> done
 *   wl_registry.bind(org_kde_kwin_keystate, v5) ; keystate.fetchStates
 *   -> keystate.stateChanged(key, state)*
 *
 * Events: 'mods' (ModState) on every change, 'error' (Error) once if the
 * connection fails or closes.
 */

export interface ModState { ctrl: boolean, shift: boolean, alt: boolean, meta: boolean }

const KEYSTATE_INTERFACE = 'org_kde_kwin_keystate'
const KEYSTATE_MIN_VERSION = 5 // adds modifiers and the `pressed` state

// keystate.xml enums
const KEY = { alt: 3, control: 4, shift: 5, meta: 6 } as const
const STATE_UNLOCKED = 0

// object ids we allocate (client ids start at 2; 1 is wl_display)
const DISPLAY_ID = 1
const REGISTRY_ID = 2
const SYNC_CALLBACK_ID = 3
const KEYSTATE_ID = 4

// opcodes
const DISPLAY_SYNC = 0
const DISPLAY_GET_REGISTRY = 1
const DISPLAY_EV_ERROR = 0
const REGISTRY_BIND = 0
const REGISTRY_EV_GLOBAL = 0
const CALLBACK_EV_DONE = 0
const KEYSTATE_FETCH_STATES = 0
const KEYSTATE_EV_STATE_CHANGED = 0

/** Path of the compositor socket, per the Wayland client library's rules. */
function waylandSocketPath (env = process.env): string | undefined {
  const display = env.WAYLAND_DISPLAY || 'wayland-0'
  if (path.isAbsolute(display)) return display
  if (!env.XDG_RUNTIME_DIR) return undefined
  return path.join(env.XDG_RUNTIME_DIR, display)
}

// ---- wire format: [object id: u32][size << 16 | opcode: u32][args...], host byte order (LE)

function encodeMessage (objectId: number, opcode: number, args: Array<number | string>): Buffer {
  const parts: Buffer[] = []
  for (const arg of args) {
    if (typeof arg === 'number') {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(arg >>> 0)
      parts.push(b)
    } else {
      const str = Buffer.from(arg + '\0', 'utf8')
      const len = Buffer.alloc(4)
      len.writeUInt32LE(str.length)
      const padded = Buffer.alloc(Math.ceil(str.length / 4) * 4)
      str.copy(padded)
      parts.push(len, padded)
    }
  }
  const body = Buffer.concat(parts)
  const header = Buffer.alloc(8)
  header.writeUInt32LE(objectId)
  header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4)
  return Buffer.concat([header, body])
}

function readString (body: Buffer, offset: number): [string, number] {
  const len = body.readUInt32LE(offset)
  const str = body.toString('utf8', offset + 4, offset + 4 + Math.max(0, len - 1))
  return [str, offset + 4 + Math.ceil(len / 4) * 4]
}

export class WaylandKeyState extends EventEmitter {
  mods: ModState = { ctrl: false, shift: false, alt: false, meta: false }
  version = 0
  private socket?: net.Socket
  private pending: Buffer = Buffer.alloc(0)
  private keystateGlobal?: { name: number, version: number }
  private failed = false
  private gotInitialState = false

  /** Resolves with the bound protocol version once the initial state arrived. */
  start (socketPath = waylandSocketPath(), timeoutMs = 3000): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!socketPath) {
        reject(new Error('no Wayland socket (WAYLAND_DISPLAY / XDG_RUNTIME_DIR unset)'))
        return
      }
      let ready = false
      const fail = (err: Error) => {
        if (this.failed) return
        this.failed = true
        clearTimeout(timer)
        this.socket?.destroy()
        if (ready) this.emit('error', err)
        else reject(err)
      }
      const timer = setTimeout(() => fail(new Error(`no reply from the compositor within ${timeoutMs}ms`)), timeoutMs)
      this.once('ready', () => { ready = true; clearTimeout(timer); resolve(this.version) })

      this.socket = net.createConnection(socketPath)
      this.socket.on('error', (e) => fail(e))
      this.socket.on('close', () => fail(new Error('Wayland connection closed')))
      this.socket.on('data', (chunk) => {
        try {
          this.onData(chunk)
        } catch (e) {
          fail(e as Error)
        }
      })
      this.socket.on('connect', () => {
        this.send(DISPLAY_ID, DISPLAY_GET_REGISTRY, [REGISTRY_ID])
        // the reply to sync arrives after all globals were announced
        this.send(DISPLAY_ID, DISPLAY_SYNC, [SYNC_CALLBACK_ID])
      })
      this.on('protocol-error', fail)
    })
  }

  dispose () {
    this.failed = true
    this.socket?.destroy()
  }

  private send (objectId: number, opcode: number, args: Array<number | string>) {
    this.socket!.write(encodeMessage(objectId, opcode, args))
  }

  private onData (chunk: Buffer) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    const before = { ...this.mods }
    let gotStates = false

    while (this.pending.length >= 8) {
      const objectId = this.pending.readUInt32LE(0)
      const word = this.pending.readUInt32LE(4)
      const size = word >>> 16
      const opcode = word & 0xffff
      if (size < 8) throw new Error(`malformed Wayland message (size ${size})`)
      if (this.pending.length < size) break
      const body = this.pending.subarray(8, size)
      this.pending = this.pending.subarray(size)
      if (this.handle(objectId, opcode, body)) gotStates = true
    }

    if (gotStates) {
      // KWin sends the state of every key in one burst; report once per chunk
      if (!this.gotInitialState) {
        this.gotInitialState = true
        this.emit('ready')
      } else if ((Object.keys(before) as Array<keyof ModState>).some(k => before[k] !== this.mods[k])) {
        this.emit('mods', { ...this.mods })
      }
    }
  }

  /** Returns true for keystate state events. */
  private handle (objectId: number, opcode: number, body: Buffer): boolean {
    if (objectId === DISPLAY_ID && opcode === DISPLAY_EV_ERROR) {
      const [message] = readString(body, 8)
      this.emit('protocol-error', new Error(`Wayland protocol error ${body.readUInt32LE(4)}: ${message}`))
      return false
    }
    if (objectId === REGISTRY_ID && opcode === REGISTRY_EV_GLOBAL) {
      const name = body.readUInt32LE(0)
      const [iface, off] = readString(body, 4)
      if (iface === KEYSTATE_INTERFACE) {
        this.keystateGlobal = { name, version: body.readUInt32LE(off) }
      }
      return false
    }
    if (objectId === SYNC_CALLBACK_ID && opcode === CALLBACK_EV_DONE) {
      const g = this.keystateGlobal
      if (!g) {
        this.emit('protocol-error', new Error(`compositor has no ${KEYSTATE_INTERFACE}`))
      } else if (g.version < KEYSTATE_MIN_VERSION) {
        this.emit('protocol-error', new Error(
          `${KEYSTATE_INTERFACE} v${g.version} reports no modifiers (needs v${KEYSTATE_MIN_VERSION}, Plasma 6.3+)`))
      } else {
        this.version = KEYSTATE_MIN_VERSION
        // untyped new_id: interface name, version, id
        this.send(REGISTRY_ID, REGISTRY_BIND, [g.name, KEYSTATE_INTERFACE, this.version, KEYSTATE_ID])
        this.send(KEYSTATE_ID, KEYSTATE_FETCH_STATES, [])
      }
      return false
    }
    if (objectId === KEYSTATE_ID && opcode === KEYSTATE_EV_STATE_CHANGED) {
      const key = body.readUInt32LE(0)
      // pressed, latched or locked (sticky keys) all count as "held"
      const active = body.readUInt32LE(4) !== STATE_UNLOCKED
      if (key === KEY.control) this.mods.ctrl = active
      else if (key === KEY.shift) this.mods.shift = active
      else if (key === KEY.alt) this.mods.alt = active
      else if (key === KEY.meta) this.mods.meta = active
      return true
    }
    // wl_display.delete_id and anything else: nothing to do
    return false
  }
}
