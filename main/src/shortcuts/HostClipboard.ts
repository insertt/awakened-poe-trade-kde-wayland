import type { Logger } from '../RemoteLogger'

const POLL_DELAY = 48
const POLL_LIMIT = 500

// PoE must read clipboard within this timeframe,
// after that we restore clipboard.
// If game lagged for some reason, it will read
// wrong content (= restored clipboard, potentially containing password).
const RESTORE_AFTER = 120

/** Electron's clipboard (async since Electron 44, see electron-clipboard.ts) or Klipper on KDE Wayland. */
export interface ClipboardLike {
  readText (): Promise<string>
  writeText (text: string): Promise<unknown>
}

/**
 * Ordering of simulated key presses with async work. Clipboard operations are
 * async, key presses are queued: a press waits for the barriers added before it.
 */
export interface InputSync {
  /** key presses queued after this call wait for `p` */
  barrier (p: Promise<unknown>): void
  /** resolves once queued key presses were delivered */
  idle (): Promise<void>
}

export class HostClipboard {
  private pollPromise?: Promise<string>
  private elapsed = 0
  private shouldRestore = false

  private isRestored = true

  get isPolling () { return this.pollPromise != null }

  constructor (
    private logger: Logger,
    private clipboard: ClipboardLike,
    private input: InputSync
  ) {}

  updateOptions (restoreClipboard: boolean) {
    this.shouldRestore = restoreClipboard
  }

  async readItemText (): Promise<string> {
    this.elapsed = 0
    if (this.pollPromise) {
      return await this.pollPromise
    }

    // The caller presses Ctrl+C right after this returns; the queued key
    // presses wait until the clipboard was read and cleared.
    const prepared = this.clipboard.readText()
      .then(text => this.clearBeforeCopy(text))
    this.input.barrier(prepared)

    this.pollPromise = prepared
      .then(textBefore => this.pollItemText(textBefore))
      .finally(() => { this.pollPromise = undefined })
    return this.pollPromise
  }

  /** Resolves with the text to restore later, after the clipboard was cleared. */
  private async clearBeforeCopy (textBefore: string): Promise<string> {
    const { clipboard } = this

    if (isPoeItem(textBefore)) {
      textBefore = ''
      if (process.platform !== 'linux') {
        await clipboard.writeText('')
      } else {
        // workaround KDE's "Prevent empty clipboard" feature
        // see https://github.com/SnosMe/awakened-poe-trade/issues/1790#issuecomment-4062830614
        await clipboard.writeText(`__APT_FORCE_EMPTY_${Date.now()}`)
      }
    } else if (process.platform === 'linux') {
      // workaround bug in Proton 10+ https://github.com/SnosMe/awakened-poe-trade/issues/1846
      await clipboard.writeText(`__APT_FORCE_EMPTY_${Date.now()}`)
    }
    return textBefore
  }

  private pollItemText (textBefore: string): Promise<string> {
    const { clipboard } = this

    return new Promise((resolve, reject) => {
      const poll = async () => {
        let textAfter: string
        try {
          textAfter = await clipboard.readText()
        } catch (e) {
          reject(e)
          return
        }

        if (isPoeItem(textAfter)) {
          if (this.shouldRestore) {
            void clipboard.writeText(textBefore)
          }
          resolve(textAfter)
        } else {
          this.elapsed += POLL_DELAY
          if (this.elapsed < POLL_LIMIT) {
            setTimeout(poll, POLL_DELAY)
          } else {
            if (this.shouldRestore) {
              void clipboard.writeText(textBefore)
            }

            if (!isPoeItem(textAfter)) {
              this.logger.write('warn [ClipboardPoller] No item text found.')
            }
            reject(new Error('Reading clipboard timed out'))
          }
        }
      }
      setTimeout(poll, POLL_DELAY)
    })
  }

  // when `shouldRestore` is false, this function continues
  // to work as a throttler for callback
  restoreShortly (cb: (clipboard: ClipboardLike) => void) {
    // Not only do we not overwrite the clipboard, but we don't exec callback.
    // This throttling helps against disconnects from "Too many actions".
    if (!this.isRestored) {
      return
    }

    this.isRestored = false
    this.clipboard.readText().then((saved) => {
      cb(this.clipboard)
      // restoring before simulated presses were delivered would make the game paste the restored text
      void this.input.idle().then(() => {
        setTimeout(() => {
          if (this.shouldRestore) {
            void this.clipboard.writeText(saved)
          }
          this.isRestored = true
        }, RESTORE_AFTER)
      })
    }, (e) => {
      this.logger.write(`error [HostClipboard] ${(e as Error).message}`)
      this.isRestored = true
    })
  }
}

function isPoeItem (text: string) {
  return LANGUAGE_DETECTOR.find(({ firstLine }) => text.startsWith(firstLine))
}

const LANGUAGE_DETECTOR = [{
  lang: 'en',
  firstLine: 'Item Class: '
}, {
  lang: 'ru',
  firstLine: 'Класс предмета: '
}, {
  lang: 'fr',
  firstLine: 'Classe d\'objet: '
}, {
  lang: 'de',
  firstLine: 'Gegenstandsklasse: '
}, {
  lang: 'pt',
  firstLine: 'Classe do Item: '
}, {
  lang: 'es',
  firstLine: 'Clase de objeto: '
}, {
  lang: 'th',
  firstLine: 'ชนิดไอเทม: '
}, {
  lang: 'ko',
  firstLine: '아이템 종류: '
}, {
  lang: 'cmn-Hant',
  firstLine: '物品種類: '
}, {
  lang: 'cmn-Hans',
  firstLine: '物品类别: '
}]
