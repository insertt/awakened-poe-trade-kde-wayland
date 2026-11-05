import type { EventEmitter } from 'node:events'
import type { BrowserWindow, Rectangle } from 'electron'
import { OverlayController } from 'electron-overlay-window'
import { kde } from '../kde'

/** Common surface of `electron-overlay-window` and `KWinController`. */
export interface WindowBackend {
  readonly events: EventEmitter
  readonly targetBounds: Rectangle
  activateOverlay (): void
  focusTarget (): void
  screenshot (): Buffer
  attachByTitle (window: BrowserWindow | undefined, title: string): void | Promise<void>
}

export const overlayBackend: WindowBackend = kde
  ? kde.controller
  : {
      get events () { return OverlayController.events },
      get targetBounds () { return OverlayController.targetBounds },
      activateOverlay: () => OverlayController.activateOverlay(),
      focusTarget: () => OverlayController.focusTarget(),
      screenshot: () => OverlayController.screenshot(),
      attachByTitle: (w, title) => OverlayController.attachByTitle(w, title, { hasTitleBarOnMac: true })
    }
