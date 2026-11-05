import { WaylandFakeInput } from './fakeinput'
import type { RemoteDesktop } from './RemoteDesktop'

/**
 * Key injection: KWin's fake-input protocol if available (no notification),
 * otherwise the RemoteDesktop portal (KDE shows "remote control session started").
 */
export class KeyInjector {
  private fake?: WaylandFakeInput
  private starting?: Promise<boolean>

  constructor (
    private portal: RemoteDesktop,
    private log: (msg: string) => void
  ) {}

  get isActive () {
    return Boolean(this.fake?.isActive) || this.portal.isActive
  }

  /** Resolves to `true` if keys can be sent. Never rejects. */
  start (): Promise<boolean> {
    if (this.isActive) return Promise.resolve(true)
    if (!this.starting) {
      this.starting = this.doStart().finally(() => { this.starting = undefined })
    }
    return this.starting
  }

  async key (evdevCode: number, down: boolean) {
    if (this.fake?.isActive) {
      this.fake.key(evdevCode, down)
    } else {
      await this.portal.key(evdevCode, down)
    }
  }

  private async doStart (): Promise<boolean> {
    const fake = new WaylandFakeInput()
    try {
      await fake.start()
      fake.on('error', (e: Error) => {
        this.log(`warn [KeyInjector] Lost KWin fake-input connection: ${e.message}`)
      })
      this.fake = fake
      this.log('info [KeyInjector] Sending keys through KWin fake input.')
      return true
    } catch (e) {
      fake.dispose()
      this.log(`info [KeyInjector] KWin fake input unavailable (${(e as Error).message}), using the RemoteDesktop portal.`)
      return await this.portal.start()
    }
  }
}
