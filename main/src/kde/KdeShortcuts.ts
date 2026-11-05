import { CALLBACK_CFG, KWinScripts, scriptEvents } from './bus'
import { shortcutToQt } from './keymap'
import shortcutsScript from './scripts/shortcuts.kwin.js'

const PLUGIN = 'apt-shortcuts'

export interface ShortcutEntry {
  shortcut: string // APT format, e.g. "Ctrl + D"
  callback: () => void
}

/**
 * Global shortcuts through a KWin script (KGlobalAccel). Mirrors how Shortcuts.ts
 * uses Electron's globalShortcut: everything is registered while the game is
 * focused and unregistered when it isn't.
 *
 * Each `set`/`clear` gets a new generation number; events from older script
 * instances are ignored, and operations run one at a time.
 */
export class KdeShortcuts {
  private gen = 0
  private callbacks = new Map<number, () => void>()
  private names = new Map<number, string>()
  private queue: Promise<void> = Promise.resolve()

  constructor (
    private scripts: KWinScripts,
    private log: (msg: string) => void
  ) {
    scriptEvents.on('shortcut', (p) => {
      if (p.gen === this.gen) this.callbacks.get(p.id)?.()
    })
    scriptEvents.on('shortcuts-ready', (p) => {
      if (p.gen === this.gen) {
        this.log(`debug [Shortcuts] KWin registered: ${[...this.names.values()].join(', ') || '(none)'}`)
      }
    })
    scriptEvents.on('shortcut-failed', (p) => {
      if (p.gen === this.gen) {
        this.log(`error [Shortcuts] KWin failed to register "${this.names.get(p.id)}".`)
      }
    })
  }

  set (entries: ShortcutEntry[]) {
    const gen = ++this.gen
    this.callbacks.clear()
    this.names.clear()

    const shortcuts: Array<{ id: number, name: string, text: string, seq: string }> = []
    entries.forEach((entry, id) => {
      const seq = shortcutToQt(entry.shortcut)
      if (!seq) {
        this.log(`error [Shortcuts] Hotkey "${entry.shortcut}" is not supported on KDE Wayland.`)
        return
      }
      this.callbacks.set(id, entry.callback)
      this.names.set(id, entry.shortcut)
      shortcuts.push({
        id,
        name: `Awakened PoE Trade: ${seq}`,
        text: `Awakened PoE Trade: ${entry.shortcut}`,
        seq
      })
    })

    this.enqueue(async () => {
      if (gen !== this.gen) return // superseded before it ran
      this.log(`debug [Shortcuts] Loading shortcuts script (game focused): ${shortcuts.map(s => s.seq).join(', ') || '(none)'}`)
      await this.scripts.run(PLUGIN, shortcutsScript, { ...CALLBACK_CFG, gen, shortcuts })
    })
  }

  clear () {
    ++this.gen
    this.callbacks.clear()
    this.names.clear()
    this.enqueue(async () => {
      this.log('debug [Shortcuts] Unloading shortcuts script (game not focused)')
      await this.scripts.unload(PLUGIN)
    })
  }

  private enqueue (op: () => Promise<void>) {
    this.queue = this.queue.then(op).catch((e) => {
      this.log(`error [Shortcuts] ${(e as Error).message}`)
    })
  }
}
