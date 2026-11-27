// wakeSafe 护栏（D14/D14b/S2.7/S2.8/S2.9/S2.13）：包着 app-server 客户端的唯一入口
//   并发闸：全局同时最多 2 个唤醒，其余 FIFO 排队；同 chatKey 串行（上一轮没回不开下一轮）
//   熔断：同群连续失败 3 次 → 暂停 10 分钟（内存表，重启可丢——进程重启本身算一次恢复）
//   超时：90s（在客户端层）；超时/失败批次直接丢弃，绝不留到下轮拿旧消息去回
//   限额：maxDailyWakes 按唤醒次数计（state/wake-counters.json 落盘，跨重启；损坏按已达上限保守拦截）
//   静默时段/最小间隔：本地判断，命中不调模型——别叫醒模型再让它沉默，那是花钱买沉默
//   留痕：logs/wake.jsonl 每次唤醒一行（D8：没有这一行阶段 2 不算完成）
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, ROOT_DIR } from '../lib/util.mjs';

// 与 outbound 的 SILENT_PREFIX 同款（复制而非 import：不动 S1 已验收的出站模块）
const SILENT_RE = /^\s*\[?(SILENT|沉默|不说话|pass)\]?(?![a-zA-Z])/i;

const STATE_FILE = join(ROOT_DIR, 'state', 'wake-counters.json');
const WAKE_LOG = join(ROOT_DIR, 'logs', 'wake.jsonl');

