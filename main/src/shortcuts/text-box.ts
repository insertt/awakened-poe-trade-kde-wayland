import { UiohookKey as Key } from 'uiohook-napi'
import { inputHook } from './input-backend'
import process from 'process';
import type { HostClipboard } from './HostClipboard'
import type { OverlayWindow } from '../windowing/OverlayWindow'

const PLACEHOLDER_LAST = '@last'
const AUTO_CLEAR = [
  '#', // Global
  '%', // Party
  '@', // Whisper
  '$', // Trade
  '&', // Guild
  '/' // Command
]

export function typeInChat (text: string, send: boolean, clipboard: HostClipboard) {
  clipboard.restoreShortly((clipboard) => {
    const modifiers = process.platform === 'darwin' ? [Key.Meta] : [Key.Ctrl]

    if (text.startsWith(PLACEHOLDER_LAST)) {
      text = text.slice(`${PLACEHOLDER_LAST} `.length)
      clipboard.writeText(text)
      inputHook.keyTap(Key.Enter, modifiers)
    } else if (text.endsWith(PLACEHOLDER_LAST)) {
      text = text.slice(0, -PLACEHOLDER_LAST.length)
      clipboard.writeText(text)
      inputHook.keyTap(Key.Enter, modifiers)
      inputHook.keyTap(Key.Home)
      // press twice to focus input when using controller
      inputHook.keyTap(Key.Home)
      inputHook.keyTap(Key.Delete)
    } else {
      clipboard.writeText(text)
      inputHook.keyTap(Key.Enter)
      if (!AUTO_CLEAR.includes(text[0])) {
        inputHook.keyTap(Key.A, modifiers)
      }
    }

    inputHook.keyTap(Key.V, modifiers)

    if (send) {
      inputHook.keyTap(Key.Enter)
      // restore the last chat
      inputHook.keyTap(Key.Enter)
      inputHook.keyTap(Key.ArrowUp)
      inputHook.keyTap(Key.ArrowUp)
      inputHook.keyTap(Key.Escape)
    }
  })
}

export function stashSearch (
  text: string,
  clipboard: HostClipboard,
  overlay: OverlayWindow
) {
  clipboard.restoreShortly((clipboard) => {
    overlay.assertGameActive()
    clipboard.writeText(text)
    inputHook.keyTap(Key.F, [Key.Ctrl])
    inputHook.keyTap(Key.V, [process.platform === 'darwin' ? Key.Meta : Key.Ctrl])
    inputHook.keyTap(Key.Enter)
  })
}
