import path from 'node:path'

// Minimal Wayland wire protocol helpers for our own small Wayland clients
// (keystate.ts, fakeinput.ts). Electron doesn't expose these KDE protocols.
//
// Message: [object id: u32][size << 16 | opcode: u32][args...], host byte order (LE).

/** Path of the compositor socket, per the Wayland client library's rules. */
export function waylandSocketPath (env = process.env): string | undefined {
  const display = env.WAYLAND_DISPLAY || 'wayland-0'
  if (path.isAbsolute(display)) return display
  if (!env.XDG_RUNTIME_DIR) return undefined
  return path.join(env.XDG_RUNTIME_DIR, display)
}

export function encodeMessage (objectId: number, opcode: number, args: Array<number | string>): Buffer {
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

export function readString (body: Buffer, offset: number): [string, number] {
  const len = body.readUInt32LE(offset)
  const str = body.toString('utf8', offset + 4, offset + 4 + Math.max(0, len - 1))
  return [str, offset + 4 + Math.ceil(len / 4) * 4]
}

/** Splits a byte stream into complete messages; keeps partial ones for the next chunk. */
export class MessageReader {
  private pending: Buffer = Buffer.alloc(0)

  push (chunk: Buffer, onMessage: (objectId: number, opcode: number, body: Buffer) => void) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    while (this.pending.length >= 8) {
      const objectId = this.pending.readUInt32LE(0)
      const word = this.pending.readUInt32LE(4)
      const size = word >>> 16
      if (size < 8) throw new Error(`malformed Wayland message (size ${size})`)
      if (this.pending.length < size) break
      const body = this.pending.subarray(8, size)
      this.pending = this.pending.subarray(size)
      onMessage(objectId, word & 0xffff, body)
    }
  }
}
