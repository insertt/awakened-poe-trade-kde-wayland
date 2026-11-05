import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * Settings owned by the main process, in `apt-data/host-settings.json`.
 *
 * Not part of config.json: that file belongs to the renderer, which rewrites
 * it as a whole on every save. These settings are also needed synchronously
 * at startup, before the renderer is loaded.
 */
export type WindowBackend = 'default' | 'kwin'

export interface HostSettings {
  /**
   * default: electron-overlay-window + uiohook (Windows, macOS, X11/XWayland)
   * kwin: KWin scripts, portals and the keystate protocol (KDE Plasma Wayland)
   */
  windowBackend: WindowBackend
}

const DEFAULTS: HostSettings = { windowBackend: 'default' }

const settingsPath = () => path.join(app.getPath('userData'), 'apt-data', 'host-settings.json')

export function readHostSettings (): HostSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    return {
      windowBackend: parsed.windowBackend === 'kwin' ? 'kwin' : 'default'
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeHostSettings (changes: Partial<HostSettings>) {
  const next = { ...readHostSettings(), ...changes }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n')
}
