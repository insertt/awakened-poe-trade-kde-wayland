import { screen } from 'electron'
import { uIOhook } from 'uiohook-napi'
import { kde } from '../kde'
import type { InputSync } from './HostClipboard'

type InputHook = Pick<typeof uIOhook, 'on' | 'addListener' | 'removeListener' | 'start' | 'keyTap' | 'keyToggle'> & InputSync

/**
 * uiohook with simulated key presses queued behind pending clipboard
 * operations (see InputSync). Listening is passed through unchanged.
 */
function queuedUiohook (): InputHook {
  let chain: Promise<void> = Promise.resolve()
  let barriers: Array<Promise<unknown>> = []

  const enqueue = (press: () => void) => {
    // capture what this press must wait for *now*, not when the chain gets to it
    const waitFor = barriers
    barriers = []
    chain = chain
      .then(() => Promise.allSettled(waitFor))
      .then(press)
      .catch((e) => console.error('[input-backend]', e))
  }

  const hook = {
    on: (event: any, listener: any) => { uIOhook.on(event, listener); return hook },
    addListener: (event: any, listener: any) => { uIOhook.addListener(event, listener); return hook },
    removeListener: (event: any, listener: any) => { uIOhook.removeListener(event, listener); return hook },
    start: () => uIOhook.start(),
    keyTap: (key: number, modifiers?: number[]) => enqueue(() => uIOhook.keyTap(key, modifiers)),
    keyToggle: (key: number, toggle: 'down' | 'up') => enqueue(() => uIOhook.keyToggle(key, toggle)),
    barrier: (p: Promise<unknown>) => { barriers.push(p) },
    idle: () => chain
  }
  return hook as unknown as InputHook
}

/**
 * Global input listening + key injection: `uiohook-napi` (Windows, macOS, X11)
 * or the KDE Wayland backend, which emits the same event shapes.
 */
export const inputHook: InputHook = kde
  ? kde.input as unknown as InputHook
  : queuedUiohook()

/** Cursor position in the coordinate space of `inputHook` mouse events. */
export function getCursorPoint () {
  return kde ? kde.input.getCursorPoint() : screen.getCursorScreenPoint()
}
