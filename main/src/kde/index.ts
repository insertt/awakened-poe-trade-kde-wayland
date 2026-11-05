import path from 'node:path'
import { app } from 'electron'
import { uIOhook } from 'uiohook-napi'
import { KWinScripts } from './bus'
import { KWinController } from './KWinController'
import { RemoteDesktop } from './RemoteDesktop'
import { KdeInput } from './KdeInput'
import { KdeShortcuts } from './KdeShortcuts'
import { KdeClipboard } from './KdeClipboard'
import { WaylandKeyState } from './keystate'
import { OverlayRule } from './OverlayRule'

/** Prototype: opt-in with APT_WINDOW_BACKEND=kwin (KDE Plasma 6, Wayland session). */
export const useKWin = process.env.APT_WINDOW_BACKEND === 'kwin'

let logFn: (msg: string) => void = console.log
/** Messages use the RemoteLogger format: "<level> [Module] text". */
export function setKdeLogger (fn: (msg: string) => void) { logFn = fn }
// "debug ..." messages (focus changes, shortcut (un)registration) only with APT_KDE_DEBUG=1
const debugEnabled = Boolean(process.env.APT_KDE_DEBUG)
const log = (msg: string) => {
  if (msg.startsWith('debug ') && !debugEnabled) return
  // also to the terminal: the in-app log is hard to read while the game is focused
  console.log(`[kde] ${msg}`)
  if (logFn !== console.log) logFn(msg)
}

function create () {
  log(`info [KDE] Wayland backend enabled (session=${process.env.XDG_SESSION_TYPE}, ` +
    `desktop=${process.env.XDG_CURRENT_DESKTOP}, bus=${process.env.DBUS_SESSION_BUS_ADDRESS})`)
  const scripts = new KWinScripts()
  const controller = new KWinController(scripts, log)
  const rd = new RemoteDesktop(path.join(app.getPath('userData'), 'kde-remote-desktop.token'), log)
  const input = new KdeInput(controller, rd, log, () => {
    // listening only; key injection on Wayland goes through the RemoteDesktop portal
    uIOhook.start()
    return uIOhook
  }, () => new WaylandKeyState())
  const shortcuts = new KdeShortcuts(scripts, log)
  // before the overlay window exists, so it starts in the right layer
  const overlayRule = new OverlayRule(log)
  void overlayRule.add()
  const clipboard = new KdeClipboard(input, log)

  // KWin scripts outlive our process. A leftover shortcuts script would keep
  // grabbing the hotkeys system-wide, so unload everything before quitting
  // (and remove the window rule, which is part of the user's KWin config).
  let disposed = false
  app.on('will-quit', (e) => {
    if (disposed) return
    e.preventDefault()
    disposed = true
    const timeout = new Promise(resolve => setTimeout(resolve, 1000))
    void Promise.race([Promise.all([scripts.dispose(), overlayRule.remove()]), timeout]).finally(() => app.quit())
  })

  return { scripts, controller, input, shortcuts, clipboard }
}

export const kde = useKWin ? create() : undefined
