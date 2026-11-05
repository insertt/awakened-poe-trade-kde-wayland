import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import type { AttachEvent } from 'electron-overlay-window'
import { overlayBackend } from './overlay-controller'
import { useKWin } from '../kde'
import { KWinController } from '../kde/KWinController'

export interface GameWindow {
  on: (event: 'active-change', listener: (isActive: boolean) => void) => this
}
export class GameWindow extends EventEmitter {
  private _isActive = false
  private _isTracking = false

  get bounds () { return overlayBackend.targetBounds }

  get isActive () { return this._isActive }

  set isActive (active: boolean) {
    if (this.isActive !== active) {
      this._isActive = active
      this.emit('active-change', this._isActive)
    }
  }

  get uiSidebarWidth () {
    // sidebar is 370px at 800x600
    const ratio = 370 / 600
    return Math.round(this.bounds.height * ratio)
  }

  constructor () {
    super()
  }

  attach (window: BrowserWindow | undefined, title: string) {
    if (!this._isTracking) {
      if (useKWin && !KWinController.isAvailable()) {
        throw new Error('APT_WINDOW_BACKEND=kwin requires a KDE Plasma Wayland session')
      }
      overlayBackend.events.on('focus', () => { this.isActive = true })
      overlayBackend.events.on('blur', () => { this.isActive = false })
      void Promise.resolve(overlayBackend.attachByTitle(window, title)).catch((e) => {
        console.error('[GameWindow] failed to attach', e)
      })
      this._isTracking = true
    }
  }

  onAttach (cb: (hasAccess: boolean | undefined) => void) {
    overlayBackend.events.on('attach', (e: AttachEvent) => {
      cb(e.hasAccess)
    })
  }

  screenshot () {
    return overlayBackend.screenshot()
  }
}
