import { EventEmitter } from 'node:events'
import type { BrowserWindow, Rectangle } from 'electron'
import { CALLBACK_CFG, KWinScripts, scriptEvents, sendCommand } from './bus'
import trackerScript from './scripts/tracker.kwin.js'

const TRACKER_PLUGIN = 'apt-tracker'

export const OVERLAY_TITLE = 'Awakened PoE Trade Overlay'

/**
 * Drop-in counterpart of `OverlayController` from `electron-overlay-window`
 * for KDE Plasma 6 on Wayland. Emits the same events
 * (`attach`, `detach`, `focus`, `blur`, `moveresize`, `fullscreen`), plus
 * `cursor` ({ x, y }) while the game or overlay is active.
 *
 * COORDINATES: everything is reported relative to the game window's top-left.
 * Wayland clients don't know their global position (`window.screenX` is 0 in
 * the renderer), and the overlay always covers the game exactly, so
 * overlay-local == game-local and the renderer's `screenX`-based math still holds.
 *
 * Window tracking/placement is done by a script loaded into KWin; it reports
 * back over D-Bus. Wayland clients can't position or stack their own windows,
 * so that script also sets geometry + keepAbove on the overlay.
 *
 * FOCUS: on Wayland, showing a window activates it, so the overlay is mapped
 * only once and afterwards minimized/unminimized by the tracker. The tracker
 * also refuses to let the overlay keep focus unless we asked for it
 * (`activateOverlay`); otherwise showing it steals focus from the game, which
 * hides it again, and so on.
 */
export class KWinController {
  readonly events = new EventEmitter()
  /** game-local: x and y are always 0 */
  targetBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  /** global (compositor logical) origin of the game window */
  private origin = { x: 0, y: 0 }
  targetHasFocus = false

  private electronWindow?: BrowserWindow
  private focusNext: 'overlay' | 'target' | undefined
  private initialized = false
  private pendingFocus: Promise<void> = Promise.resolve()
  private seq = 0
  private acks = new Map<number, () => void>()
  /** the Electron window was shown once; from then on KWin (un)minimizes it */
  private overlayMapped = false
  private overlayShown = false

  static isAvailable (): boolean {
    return process.platform === 'linux' &&
      process.env.XDG_SESSION_TYPE === 'wayland' &&
      /kde/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')
  }

  constructor (
    private scripts: KWinScripts,
    private log: (msg: string) => void = () => {}
  ) {
    this.events.on('attach', () => {
      this.targetHasFocus = true
      this.electronWindow?.setIgnoreMouseEvents(true)
      this.showOverlay()
    })
    this.events.on('detach', () => {
      this.targetHasFocus = false
      this.hideOverlay()
    })
    this.events.on('blur', () => {
      this.targetHasFocus = false
      if (this.electronWindow &&
          this.focusNext !== 'overlay' && !this.electronWindow.isFocused()) {
        this.hideOverlay()
      }
    })
    this.events.on('focus', () => {
      this.focusNext = undefined
      this.targetHasFocus = true
      if (this.electronWindow) {
        this.electronWindow.setIgnoreMouseEvents(true)
        this.showOverlay()
      }
    })
    scriptEvents.on('ack', (p: { seq: number }) => {
      this.acks.get(p.seq)?.()
    })
  }

  async attachByTitle (electronWindow: BrowserWindow | undefined, gameTitle: string) {
    if (this.initialized) throw new Error('Controller can be initialized only once.')
    this.initialized = true
    this.electronWindow = electronWindow

    this.electronWindow?.on('blur', () => {
      if (!this.targetHasFocus && this.focusNext !== 'target') {
        this.hideOverlay()
      }
    })
    this.electronWindow?.on('focus', () => { this.focusNext = undefined })

    for (const type of ['attach', 'detach', 'moveresize', 'fullscreen', 'active', 'cursor']) {
      scriptEvents.on(type, (p) => this.handleScriptEvent(type, p))
    }
    const ready = new Promise<void>(resolve => scriptEvents.once('ready', () => resolve()))

    await this.scripts.run(TRACKER_PLUGIN, trackerScript, {
      ...CALLBACK_CFG,
      gameTitle,
      overlayTitle: OVERLAY_TITLE,
      overlayPid: process.pid
    })

    this.log(`info [KWin] Tracker script loaded, looking for a window titled "${gameTitle}"`)
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(
          'KWin script did not report back within 5s. ' +
          'Check `journalctl --user -b | grep -i kwin` for script errors.'
        )), 5000) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Give keyboard focus to the overlay (it becomes interactive). */
  activateOverlay () {
    this.focusNext = 'overlay'
    this.electronWindow?.setIgnoreMouseEvents(false)
    this.overlayShown = true
    this.pendingFocus = this.command('activate-overlay')
  }

  /** Give keyboard focus back to the game. */
  focusTarget () {
    this.focusNext = 'target'
    this.electronWindow?.setIgnoreMouseEvents(true)
    this.pendingFocus = this.command('focus-game')
  }

  /**
   * Resolves once KWin executed the last requested focus change.
   * Injected keys must wait for it, otherwise they go to the wrong window.
   */
  focusSettled (): Promise<void> {
    return this.pendingFocus
  }

  screenshot (): Buffer {
    throw new Error('Not implemented on your platform.')
  }

  private handleScriptEvent (type: string, p: any) {
    switch (type) {
      case 'attach':
        this.log(`info [KWin] Attached to game window: pid=${p.pid} class=${p.resourceClass} ` +
          `geometry=${JSON.stringify(p.geometry)} fullscreen=${p.isFullscreen} ` +
          `(windows with this title: ${p.matches})`)
        this.origin = { x: p.geometry.x, y: p.geometry.y }
        this.targetBounds = { x: 0, y: 0, width: p.geometry.width, height: p.geometry.height }
        this.events.emit('attach', { hasAccess: undefined, isFullscreen: p.isFullscreen, ...this.targetBounds })
        break
      case 'detach':
        this.log('info [KWin] Game window gone')
        this.events.emit('detach', {})
        break
      case 'moveresize':
        this.origin = { x: p.x, y: p.y }
        this.targetBounds = { x: 0, y: 0, width: p.width, height: p.height }
        this.events.emit('moveresize', this.targetBounds)
        break
      case 'fullscreen':
        this.events.emit('fullscreen', p)
        break
      case 'active':
        this.log(`debug [KWin] Active window: ${p.target}`)
        this.events.emit(p.target === 'game' ? 'focus' : 'blur', {})
        break
      case 'cursor':
        this.events.emit('cursor', { x: p.x - this.origin.x, y: p.y - this.origin.y })
        break
    }
  }

  private showOverlay () {
    if (!this.electronWindow || this.overlayShown) return
    this.overlayShown = true
    if (!this.overlayMapped) {
      // first time: the window has to be mapped for KWin to know it. KWin
      // activates it, and the tracker hands focus back to the game.
      this.overlayMapped = true
      this.electronWindow.showInactive()
    } else {
      void this.command('show-overlay')
    }
  }

  private hideOverlay () {
    if (!this.electronWindow || !this.overlayShown) return
    this.overlayShown = false
    void this.command('hide-overlay')
  }

  /** Resolves when the tracker executed the command (or after 500ms, so input can't get stuck). */
  private command (cmd: 'activate-overlay' | 'focus-game' | 'show-overlay' | 'hide-overlay'): Promise<void> {
    const seq = this.seq++
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.acks.delete(seq)
        resolve()
      }
      const timer = setTimeout(done, 500)
      this.acks.set(seq, done)
      sendCommand({ cmd, seq })
    })
  }
}
