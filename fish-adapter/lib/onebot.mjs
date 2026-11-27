// OneBot v11 客户端：WS 收事件推送（自动重连+退避），HTTP 发 action
export class OneBotClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.ws = null;
    this.stopped = false;
    this.retry = 0;
    this.onEvent = null; // (event) => void
    if (!globalThis.WebSocket) {
      throw new Error('此 Node 无全局 WebSocket（需要 Node ≥ 22.4）');
    }
  }

  start() { this._connect(); }

  // 与 NapCat 的 WS 是否已连接（readyState===OPEN）——控制台"鱼已上线"的判定信号
  get connected() {
    return Boolean(this.ws && this.ws.readyState === 1 && !this.stopped);
  }

  _connect() {
    if (this.stopped) return;
    const { wsUrl, accessToken } = this.cfg.onebot;
    // OneBot v11 标准鉴权：query 参数 access_token（undici WebSocket 不支持自定义 headers）
    // 注意补齐路径斜杠：ws://host:3001?x=... 缺 '/' 会被部分实现拒绝（实测 non-101）
    const base = wsUrl.endsWith('/') ? wsUrl.slice(0, -1) : wsUrl;
    const url = accessToken ? `${base}/?access_token=${encodeURIComponent(accessToken)}` : `${base}/`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retry = 0;
      import('./util.mjs').then(({ log }) => log('onebot', `WS connected: ${wsUrl}`));
    });
    ws.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(String(ev.data)); } catch { import('./util.mjs').then(({ log }) => log('onebot', 'WARN 收到非 JSON WS 帧，已忽略')); return; }
      // 只转发消息事件；心跳/元事件直接忽略
      if (data && data.post_type === 'message' && this.onEvent) {
        Promise.resolve(this.onEvent(data)).catch((e) => {
          import('./util.mjs').then(({ log }) => log('inbound', `handler error: ${e.message}`));
        });
      }
    });
    ws.addEventListener('close', () => this._reconnect('closed'));
    ws.addEventListener('error', (e) => {
      import('./util.mjs').then(({ log }) => log('onebot', `WS error: ${e?.message ?? ''}`));
      this._reconnect('error');
    });
  }

  _reconnect(why) {
    if (this.stopped) return;
    this.retry += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry, 5));
    import('./util.mjs').then(({ log }) => log('onebot', `${why}, retry in ${delay}ms (attempt ${this.retry})`));
    setTimeout(() => this._connect(), delay);
  }

  stop() {
    this.stopped = true;
    try { this.ws?.close(); } catch { /* 已断开 */ }
  }

  // action 走 NapCat HTTP 端口（比 WS echo 匹配简单可靠），带超时
  async action(name, params = {}) {
    const base = this.cfg.onebot.httpUrl.replace(/\/+$/, '');
    const token = this.cfg.onebot.accessToken || '';
    const res = await fetch(`${base}/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10_000),
    });
    return res.json();
  }
}
