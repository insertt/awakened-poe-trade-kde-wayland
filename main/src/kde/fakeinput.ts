import { EventEmitter } from 'node:events'
import net from 'node:net'
import { encodeMessage, MessageReader, readString, waylandSocketPath } from './wayland-wire'

/**
 * Key injection through KWin's `org_kde_kwin_fake_input` Wayland protocol
 * (plasma-wayland-protocols, fake-input.xml), as used by KDE Connect.
 *
 * Preferred over the RemoteDesktop portal: no "remote control session"
 * notification. KWin only withholds this protocol from sandboxed clients, and
 * `authenticate` is accepted without asking (KWin: "TODO: make secure"), so it
 * may get restricted in the future; KeyInjector falls back to the portal then.
 * When the connection closes (incl. a crash) KWin releases keys still held.
 *
 *   wl_display.get_registry -> globals ; sync -> done
 *   registry.bind(org_kde_kwin_fake_input, v5) ; authenticate ; sync -> done
 *   keyboard_key(evdev code, state)*
 *
 * Emits 'error' if the connection is lost after start() resolved.
 */
const FAKE_INPUT_INTERFACE = 'org_kde_kwin_fake_input'
const MIN_VERSION = 4 // keyboard_key
const BIND_VERSION = 5 // + destroy; offered since Plasma 6.0

const DISPLAY_ID = 1
const REGISTRY_ID = 2
const SYNC_GLOBALS_ID = 3
const FAKE_INPUT_ID = 4
const SYNC_AUTH_ID = 5

const DISPLAY_SYNC = 0
const DISPLAY_GET_REGISTRY = 1
const DISPLAY_EV_ERROR = 0
const REGISTRY_BIND = 0
const REGISTRY_EV_GLOBAL = 0
const CALLBACK_EV_DONE = 0
// fake-input.xml request order
const FAKE_INPUT_AUTHENTICATE = 0
const FAKE_INPUT_KEYBOARD_KEY = 10

export class WaylandFakeInput extends EventEmitter {
  isActive = false
  private socket?: net.Socket
  private reader = new MessageReader()
  private global?: { name: number, version: number }
  private failed = false

  start (socketPath = waylandSocketPath(), timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!socketPath) {
        reject(new Error('no Wayland socket (WAYLAND_DISPLAY / XDG_RUNTIME_DIR unset)'))
        return
      }
      const fail = (err: Error) => {
        if (this.failed) return
        this.failed = true
        clearTimeout(timer)
        this.socket?.destroy()
        if (this.isActive) {
          this.isActive = false
          this.emit('error', err)
        } else {
          reject(err)
        }
      }
      const timer = setTimeout(() => fail(new Error(`no reply from the compositor within ${timeoutMs}ms`)), timeoutMs)

      this.socket = net.createConnection(socketPath)
      this.socket.on('error', (e) => fail(e))
      this.socket.on('close', () => fail(new Error('Wayland connection closed')))
      this.socket.on('connect', () => {
        this.send(DISPLAY_ID, DISPLAY_GET_REGISTRY, [REGISTRY_ID])
        this.send(DISPLAY_ID, DISPLAY_SYNC, [SYNC_GLOBALS_ID])
      })
      this.socket.on('data', (chunk) => {
        try {
          this.reader.push(chunk, (objectId, opcode, body) => {
            if (objectId === DISPLAY_ID && opcode === DISPLAY_EV_ERROR) {
              const [message] = readString(body, 8)
              fail(new Error(`Wayland protocol error ${body.readUInt32LE(4)}: ${message}`))
            } else if (objectId === REGISTRY_ID && opcode === REGISTRY_EV_GLOBAL) {
              const name = body.readUInt32LE(0)
              const [iface, off] = readString(body, 4)
              if (iface === FAKE_INPUT_INTERFACE) this.global = { name, version: body.readUInt32LE(off) }
            } else if (objectId === SYNC_GLOBALS_ID && opcode === CALLBACK_EV_DONE) {
              const g = this.global
              if (!g) {
                fail(new Error(`compositor offers no ${FAKE_INPUT_INTERFACE}`))
              } else if (g.version < MIN_VERSION) {
                fail(new Error(`${FAKE_INPUT_INTERFACE} v${g.version} has no keyboard_key`))
              } else {
                // untyped new_id: interface name, version, id
                this.send(REGISTRY_ID, REGISTRY_BIND, [g.name, FAKE_INPUT_INTERFACE, Math.min(g.version, BIND_VERSION), FAKE_INPUT_ID])
                this.send(FAKE_INPUT_ID, FAKE_INPUT_AUTHENTICATE, ['Awakened PoE Trade', 'Types chat messages and copies item text in Path of Exile'])
                // a protocol error from bind/authenticate would arrive before this reply
                this.send(DISPLAY_ID, DISPLAY_SYNC, [SYNC_AUTH_ID])
              }
            } else if (objectId === SYNC_AUTH_ID && opcode === CALLBACK_EV_DONE) {
              clearTimeout(timer)
              this.isActive = true
              resolve()
            }
          })
        } catch (e) {
          fail(e as Error)
        }
      })
    })
  }

  /** Writes are in order on one socket; no reply to wait for. */
  key (evdevCode: number, down: boolean) {
    if (!this.isActive) return
    this.send(FAKE_INPUT_ID, FAKE_INPUT_KEYBOARD_KEY, [evdevCode, down ? 1 : 0])
  }

  dispose () {
    this.failed = true
    this.isActive = false
    this.socket?.destroy()
  }

  private send (objectId: number, opcode: number, args: Array<number | string>) {
    this.socket!.write(encodeMessage(objectId, opcode, args))
  }
}
