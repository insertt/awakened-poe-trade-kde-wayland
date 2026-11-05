// @ts-check
import child_process from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import electron from 'electron'
import esbuild from 'esbuild'

const isDev = !process.argv.includes('--prod')

/** Window backend from the dev app's host-settings.json (set via the tray), see HostSettings.ts */
function devWindowBackend () {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  try {
    const file = path.join(configHome, 'awakened-poe-trade', 'apt-data', 'host-settings.json')
    return JSON.parse(fs.readFileSync(file, 'utf8')).windowBackend
  } catch {
    return 'default'
  }
}

const electronRunner = (() => {
  /** @type {child_process.ChildProcess | null} */
  let handle = null
  /** @type {Promise<void>} */
  let queue = Promise.resolve()

  async function restart () {
    console.info('Restarting Electron process.')

    if (handle) {
      // wait for the old process to exit: until then it holds the
      // single-instance lock, and the new one would quit immediately
      const old = handle
      handle = null
      if (old.exitCode === null && old.signalCode === null) {
        await new Promise(resolve => { old.once('exit', resolve); old.kill() })
      }
    }
    const args = ['.']
    if (process.platform === 'linux' && devWindowBackend() !== 'kwin') {
      args.unshift('--ozone-platform=x11')
    }
    handle = child_process.spawn(String(electron), args, {
      stdio: 'inherit'
    })
  }

  return {
    // restarts run one after another, so rapid rebuilds can't overlap
    restart () { queue = queue.then(restart) }
  }
})()

const visionBuild = await esbuild.build({
  entryPoints: ['src/vision/link-worker.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'dist/vision.js'
})

const mainContext = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  loader: { '.kwin.js': 'text' },
  minify: !isDev,
  platform: 'node',
  // optional requires inside dbus-next (bundled), both inside try/catch with a fallback:
  // 'x11' finds the bus address via X11, 'usocket' is a native unix socket (falls back to `net`)
  external: ['electron', 'uiohook-napi', 'electron-overlay-window', 'x11', 'usocket'],
  outfile: 'dist/main.js',
  define: {
    'process.env.STATIC': (isDev) ? '"../build/icons"' : '"."',
    'process.env.VITE_DEV_SERVER_URL': (isDev) ? '"http://localhost:5173"' : 'null'
  },
  plugins: (isDev) ? [{
    name: 'electron-runner',
    setup (build) {
      build.onEnd((result) => {
        if (!result.errors.length) electronRunner.restart()
      })
    }
  }] : []
})

if (isDev) {
  await mainContext.watch()
} else {
  await mainContext.rebuild()
  mainContext.dispose()
}
