/**
 * gateway.js —— OneBot 版的网关（接口与官方 QQGateway 对齐）。
 *
 * 为什么还要包一层：main.js 里是按 `gateway.start() / gateway.stop()` 用的。
 * 包成同一个形状，main.js 就只需要**选哪一个**，不用改调用逻辑。
 */
import { OneBotClient } from './client.js'

export class OneBotGateway {
  /**
   * @param {object} opts
   * @param {import('./client.js').OneBotClient} [opts.client] 复用已有连接（推荐）
   * @param {string} [opts.wsUrl]
   * @param {string} [opts.httpUrl]
   * @param {string} [opts.token]
   * @param {string[]} [opts.selfIds]
   * @param {(msg:object)=>void} opts.onMessage
   * @param {Function} [opts.onReady]
   * @param {Function} [opts.onError]
   * @param {object} [opts.logger]
   */
  constructor({ client, wsUrl, httpUrl, token, selfIds, onMessage, onReady, onError, logger } = {}) {
    this.logger = logger
    this.onMessage = onMessage
    this.onReady = onReady
    this.onError = onError
    // ⚠️ 允许复用现成的 client：api 适配器和 gateway **必须共用同一个连接**，
    //    否则会开两条 WS、同一事件收两遍 → 她重复回复。
    this.client = client ?? new OneBotClient({ wsUrl, httpUrl, token, selfIds, logger })
    this.client.on('message', (msg) => this.onMessage?.(msg))
    this.client.on('ready', () => this.onReady?.())
    this.client.on('error', (err) => this.onError?.(err))
  }

  /** 暴露给引擎发消息用的 api 门面（由调用方包成 OneBotApiAdapter） */
  get rawClient() {
    return this.client
  }

  async start() {
    this.client.start()
    const ok = await this.client.ready(25_000)
    if (!ok) {
      this.logger?.warn?.('OneBot 25 秒内没连上 —— 检查 NapCat 是否在跑、地址/令牌对不对')
    }
    return ok
  }

  stop() {
    this.client.stop()
  }
}
