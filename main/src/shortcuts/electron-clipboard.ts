import { clipboard } from 'electron'
import type { ClipboardLike, InputSync } from './HostClipboard'

/**
 * Electron's clipboard (async since Electron 44) as a `ClipboardLike`.
 *
 * Writes are input barriers: e.g. "write the chat text, then press Ctrl+V"
 * must not paste before the write completed. Reads wait for pending writes.
 */
export function electronClipboard (input: InputSync): ClipboardLike {
  let lastWrite: Promise<unknown> = Promise.resolve()
  return {
    async readText () {
      await lastWrite
      return await clipboard.readText()
    },
    writeText (text: string) {
      lastWrite = clipboard.writeText(text).catch(() => {})
      input.barrier(lastWrite)
      return lastWrite
    }
  }
}
