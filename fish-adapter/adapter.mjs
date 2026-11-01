// fish-adapter 主入口：QQ(OneBot v11) ⇄ ZCode webhook bot 的桥
// 启动：start.cmd（或 node adapter.mjs）
// 链路：NapCat WS 事件 → inbound（过滤/解析/组装）→ POST ZCode /api/bots/webhook
//       ZCode 出站回调 → :3200/zcode → outbound（验签/过滤/审计/限额）→ NapCat HTTP
import { createServer } from 'node:http';
import { loadConfig, log } from './lib/util.mjs';
import { OneBotClient } from './lib/onebot.mjs';
import { createInbound } from './lib/inbound.mjs';
import { dedupHas } from './lib/inbound.mjs';
import { createOutbound } from './lib/outbound.mjs';
import { startOutboxPolling, ensureBridgeDirs } from './lib/bridge.mjs';

const cfg = loadConfig();
const FILE_MODE = cfg.bridge?.mode === 'file';

// —— 启动自检：占位符没填完 / 关键安全项为空 → 拒绝启动（fail-closed）——
function requireFilled(v, name) {
  if (v == null || String(v).includes('<') || String(v).includes('>') || String(v) === '') {
    log('boot', `config.${name} 未填写（当前值 ${JSON.stringify(v)}）—— 拒绝启动`);
    process.exit(1);
  }
}
requireFilled(cfg.onebot.selfId, 'onebot.selfId');
if (!FILE_MODE) {
  // file 桥模式不经过 ZCode bot 系统，无需 botId/callbackUrl
  requireFilled(cfg.zcode.botId, 'zcode.botId');
  requireFilled(cfg.zcode.callbackUrl, 'zcode.callbackUrl');
  if (!cfg.zcode.callbackUrl.includes('/api/bots/webhook')) {
    log('boot', `zcode.callbackUrl 应指向 /api/bots/webhook，当前: ${cfg.zcode.callbackUrl} —— 拒绝启动`);
    process.exit(1);
  }
  if (!cfg.zcode.secret) {
    log('boot', '警告: zcode.secret 为空 —— 出站验签已禁用（仅限本机回环 127.0.0.1 的临时模式）');
  }
}
if (!cfg.ownerQQ || String(cfg.ownerQQ).includes('<')) {
  log('boot', '警告: ownerQQ 未填写 —— 所有管理命令将被拒绝（fail-closed）');
}

// —— 组件装配 ——
const onebot = new OneBotClient(cfg);
const inbound = createInbound(cfg, onebot);
const outbound = createOutbound(cfg, onebot, inbound.state);
onebot.onEvent = (event) => inbound.handle(event);

// —— HTTP 服务：接收 ZCode 出站回调 ——
const server = createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1_000_000) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200).end('ok');
        return;
      }
      if (req.method === 'POST' && /^\/zcode(\?|$)/.test(req.url ?? '')) {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          res.writeHead(400).end('bad json');
          return;
        }
        await outbound.handle(req, res, body);
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      log('http', `error: ${e.stack ?? e.message}`);
      try { res.writeHead(500).end('internal error'); } catch { /* 已响应 */ }
    }
  });
});

// —— NapCat 事件流健康检查：每 2 分钟拉群最新消息，与去重表比对——
// 群里有新消息但从未经过入站（连续 2 轮）→ 事件流断流，告警（NapCat"假在线"故障，重启 NapCat 恢复）
const healthLastSeen = new Map();   // groupId -> 最新消息 id
const healthStale = new Map();      // groupId -> 连续漏单轮数
setInterval(async () => {
  for (const gid of cfg.allow.groups) {
    try {
      const r = await onebot.action('get_group_msg_history', { group_id: Number(/^\d+$/.test(gid) ? gid : 0), count: 1 });
      const m = r?.data?.messages?.at(-1);
      if (!m?.message_id) continue;
      const prev = healthLastSeen.get(gid);
      healthLastSeen.set(gid, m.message_id);
      if (prev && prev !== m.message_id && !dedupHas(m.message_id)) {
        const c = (healthStale.get(gid) ?? 0) + 1;
        healthStale.set(gid, c);
        if (c >= 2) log('health', `警告: 群 ${gid} 有新消息未入站（事件流疑似断流，连续 ${c} 轮），建议重启 NapCat`);
      } else {
        healthStale.set(gid, 0);
      }
    } catch (e) {
      log('health', `群 ${gid} 健康检查失败: ${e.message}`);
    }
  }
}, 120_000).unref();

server.listen(cfg.listen.port, '127.0.0.1', () => {
  log('boot', `fish-adapter listening on 127.0.0.1:${cfg.listen.port} (mode=${FILE_MODE ? 'file-bridge' : 'webhook'})`);
  log('boot', `selfId=${cfg.onebot.selfId}${FILE_MODE ? '' : ` botId=${cfg.zcode.botId}`}`);
  log('boot', `whitelist groups=${JSON.stringify(cfg.allow.groups)} private=${JSON.stringify(cfg.allow.private)}`);
  if (FILE_MODE) {
    ensureBridgeDirs(cfg);
    startOutboxPolling(cfg, (text, meta) => outbound.processMessage(text, meta));
    log('boot', '文件桥已启动：inbox/outbox 轮询 1s');
  }
  onebot.start();
});

// —— 优雅退出 ——
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('boot', `${sig} received, shutting down`);
    onebot.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
