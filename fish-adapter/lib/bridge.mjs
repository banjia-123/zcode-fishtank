// 文件桥（规格 §9 兜底）：webhook 入站传输层未实装时的替代通道
// 入站：QQ 消息 → 适配器入站链路 → 写 fishpond\.inbox\<ts>-<msgid>.json
// 出站：ZCode 会话（automations 触发）写 .outbox\<ts>.json → 适配器轮询 → 出站链路 → QQ
// 安全：.inbox/.outbox 在 fishpond 内，受 guard 钉死；鱼只能在这两个目录里交换数据
// v6（改造任务书阶段 1）：outbox 整对象传递（新格式 {lines,...} 与老格式 {text} 并存）、
// 解析三级兜底（不许静默丢）、inbox 溢出必留痕、inbox 文件删除以适配器注入名为准（D3）
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, ROOT_DIR } from './util.mjs';

// 包根推导：lib/ → fish-adapter/ → 包根（发布包与本机同构：fish-adapter 与 fishpond 同级）
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const LOG_DIR = join(ROOT_DIR, 'logs'); // fish-adapter/logs/（丢弃留痕走适配器日志目录，鱼够不到）

// 丢弃留痕（D6）：任何静默 unlink 前必须先写这里——静默丢消息没法排查
function recordDrop(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'dropped.jsonl'), JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8');
  } catch (e) {
    // 这条 catch 是"丢消息排查"的最后防线，自己失败不能无声：双通道告警（log 可能同因失败，console 兜底）
    console.error(`[bridge] recordDrop 自身失败（丢弃留痕丢失）: ${e.message}`);
    try { log('bridge', `WARN recordDrop 自身失败（丢弃留痕丢失）: ${e.message}`); } catch { /* log 也不行了 */ }
  }
}

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
// 索引截断（P1 调优 + D6）：pending 只保留最新 maxPending 条；挤出必留痕 dropped.jsonl，
// 必回消息（must）优先保留（优先挤非 must，全是 must 才丢最旧并告警）——禁止静默 unlink
const MAX_PENDING_DEFAULT = 50; // 索引上限默认（原三处各写一份 50）
function updateIndex(inbox, mutator, maxPending = MAX_PENDING_DEFAULT) {
  const indexFile = join(inbox, '.index.json');
  let idx = { pending: [] };
  try { idx = JSON.parse(readFileSync(indexFile, 'utf8')); } catch (e) {
    // 首次 ENOENT 静默；损坏重建要留痕——索引清空 = 已在 inbox 的待处理文件失去索引，消息将滞留至 7 天 sweep
    if (e?.code !== 'ENOENT') log('bridge', `WARN 信箱索引损坏，按空重建（已在 inbox 的待处理文件将滞留）: ${e.message}`);
  }
  mutator(idx);
  // 兼容旧结构（字符串数组）并去重
  idx.pending = idx.pending
    .map((x) => (typeof x === 'string' ? { f: x, must: false } : x))
    .filter((x) => x && x.f);
  const seen = new Set();
  idx.pending = idx.pending.filter((x) => (seen.has(x.f) ? false : (seen.add(x.f), true)));
  // 截断：超限时先挤非必回的最旧，全是必回才挤最旧（告警）
  while (idx.pending.length > maxPending) {
    const i = idx.pending.findIndex((x) => !x.must);
    const at = i === -1 ? 0 : i;
    const rm = idx.pending.splice(at, 1)[0];
    recordDrop({ file: rm.f, must: rm.must, reason: 'pending-overflow' });
    if (i === -1) log('bridge', `WARN pending 全为必回仍溢出，挤掉最旧: ${rm.f} [must]`);
    try { unlinkSync(join(inbox, rm.f)); } catch { /* 已消失 */ }
  }
  writeFileSync(indexFile, JSON.stringify(idx, null, 1), 'utf8');
}

// 入站投递：把组装好的报文写进 inbox（文件名带 ts + messageId 保证唯一/可去重）
// opts.archive=true（patrol 留档模式）：文件照写但不进 .index.json——信箱任务不消费这批消息，
// 防止本地巡逻与老链路双回复；文件留在原处供失败重放与排查，回滚（patrol 关闭）后新消息恢复进索引
export function writeInboxFile(cfg, payload, opts = {}) {
  const { inbox } = ensureBridgeDirs(cfg);
  const ts = Date.now();
  const name = `${ts}-${payload.messageId ?? 'noid'}.json`;
  writeFileSync(join(inbox, name), JSON.stringify(payload, null, 1), 'utf8');
  if (!opts.archive) {
    const max = cfg.p1?.maxPendingPerPoll ?? MAX_PENDING_DEFAULT;
    updateIndex(inbox, (idx) => { idx.pending.push({ f: name, must: Boolean(payload.must) }); }, max);
  }
  log('bridge', `inbound → ${name} (${payload.chatType} ${payload.chatId ?? payload.userId}${payload.must ? ' must' : ''}${opts.archive ? ' archive' : ''})`);
  return name;
}

