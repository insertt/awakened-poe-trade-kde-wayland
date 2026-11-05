import path from 'node:path'
import { app } from 'electron'
import { uIOhook } from 'uiohook-napi'
import { KWinScripts } from './bus'
import { KWinController } from './KWinController'
import { RemoteDesktop } from './RemoteDesktop'
import { KdeInput } from './KdeInput'
import { KeyInjector } from './KeyInjector'
import { KdeShortcuts } from './KdeShortcuts'
import { KdeClipboard } from './KdeClipboard'
import { WaylandKeyState } from './keystate'
import { OverlayRule } from './OverlayRule'
import { readHostSettings } from '../host-files/HostSettings'

/** Window backend picked in host-settings.json (tray: "Window backend"). Read once at startup. */
export const selectedWindowBackend = readHostSettings().windowBackend
/** The KWin backend only works in a KDE Plasma Wayland session. */
export const kwinAvailable = KWinController.isAvailable()
export const useKWin = selectedWindowBackend === 'kwin' && kwinAvailable

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
  // the portal is only used if KWin's fake input isn't available
  const portal = new RemoteDesktop(path.join(app.getPath('userData'), 'kde-remote-desktop.token'), log)
  const input = new KdeInput(controller, new KeyInjector(portal, log), log, () => {
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

if (selectedWindowBackend === 'kwin' && !kwinAvailable) {
  log('warn [KDE] Window backend "KWin" needs a KDE Plasma Wayland session ' +
    `(session=${process.env.XDG_SESSION_TYPE}, desktop=${process.env.XDG_CURRENT_DESKTOP}); using the default backend.`)
}

export const kde = useKWin ? create() : undefined
