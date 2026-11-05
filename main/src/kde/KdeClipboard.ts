import { callMethod } from './bus'
import type { KdeInput } from './KdeInput'
import type { ClipboardLike } from '../shortcuts/HostClipboard'
import { electronClipboard } from '../shortcuts/electron-clipboard'

/**
 * Clipboard through Klipper's D-Bus API (org.kde.klipper /klipper).
 *
 * As a native Wayland client, Chromium only learns about clipboard changes while
 * it has keyboard focus, and setting the clipboard needs focus too. APT reads
 * the item text right after sending Ctrl+C *to the game* and writes the chat
 * text while the game is focused, so it can't rely on Electron's clipboard.
 * Klipper is privileged and sees the clipboard regardless of focus.
 *
 * Falls back to Electron's clipboard if Klipper isn't available.
 */
export class KdeClipboard implements ClipboardLike {
  private hasKlipper = false
  private lastWrite: Promise<unknown> = Promise.resolve()
  private fallback: ClipboardLike

  constructor (
    private input: KdeInput,
    private log: (msg: string) => void
  ) {
    this.fallback = electronClipboard(input)
  }

  async init () {
    try {
      await klipper('getClipboardContents')
      this.hasKlipper = true
    } catch (e) {
      this.log('warn [KdeClipboard] Klipper is not available, falling back to Electron clipboard. ' +
        'Reading item text will likely fail while the game is focused.')
    }
  }

  async readText (): Promise<string> {
    if (!this.hasKlipper) return await this.fallback.readText()
    await this.lastWrite
    return await klipper('getClipboardContents')
  }

  writeText (text: string): Promise<unknown> {
    if (!this.hasKlipper) return this.fallback.writeText(text)
    const p = klipper('setClipboardContents', 's', [text])
      .catch((e: Error) => this.log(`error [KdeClipboard] ${e.message}`))
    this.lastWrite = p
    // e.g. typeInChat writes the clipboard and then presses Ctrl+V:
    // the paste must not reach the game before the write is done
    this.input.barrier(p)
    return p
  }
}

function klipper (member: string, signature = '', body: any[] = []) {
  return callMethod('org.kde.klipper', '/klipper', 'org.kde.klipper.klipper', member, signature, body)
}