// —— S4·存档滚动清理（通用）：目录内 <ts>-xxx 命名文件的 ts 超过 maxAge 即删 ——
// 不进 dropped.jsonl（那是"丢用户消息"的告警流），只写适配器日志。怪名/子目录跳过（保守）
export function sweepTsFiles(dir, maxAgeMs, label) {
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const ts = Number(f.name.split('-')[0]);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (ts < cutoff) { try { unlinkSync(join(dir, f.name)); removed++; } catch { /* 已消失 */ } }
    }
  } catch (e) { log('bridge', `${label} sweep error: ${e.message}`); }
  if (removed) log('bridge', `${label}滚动清理：删除 ${removed} 个超龄存底（>${Math.round(maxAgeMs / 86_400_000)} 天）`);
  return removed;
}

// inbox 留档（patrol archive 模式的排障档，消息本身已被秒回链路消费）：7 天滚动
export function sweepInboxArchive(cfg, maxAgeMs = 7 * 24 * 3600_000) {
  return sweepTsFiles(join(bridgeDirs(cfg).base, '.inbox'), maxAgeMs, 'inbox 留档');
}

// 表情回收站（emojis/.trash，文件名 <ts>-<原名>）：7 天反悔窗口，过期自动清释放空间
export function sweepEmojiTrash(cfg, maxAgeMs = 7 * 24 * 3600_000) {
  return sweepTsFiles(join(bridgeDirs(cfg).base, 'emojis', '.trash'), maxAgeMs, '表情回收站');
}

// —— S1.4 / D11 · outbox 解析三级兜底：格式不对绝不静默丢用户的消息 ——
// ① 直接 parse → ② 剥 Markdown 代码围栏再试 → ③ 取第一个平衡的 {...} 片段再试 → ④ 整段当 text 走老逻辑
// 返回 { body, degraded? }；degraded = 'fence' | 'fragment' | 'plaintext'
export function parseOutboxBody(raw) {
  try { return { body: JSON.parse(raw) }; } catch { /* 继续降级 */ }
  const stripped = raw.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  try { return { body: JSON.parse(stripped), degraded: 'fence' }; } catch { /* 继续降级 */ }
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === '{') depth += 1;
      else if (raw[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return { body: JSON.parse(raw.slice(start, i + 1)), degraded: 'fragment' }; } catch { /* 平衡但仍非法 → 最终降级 */ }
          break;
        }
      }
    }
  }
  return { body: { text: raw }, degraded: 'plaintext' };
}

// 降级计数（S1.4）：同一小时内累计 3 次 → WARN（内存即可，重启归零无害）
const degradeCount = new Map(); // hourKey -> count
function noteDegrade(kind) {
  const hourKey = `${Math.floor(Date.now() / 3600_000)}|${kind}`;
  const n = (degradeCount.get(hourKey) ?? 0) + 1;
  degradeCount.set(hourKey, n);
  if (n === 3) log('bridge', `WARN outbox 结构降级 3 次（kind=${kind}）——检查模型输出格式`);
}

// 出站轮询：扫 outbox，逐个交给 processMessage，成功或确定性失败后删除文件
// outbox 文件格式（并存，按字段判断不按版本号）：
//   老格式 { text, chatType, chatId, userId, replyToMessageId? }
//   新格式 { v:2, lines:[...], reply_to?, sticker?, voice?, silent?, chatType, chatId, userId }
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
        const raw = readFileSync(full, 'utf8');
        const { body, degraded } = parseOutboxBody(raw);
        if (degraded) {
          noteDegrade(degraded);
          log('bridge', `WARN outbox 降级为纯文本 ${f} reason=${degraded}（len=${raw.length}，不丢，照常发送）`);
        }
        const meta = {
          chatType: body.chatType,
          chatId: body.chatId,
          userId: body.userId,
          inboxFile: f,
          // inbox 文件名 = <ts>-<messageId>.json：解析出被回复消息的 QQ id，供出站挂引用（群友看到她在回谁）
          replyToMessageId: (f.match(/-(\d+)\.json$/)?.[1]) ?? null,
          source: 'file-bridge',
        };
        const r = await processMessage(body, meta);
        // sent / dropped（确定性丢弃）→ 删文件；error（临时错误）→ 保留重试 ≤3 次；
        // defer（5min 窗口限额错峰）→ 文件原样保留，不耗重试次数，下一轮再来
        if (r.action === 'defer') continue;
        body._tries = (body._tries ?? 0) + 1;
        if (r.action === 'error' && body._tries < 3) {
          writeFileSync(full, JSON.stringify(body), 'utf8'); // 保留重试
          continue;
        }
        try { unlinkSync(full); } catch { /* 已消失 */ }
        // 联动清理对应 inbox 文件（guard 禁 Bash，模型删不了——由适配器代删，防重复处理）。
        // D3：只认适配器注入的文件名（= 本 outbox 文件名，同名机制），模型输出里的 inboxFile 不被信任
        if (r.action === 'sent' || r.action === 'dropped') {
          try {
            unlinkSync(join(bridgeDirs(cfg).inbox, f));
            updateIndex(bridgeDirs(cfg).inbox, (idx) => { idx.pending = idx.pending.filter((x) => x.f !== f); }, cfg.p1?.maxPendingPerPoll ?? MAX_PENDING_DEFAULT);
            log('bridge', `inbox ${f} 已清理`);
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