// D13 同款保守读：损坏 = 视为已达上限（宁可哑，不可失控烧额度）；文件不存在 = 首跑，正常归零
function loadCounters(maxWakes) {
  let raw;
  try { raw = readFileSync(STATE_FILE, 'utf8'); } catch { return { day: dayKey(), dailyWakes: 0 }; }
  try {
    const c = JSON.parse(raw);
    if (c && typeof c === 'object' && c.day === dayKey()) return c;
    return { day: dayKey(), dailyWakes: 0 }; // 跨天归零
  } catch {
    return { day: dayKey(), dailyWakes: maxWakes + 1, corrupted: true };
  }
}
function saveCounters(c) {
  try {
    mkdirSync(join(ROOT_DIR, 'state'), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(c), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch { /* 落盘失败不阻断（内存值仍有效） */ }
}
function dayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } // 本地日（原 UTC 日界归零在早 8 点，体感错位——2026-11-21 修正）

function logWake(obj) {
  try {
    mkdirSync(join(ROOT_DIR, 'logs'), { recursive: true });
    appendFileSync(WAKE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8');
  } catch { /* 留痕失败不阻断 */ }
}

// 唤醒思维链 trace（2026-11-22 施法事故后加）：prompt/thinking/reply 全量落独立文件，控制台工作日志 ▶ 展开
// 即看完整闭环。与 wake.jsonl 分文件的原因：审计红线本体不动（wake.jsonl 仍不落原文），trace 是新约定的
// 排查旁路——prompt 含入站原文，但 chat.jsonl（学习数据源）本就全量落原文，不新增敏感信息。
// 轮转上限 8MB 见 lib/rotate.mjs（比其他日志宽：单条 5~10KB，8MB ≈ 一周热闹量）。
const WAKE_TRACE = join(ROOT_DIR, 'logs', 'wake-trace.jsonl');

function logTrace(obj) {
  try {
    mkdirSync(join(ROOT_DIR, 'logs'), { recursive: true });
    appendFileSync(WAKE_TRACE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8');
  } catch { /* 留痕失败不阻断 */ }
}

const attPaths = (a) => Array.isArray(a) ? a.map((x) => x?.path ?? x?.localPath ?? '').filter(Boolean) : [];

// 静默时段（本地判断；跨午夜区间如 01:00→07:00 正确处理）
export function inSilentHours(silentHours, now = new Date()) {
  const { start, end } = silentHours ?? {};
  if (!start || !end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return false;
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

export function createWakeSafe(cfg, client) {
  const P = cfg.patrol ?? {};
  const maxConcurrent = 2;
  const minIntervalMs = P.minWakeIntervalMs ?? 20_000;
  const maxDailyWakes = P.maxDailyWakes ?? 100;
  const privateMaxPerDay = cfg.private?.maxPerDay ?? 30; // S3.2：私聊独立每日上限，与全局总额各过一遍
  const wakeTimeoutMs = P.wakeTimeoutMs ?? 90_000;

  const failStreak = new Map(); // chatKey -> 连续失败数（D14）
  const pausedUntil = new Map(); // chatKey -> 熔断至（D14）
  const lastWakeAt = new Map(); // chatKey -> 上次唤醒时刻（S2.13 最小间隔）
  const queue = []; // FIFO 作业 {chatKey, run, resolve, reject, enqueuedAt}
  const busyKeys = new Set(); // 串行中的 chatKey（D14b）
  let active = 0;

  let counters = loadCounters(maxDailyWakes);

  // 唤醒前的全部本地闸门（S2.9/S2.13/D14/S3.2）：不满足直接不唤醒，一分钱不花
  // must 批次（@/叫名）只豁免最小间隔——有人叫她必须回；静默/熔断/每日上限仍拦
  // 私聊三条覆盖（S3.2）：不套群静默时段（半夜来一条，回一句比装死好）；
  //   但私聊独立每日上限和全局总额各过一遍（不是二选一），防陌生人一条消息烧额度
  function gate(chatKey, isMust = false) {
    const isPrivate = chatKey.startsWith('p:');
    if (!isPrivate && inSilentHours(P.silentHours)) return 'silent-hours';
    const pu = pausedUntil.get(chatKey) ?? 0;
    if (Date.now() < pu) return `circuit-open(until ${Math.round((pu - Date.now()) / 1000)}s)`;
    if (counters.day !== dayKey()) { counters = { day: dayKey(), dailyWakes: 0, privateWakes: 0 }; saveCounters(counters); }
    if (counters.dailyWakes >= maxDailyWakes) return `limit-daily-wakes(${counters.dailyWakes})`;
    if (isPrivate && (counters.privateWakes ?? 0) >= privateMaxPerDay) return `limit-private-per-day(${counters.privateWakes}/${privateMaxPerDay})`;
    if (!isMust) {
      const lw = lastWakeAt.get(chatKey) ?? 0;
      if (Date.now() - lw < minIntervalMs) return `min-interval(${Math.round((Date.now() - lw) / 1000)}s ago)`;
    }
    return null; // 放行
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const idx = queue.findIndex((j) => !busyKeys.has(j.chatKey));
      if (idx === -1) break; // 队头全是同群串行等待
      const job = queue.splice(idx, 1)[0];
      busyKeys.add(job.chatKey);
      active++;
      runJob(job).finally(() => {
        busyKeys.delete(job.chatKey);
        active--;
        pump();
      });
    }
  }

  async function runJob(job) {
    const { chatKey, prompt, meta } = job;
    const blocked = gate(chatKey, Boolean(meta.must));
    if (blocked) {
      // 本地拦截不是唤醒：wake 计数不动，只留一行便于排障（S2.16「空转 = 0」核对的是真唤醒）
      logWake({ batchId: meta.batchId, chatKey, msgs: meta.msgs ?? 0, result: 'skipped', reason: blocked });
      logTrace({ batchId: meta.batchId, chatKey, msgs: meta.msgs ?? 0, result: 'skipped', reason: blocked, prompt, attachments: attPaths(meta.attachments) });
      job.resolve({ skipped: true, reason: blocked });
      return;
    }
    lastWakeAt.set(chatKey, Date.now());
    counters.dailyWakes += 1;
    if (chatKey.startsWith('p:')) counters.privateWakes = (counters.privateWakes ?? 0) + 1; // S3.2 私聊独立计数
    saveCounters(counters);
    const modelStart = Date.now();
    let out;
    try {
      const r = await client.wakeOnce(prompt, { timeoutMs: wakeTimeoutMs, attachments: meta.attachments });
      const modelMs = Date.now() - modelStart;
      const content = String(r.content ?? '').trim();
      if (SILENT_RE.test(content)) {
        out = { silent: true, modelMs, usage: r.usage };
        logWake({ batchId: meta.batchId, chatKey, msgs: meta.msgs ?? 0, waitMs: job.enqueuedAt ? Date.now() - job.enqueuedAt : 0, modelMs, result: 'silent', usage: r.usage });
        logTrace({ batchId: meta.batchId, chatKey, waitMs: job.enqueuedAt ? Date.now() - job.enqueuedAt : 0, modelMs, result: 'silent', prompt, thinking: r.thinking ?? null, reply: content, usage: r.usage, attachments: attPaths(meta.attachments) });
      } else {
        out = { content, modelMs, usage: r.usage };
        logWake({ batchId: meta.batchId, chatKey, msgs: meta.msgs ?? 0, waitMs: job.enqueuedAt ? Date.now() - job.enqueuedAt : 0, modelMs, result: 'sent', lines: content.split(/\r?\n/).filter(Boolean).length, usage: r.usage });
        logTrace({ batchId: meta.batchId, chatKey, waitMs: job.enqueuedAt ? Date.now() - job.enqueuedAt : 0, modelMs, result: 'sent', prompt, thinking: r.thinking ?? null, reply: content, usage: r.usage, attachments: attPaths(meta.attachments) });
      }
      // 成功清零失败计数（无论 silent 还是 sent，协议层跑通了就是成功）
      failStreak.set(chatKey, 0);
      if (meta.hadTier2 && out.silent) meta.onTier2Silent?.();
    } catch (e) {
      const modelMs = Date.now() - modelStart;
      const isTimeout = /timeout/i.test(e.message ?? '');
      // D14：连续失败 3 次 → 熔断 10 分钟；超时批次直接丢弃（不重放，不留到下轮）
      const streak = (failStreak.get(chatKey) ?? 0) + 1;
      failStreak.set(chatKey, streak);
      if (streak >= 3) {
        pausedUntil.set(chatKey, Date.now() + 10 * 60 * 1000);
        failStreak.set(chatKey, 0);
        log('wake', `WARN 群 ${chatKey} 连续失败 ${streak} 次，熔断 10 分钟（最后一次: ${e.message}）`);
      }
      logWake({ batchId: meta.batchId, chatKey, msgs: meta.msgs ?? 0, modelMs, result: isTimeout ? 'timeout' : 'error', error: String(e.message ?? e).slice(0, 160), dropped: true });
      logTrace({ batchId: meta.batchId, chatKey, modelMs, result: isTimeout ? 'timeout' : 'error', prompt, error: String(e.message ?? e).slice(0, 160), dropped: true, attachments: attPaths(meta.attachments) });
      out = { error: e.message, modelMs };
    }
    job.resolve(out);
  }

  // wakeSafe(chatKey, prompt, meta)：并发闸内跑一次唤醒
  // meta：{ batchId, msgs, hadTier2, onTier2Silent }（hadTier2 + silent → 退避结算，S2-E 传）
  function wakeSafe(chatKey, prompt, meta = {}) {
    return new Promise((resolve) => {
      // 失败/超时统一 resolve 出 { error, ... } 结果对象（runJob 全分支 job.resolve）——
      // 历史上存过 reject 字段但从未被任何路径调用，删（死参数）
      queue.push({ chatKey, prompt, meta, resolve, enqueuedAt: Date.now() });
      pump();
    });
  }

  return {
    wakeSafe,
    stats: () => ({
      active, queued: queue.length,
      dailyWakes: counters.dailyWakes, maxDailyWakes,
      privateWakes: counters.privateWakes ?? 0, privateMaxPerDay, // 控制台三钱包之一
    }),
  };
}
