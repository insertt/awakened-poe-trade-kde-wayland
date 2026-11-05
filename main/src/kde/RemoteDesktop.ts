import fs from 'node:fs'
import * as dbus from 'dbus-next'
import { getBus } from './bus'

const PORTAL = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'
const RD_IFACE = 'org.freedesktop.portal.RemoteDesktop'

const DEVICE_KEYBOARD = 1
const PERSIST_UNTIL_REVOKED = 2

/**
 * Keyboard injection through the XDG RemoteDesktop portal
 * (NotifyKeyboardKeycode with evdev keycodes), using plain D-Bus.
 *
 * The first start shows a KDE permission dialog. We ask the portal to persist
 * the grant and store the restore token, so later starts should not prompt
 * (if xdg-desktop-portal-kde honors persist_mode).
 */
export class RemoteDesktop {
  private session?: string
  private starting?: Promise<boolean>
  private tokenCounter = 0
  private matchAdded = false

  constructor (
    private tokenFile: string,
    private log: (msg: string) => void
  ) {}

  get isActive () { return this.session != null }

  /** Resolves to `true` if a session is running. Never rejects. */
  start (): Promise<boolean> {
    if (this.session) return Promise.resolve(true)
    if (!this.starting) {
      this.starting = this.doStart()
        .then(() => true, (e) => {
          this.log(`error [RemoteDesktop] ${(e as Error).message}. Key presses will not be sent to the game.`)
          return false
        })
        .finally(() => { this.starting = undefined })
    }
    return this.starting
  }

  async key (evdevCode: number, down: boolean) {
    if (!this.session) return
    const bus = await getBus()
    await bus.call(new dbus.Message({
      destination: PORTAL,
      path: PORTAL_PATH,
      interface: RD_IFACE,
      member: 'NotifyKeyboardKeycode',
      signature: 'oa{sv}iu',
      body: [this.session, {}, evdevCode, down ? 1 : 0]
    }))
  }

  private async doStart () {
    const bus = await getBus()
    await this.ensureMatch(bus)

    const created = await this.request(bus, 'CreateSession', 'a{sv}', (opts) => [{
      ...opts,
      session_handle_token: new dbus.Variant('s', this.token())
    }])
    const session = created.session_handle?.value as string
    if (!session) throw new Error('portal did not return a session handle')

    const restoreToken = this.readToken()
    await this.request(bus, 'SelectDevices', 'oa{sv}', (opts) => [session, {
      ...opts,
      types: new dbus.Variant('u', DEVICE_KEYBOARD),
      persist_mode: new dbus.Variant('u', PERSIST_UNTIL_REVOKED),
      ...(restoreToken ? { restore_token: new dbus.Variant('s', restoreToken) } : {})
    }])

    const started = await this.request(bus, 'Start', 'osa{sv}', (opts) => [session, '', opts])
    const devices = started.devices?.value as number | undefined
    if (devices !== undefined && !(devices & DEVICE_KEYBOARD)) {
      throw new Error('keyboard access was not granted')
    }
    const newToken = started.restore_token?.value as string | undefined
    if (newToken) this.writeToken(newToken)

    this.session = session
    this.watchClosed(bus, session)
    this.log('info [RemoteDesktop] Keyboard injection session started.')
  }

  /**
   * Portal methods return a Request object path and deliver the result later
   * in its `Response` signal. The path is predictable from `handle_token`, and
   * we match on all Response signals before calling, so none can be missed.
   */
  private async request (
    bus: dbus.MessageBus,
    member: string,
    signature: string,
    body: (opts: Record<string, dbus.Variant>) => any[]
  ): Promise<Record<string, dbus.Variant>> {
    const token = this.token()
    // unique name, e.g. ":1.42" -> "1_42"
    const sender = String((bus as any).name).slice(1).replace(/\./g, '_')
    const requestPath = `${PORTAL_PATH}/request/${sender}/${token}`

    const response = new Promise<Record<string, dbus.Variant>>((resolve, reject) => {
      const onMessage = (msg: dbus.Message) => {
        if (msg.type !== dbus.MessageType.SIGNAL || msg.path !== requestPath || msg.member !== 'Response') return
        bus.off('message', onMessage)
        const [code, results] = msg.body as [number, Record<string, dbus.Variant>]
        if (code === 0) resolve(results)
        else reject(new Error(`${member}: ${code === 1 ? 'permission denied by user' : 'cancelled'}`))
      }
      bus.on('message', onMessage)
    })

    await bus.call(new dbus.Message({
      destination: PORTAL,
      path: PORTAL_PATH,
      interface: RD_IFACE,
      member,
      signature,
      body: body({ handle_token: new dbus.Variant('s', token) })
    }))
    return response
  }

  private watchClosed (bus: dbus.MessageBus, session: string) {
    const onMessage = (msg: dbus.Message) => {
      if (msg.type === dbus.MessageType.SIGNAL && msg.path === session &&
          msg.interface === 'org.freedesktop.portal.Session' && msg.member === 'Closed') {
        bus.off('message', onMessage)
        this.session = undefined
        this.log('warn [RemoteDesktop] Session was closed (permission revoked?).')
      }
    }
    bus.on('message', onMessage)
  }

  private async ensureMatch (bus: dbus.MessageBus) {
    if (this.matchAdded) return
    this.matchAdded = true
    for (const rule of [
      "type='signal',interface='org.freedesktop.portal.Request',member='Response'",
      "type='signal',interface='org.freedesktop.portal.Session',member='Closed'"
    ]) {
      await bus.call(new dbus.Message({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'AddMatch',
        signature: 's',
        body: [rule]
      }))
    }
  }

  private token () { return `apt_${process.pid}_${this.tokenCounter++}` }

  private readToken (): string | undefined {
    try { return fs.readFileSync(this.tokenFile, 'utf8').trim() || undefined } catch { return undefined }
  }

  private writeToken (token: string) {
    try { fs.writeFileSync(this.tokenFile, token, { mode: 0o600 }) } catch {}
  }
}
