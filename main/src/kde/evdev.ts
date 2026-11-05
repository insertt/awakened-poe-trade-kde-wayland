import fs from 'node:fs'
import { Worker } from 'node:worker_threads'

/**
 * Optional passive keyboard/mouse listener reading /dev/input/event*.
 *
 * Wayland has no API for observing global input, so this is the only way to see
 * held modifiers (Alt-to-hide, "hold Ctrl" widgets), Ctrl+wheel stash scrolling
 * and mouse clicks while the game has focus. It needs read access to the input
 * devices (usually: user in the `input` group). We never ask for that access;
 * if the devices aren't readable this listener stays off and those features
 * are unavailable. Note: that access lets any process of the user read all
 * keystrokes, which is why it isn't set up automatically.
 *
 * Each device is read with blocking reads in its own worker thread. Async fs
 * reads would each hold a libuv threadpool thread forever and starve other
 * fs work in the main process.
 */

export const EV_KEY = 1
export const EV_REL = 2
export const REL_WHEEL = 8

export interface InputDevice { path: string, name: string, kind: 'keyboard' | 'mouse' }

/** Parse /proc/bus/input/devices and pick keyboards and mice. */
function findDevices (procText: string): InputDevice[] {
  const out: InputDevice[] = []
  for (const block of procText.split(/\n\s*\n/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1] ?? ''
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1].trim().split(/\s+/) ?? []
    const event = handlers.find(h => /^event\d+$/.test(h))
    if (!event) continue
    const keyBits = /^B: KEY=(.*)$/m.exec(block)?.[1].trim().split(/\s+/) ?? []
    // bitmap words are printed most-significant first; KEY_A (30) is in the last word
    const lastWord = keyBits.length ? BigInt('0x' + keyBits[keyBits.length - 1]) : 0n
    const hasKeyA = (lastWord & (1n << 30n)) !== 0n
    if (handlers.includes('kbd') && hasKeyA) {
      out.push({ path: `/dev/input/${event}`, name, kind: 'keyboard' })
    } else if (handlers.some(h => /^mouse\d+$/.test(h))) {
      out.push({ path: `/dev/input/${event}`, name, kind: 'mouse' })
    }
  }
  return out
}

/** Decode `struct input_event` records (64-bit layout, 24 bytes each). */
function decodeEvents (buf: Buffer, length: number): number[] {
  const out: number[] = []
  for (let off = 0; off + 24 <= length; off += 24) {
    const type = buf.readUInt16LE(off + 16)
    const code = buf.readUInt16LE(off + 18)
    const value = buf.readInt32LE(off + 20)
    if (type === EV_KEY || (type === EV_REL && code === REL_WHEEL)) out.push(type, code, value)
  }
  return out
}

// Kept as a plain string (not Function#toString) so minification can't break it.
// The worker only forwards raw bytes; decoding happens in the main thread.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const fd = fs.openSync(workerData.path, 'r')
const buf = Buffer.alloc(24 * 64)
for (;;) {
  let n
  try { n = fs.readSync(fd, buf, 0, buf.length, null) } catch (e) {
    parentPort.postMessage({ error: String(e) }); break
  }
  if (n > 0) parentPort.postMessage(buf.subarray(0, n))
}
`

export type RawHandler = (type: number, code: number, value: number) => void

/** Starts readers for all readable keyboards/mice. Returns the devices in use. */
export function startEvdev (onEvent: RawHandler, log: (msg: string) => void): InputDevice[] {
  if (process.arch !== 'x64' && process.arch !== 'arm64') return []
  let devices: InputDevice[]
  try {
    devices = findDevices(fs.readFileSync('/proc/bus/input/devices', 'utf8'))
  } catch { return [] }

  const readable = devices.filter(d => {
    try { fs.accessSync(d.path, fs.constants.R_OK); return true } catch { return false }
  })
  for (const dev of readable) {
    const worker = new Worker(WORKER_SRC, { eval: true, workerData: { path: dev.path } })
    worker.unref()
    worker.on('message', (msg: Uint8Array | { error: string }) => {
      if (!(msg instanceof Uint8Array)) {
        log(`warn [evdev] ${dev.name}: ${msg.error}`)
        return
      }
      const buf = Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength)
      const ev = decodeEvents(buf, buf.length)
      for (let i = 0; i < ev.length; i += 3) onEvent(ev[i], ev[i + 1], ev[i + 2])
    })
    worker.on('error', (e) => log(`warn [evdev] ${dev.name}: ${e.message}`))
  }
  return readable
}
