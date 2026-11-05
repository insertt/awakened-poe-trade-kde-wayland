import path from 'path'
import { app, Tray, Menu, shell, nativeImage, dialog, type MenuItemConstructorOptions } from 'electron'
import type { ServerEvents } from './server'
import { readHostSettings, writeHostSettings, type WindowBackend } from './host-files/HostSettings'
import { kwinAvailable } from './kde'

export class AppTray {
  public overlayKey = 'Shift + Space'
  private tray: Tray
  serverPort = 0

  constructor (server: ServerEvents) {
    let trayImage = nativeImage.createFromPath(
      path.join(
        __dirname,
        process.env.STATIC!,
        process.platform === "win32" ? "icon.ico" : "icon.png"
      )
    )

    if (process.platform === 'darwin') {
      // Mac image size needs to be smaller, or else it looks huge. Size
      // guideline is from https://iconhandbook.co.uk/reference/chart/osx/
      trayImage = trayImage.resize({ width: 22, height: 22 })
    }

    this.tray = new Tray(trayImage)
    this.tray.setToolTip(`Awakened PoE Trade v${app.getVersion()}`)
    this.rebuildMenu()

    server.onEventAnyClient('CLIENT->MAIN::user-action', ({ action }) => {
      if (action === 'quit') {
        app.quit()
      }
    })
  }

  rebuildMenu () {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Settings/League',
        click: () => {
          dialog.showMessageBox({
            title: 'Settings',
            message: `Open Path of Exile and press "${this.overlayKey}". Click on the button with cog icon there.`
          })
        }
      },
      {
        label: 'Open in Browser',
        click: () => {
          shell.openExternal(`http://localhost:${this.serverPort}`)
        }
      },
      { type: 'separator' },
      ...this.windowBackendMenu(),
      {
        label: 'Open config folder',
        click: () => {
          shell.openPath(path.join(app.getPath('userData'), 'apt-data'))
        }
      },
      {
        label: 'Quit',
        click: () => {
          app.quit()
        }
      }
    ])

    this.tray.setContextMenu(contextMenu)
  }

  private windowBackendMenu (): MenuItemConstructorOptions[] {
    if (process.platform !== 'linux') return []

    const saved = readHostSettings().windowBackend
    const item = (backend: WindowBackend, label: string, enabled = true): MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked: saved === backend,
      enabled,
      click: () => { void this.switchWindowBackend(backend) }
    })
    return [{
      label: 'Window backend',
      submenu: [
        item('default', 'Default (X11 / XWayland)'),
        item('kwin', kwinAvailable ? 'KWin (KDE Plasma Wayland)' : 'KWin (needs KDE Plasma Wayland)', kwinAvailable)
      ]
    }]
  }

  private async switchWindowBackend (backend: WindowBackend) {
    if (readHostSettings().windowBackend === backend) return
    writeHostSettings({ windowBackend: backend })
    this.rebuildMenu()

    // the backend is picked at startup
    if (process.env.VITE_DEV_SERVER_URL) {
      await dialog.showMessageBox({
        title: 'Window backend',
        message: 'Saved. Restart "npm run dev" to use the new window backend.'
      })
      return
    }
    const { response } = await dialog.showMessageBox({
      title: 'Window backend',
      message: 'Awakened PoE Trade needs to restart to switch the window backend.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response !== 0) return
    // inside an AppImage, relaunch the AppImage itself: the mounted copy
    // disappears once this process exits
    app.relaunch(process.env.APPIMAGE
      ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) }
      : undefined)
    app.quit()
  }
}
