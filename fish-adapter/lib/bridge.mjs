// 文件桥（规格 §9 兜底）：webhook 入站传输层未实装时的替代通道
// 入站：QQ 消息 → 适配器入站链路 → 写 fishpond\.inbox\<ts>-<msgid>.json
// 出站：ZCode 会话（automations 触发）写 .outbox\<ts>.json → 适配器轮询 → 出站链路 → QQ
// 安全：.inbox/.outbox 在 fishpond 内，受 guard 钉死；鱼只能在这两个目录里交换数据
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './util.mjs';

// 包根推导：lib/ → fish-adapter/ → 包根（发布包与本机同构：fish-adapter 与 fishpond 同级）
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function bridgeDirs(cfg) {
  const base = cfg.bridge?.fishpondDir ?? join(PKG_ROOT, 'fishpond');
  const inbox = join(base, '.inbox');
  const outbox = join(base, '.outbox');
  return { inbox, outbox, base };
}

export function ensureBridgeDirs(cfg) {
  const { inbox, outbox } = bridgeDirs(cfg);
  mkdirSync(inbox, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  return bridgeDirs(cfg);
}

// 信箱索引：鱼会话无 Glob，用固定路径 .index.json 枚举待处理文件（适配器维护）
// 索引截断（P1 调优）：pending 只保留最新 maxPending 条，被挤出的积压直接删除（话题翻篇，不追旧消息）；
// 必回消息（must）优先保留，最后才被挤出
function updateIndex(inbox, mutator, maxPending = 10) {
  const indexFile = join(inbox, '.index.json');
  let idx = { pending: [] };
  try { idx = JSON.parse(readFileSync(indexFile, 'utf8')); } catch { /* 首次/损坏重建 */ }
  mutator(idx);
  // 兼容旧结构（字符串数组）并去重
  idx.pending = idx.pending
    .map((x) => (typeof x === 'string' ? { f: x, must: false } : x))
    .filter((x) => x && x.f);
  const seen = new Set();
  idx.pending = idx.pending.filter((x) => (seen.has(x.f) ? false : (seen.add(x.f), true)));
  // 截断：超限时先挤非必回的最旧，全是必回才挤最旧
  while (idx.pending.length > maxPending) {
    const i = idx.pending.findIndex((x) => !x.must);
    const rm = idx.pending.splice(i === -1 ? 0 : i, 1)[0];
    try { unlinkSync(join(inbox, rm.f)); } catch { /* 已消失 */ }
  }
  writeFileSync(indexFile, JSON.stringify(idx, null, 1), 'utf8');
}

// 入站投递：把组装好的报文写进 inbox（文件名带 ts + messageId 保证唯一/可去重）
export function writeInboxFile(cfg, payload) {
  const { inbox } = ensureBridgeDirs(cfg);
  const ts = Date.now();
  const name = `${ts}-${payload.messageId ?? 'noid'}.json`;
  writeFileSync(join(inbox, name), JSON.stringify(payload, null, 1), 'utf8');
  const max = cfg.p1?.maxPendingPerPoll ?? 10;
  updateIndex(inbox, (idx) => { idx.pending.push({ f: name, must: Boolean(payload.must) }); }, max);
  log('bridge', `inbound → ${name} (${payload.chatType} ${payload.chatId ?? payload.userId}${payload.must ? ' must' : ''})`);
  return name;
}

// 出站轮询：扫 outbox，逐个交给 processMessage，成功或确定性失败后删除文件
// outbox 文件格式：{ text, chatType, chatId, userId, replyToMessageId? }
export function startOutboxPolling(cfg, processMessage, intervalMs = 1000) {
  const { outbox } = ensureBridgeDirs(cfg);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const files = readdirSync(outbox).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        const full = join(outbox, f);
        let body;
        try {
          body = JSON.parse(readFileSync(full, 'utf8'));
        } catch (e) {
          log('bridge', `outbox parse fail ${f}: ${e.message}`);
          unlinkSync(full); // 损坏文件直接删，避免死循环
          continue;
        }
        const meta = {
          chatType: body.chatType,
          chatId: body.chatId,
          userId: body.userId,
          inboxFile: f,
          source: 'file-bridge',
        };
        const r = await processMessage(body.text, meta);
        // sent / dropped（确定性丢弃）→ 删文件；error（临时错误）→ 保留重试 ≤3 次；
        // defer（5min 窗口限额错峰）→ 文件原样保留，不耗重试次数，下一轮再来
        if (r.action === 'defer') continue;
        body._tries = (body._tries ?? 0) + 1;
        if (r.action === 'error' && body._tries < 3) {
          writeFileSync(full, JSON.stringify(body), 'utf8'); // 保留重试
          continue;
        }
        try { unlinkSync(full); } catch { /* 已消失 */ }
        // 联动清理对应 inbox 文件（guard 禁 Bash，模型删不了——由适配器代删，防重复处理）
        if (body.inboxFile) {
          try {
            unlinkSync(join(bridgeDirs(cfg).inbox, body.inboxFile));
            updateIndex(bridgeDirs(cfg).inbox, (idx) => { idx.pending = idx.pending.filter((x) => x.f !== body.inboxFile); }, cfg.p1?.maxPendingPerPoll ?? 10);
            log('bridge', `inbox ${body.inboxFile} 已清理`);
          } catch { /* 不存在或已清 */ }
        }
      }
    } catch (e) {
      log('bridge', `poll error: ${e.message}`);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
