#!/usr/bin/env node
// 鱼缸控制台 · 服务端（项目A G3 骨架，方案 v2 §2/§6/§7/§10）
// 铁律落地：
//   · 只听 127.0.0.1:3201（内网 IP 物理连不上，验收 §11-4）
//   · 零依赖：node:http + 原生 fs，进程内除本机适配器(127.0.0.1:3200)外无任何网络请求（§11-15）
//   · 三态出口：文件不存在 = not_enabled（200，不是 404）；读失败 = degraded；正常 = ready（§6）
//   · Host 头校验（§11-5）+ 读 120/min 写 10/min 令牌桶 + CSP/nosniff
// 数据源：fish-adapter/logs/wake.jsonl（尾读 256KB，绝不整文件读）+ 适配器 /stats /health 代理
import { createServer, get as httpGet, request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { execFile, spawn as childSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, unlinkSync, renameSync, mkdirSync, readdirSync, appendFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(HERE);
const PORT = 3201;
const ADAPTER_BASE = 'http://127.0.0.1:3200';
const WAKE_LOG = join(PKG_ROOT, 'fish-adapter', 'logs', 'wake.jsonl');
const WAKE_TRACE = join(PKG_ROOT, 'fish-adapter', 'logs', 'wake-trace.jsonl'); // 思维链 trace（wake/safe.mjs 落盘）
const ADAPTER_CFG = join(PKG_ROOT, 'fish-adapter', 'config.json');
const ADAPTER_DIR = join(PKG_ROOT, 'fish-adapter');
const FISHPOND = join(PKG_ROOT, 'fishpond');
const CORE_MD = join(FISHPOND, 'memory', 'core.md');
const VOCAB_JSON = join(FISHPOND, 'memory', 'vocab.json');
const REMOVE_QUEUE = join(FISHPOND, 'memory', 'remove-queue.json'); // G5b 删除提案队列（小数组，原子重写——批准执行/驳回撤销都要移走条目，追加式 jsonl 做不了）
const CONFIG_PATH = join(ADAPTER_DIR, 'config.json');
const CONFIG_BACKUP_DIR = join(ADAPTER_DIR, 'backups');
const PS_ONLINE = join(PKG_ROOT, 'napcat', 'fish-online.ps1');
const PS_OFFLINE = join(PKG_ROOT, 'napcat', 'fish-offline.ps1');
const EMOJIS_DIR = join(FISHPOND, 'emojis');
const EMOJI_INDEX = join(EMOJIS_DIR, 'index.json');
const SPEAK_LOG = join(FISHPOND, 'logs', 'speak.jsonl'); // recordSpeak 写鱼缸领地（fishpond/logs），不是适配器目录——2026-11-21 修正路径错位
const EMOJI_NAME_RE = /^[\w\u4e00-\u9fa5-]{1,40}\.(png|jpe?g|gif|webp)$/i;
const PERSONA_PATH = join(FISHPOND, 'persona.md'); // 人格卡（主人创作，唤醒时全文内嵌——与 core.md 记忆闸门是两回事）

// 业务错误（带 HTTP 状态码，route 的 catch 会按它回）
function httpErr(httpStatus, code, message) {
  return Object.assign(new Error(message), { httpStatus, errorCode: code });
}

// —— 删除提案队列读写（G5b）——
function readRemoveQueue() {
  try {
    const a = JSON.parse(readFileSync(REMOVE_QUEUE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return []; } // 无文件/损坏按空队（提案可重提，代价低）
}
function writeRemoveQueue(list) {
  try {
    mkdirSync(dirname(REMOVE_QUEUE), { recursive: true });
    const tmp = REMOVE_QUEUE + '.tmp';
    writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf8');
    renameSync(tmp, REMOVE_QUEUE);
  } catch (e) {
    throw httpErr(500, 'E_IO', `提案队列写入失败：${e.message}`);
  }
}

// ── 令牌桶限流（内存，本机单用户不区分来源）──
const buckets = new Map(); // key -> { tokens, last }
function allow(key, capacity, refillPerSec) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, last: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
  b.last = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

// ── jsonl 尾读：从文件尾部取最多 maxBytes，丢弃可能截断的首行，坏行跳过 ──
function readJsonlTail(path, maxBytes = 256 * 1024) {
  let fd = null;
  try {
    const st = statSync(path);
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, st.size - len);
    closeSync(fd); fd = null;
    let text = buf.toString('utf8');
    if (st.size > maxBytes) text = text.replace(/^[^\n]*\n/, '');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch { /* 坏行跳过：一行坏不带崩整页 */ }
    }
    return { state: 'ready', rows, partial: st.size > maxBytes };
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch { /* double fail */ }
    if (e.code === 'ENOENT') return { state: 'not_enabled', rows: [] };
    return { state: 'degraded', rows: [], error: String(e.message ?? e) };
  }
}

// ── 适配器代理（本机回环，唯一允许的网络出口）──
function fetchAdapter(path, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = httpGet(ADAPTER_BASE + path, { timeout: timeoutMs }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let body = s;
        try { body = JSON.parse(s); } catch { /* /health 是纯文本 ok */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── 脱敏（v2 §9 S3）：QQ 号/群号默认尾 4 位，hover 看 full（服务端出口统一做，前端不二次脱敏）──
function maskChat(chatKey) {
  const k = String(chatKey ?? '');
  const m = k.match(/^(g|p):(\d+)$/);
  if (!m) return { kind: 'other', display: k || '—', full: k };
  const digits = m[2];
  return {
    kind: m[1] === 'g' ? 'group' : 'private',
    display: (m[1] === 'g' ? '群…' : '私…') + digits.slice(-4),
    full: k,
  };
}

// ── 今日口径：wake.jsonl 的 ts 是 ISO 字符串，按本地日过滤（控制台给人看，用本地日）──
function localDay(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function readAdapterCfgSafe() {
  try { return JSON.parse(readFileSync(ADAPTER_CFG, 'utf8')); } catch { return {}; }
}

// ── GET /api/health：自身 + 适配器判活（代理 /stats，失败回落 /health）──
async function apiHealth() {
  const t0 = Date.now();
  const stats = await fetchAdapter('/stats', 2500);
  if (stats && stats.status === 200 && stats.body && stats.body.ok) {
    const d = stats.body;
    return {
      adapter: {
        online: true, ms: Date.now() - t0, pid: d.pid, uptimeMs: d.uptimeMs, mode: d.mode,
        patrol: d.patrol, quotas: d.quotas, health: d.health,
      },
    };
  }
  const h = await fetchAdapter('/health', 1500);
  return { adapter: { online: Boolean(h && h.status === 200 && String(h.body).trim() === 'ok'), ms: Date.now() - t0 } };
}

// ── GET /api/overview：今日 KPI + 今日小时桶 + 最近 10 条流水（wake.jsonl 尾读）──
async function apiOverview() {
  const cfg = readAdapterCfgSafe();
  const [wake, stats] = [readJsonlTail(WAKE_LOG), await fetchAdapter('/stats', 2500)];
  const out = { day: localDay(new Date()), botName: cfg.botName ?? '鱼' };

  if (wake.state !== 'ready') {
    out.wake = { state: wake.state, error: wake.error ?? null };
  } else {
    const today = localDay(new Date());
    const rows = wake.rows.filter((r) => localDay(r.ts) === today);
    const by = (res) => rows.filter((r) => r.result === res);
    const sent = by('sent'), silent = by('silent');
    const timeouts = by('timeout'), errors = by('error'), skipped = by('skipped');
    const tok = { input: 0, output: 0, cacheRead: 0 };
    for (const r of rows) {
      const u = r.usage ?? {};
      tok.input += u.inputTokens ?? 0;
      tok.output += u.outputTokens ?? 0;
      tok.cacheRead += u.cacheReadTokens ?? 0;
    }
    // 今日小时桶（0 点起，轴 0-23；柱子只画真唤醒——skipped 没花钱不算工作量）
    const hourly = new Array(24).fill(0);
    for (const r of rows) {
      if (r.result === 'skipped') continue;
      const d = new Date(r.ts);
      if (!Number.isNaN(d.getTime())) hourly[d.getHours()]++;
    }
    out.wake = {
      state: 'ready',
      counts: {
        wakes: rows.length - skipped.length, skipped: skipped.length,
        sent: sent.length, silent: silent.length,
        timeout: timeouts.length, error: errors.length,
        speakRate: sent.length + silent.length > 0 ? Math.round((sent.length / (sent.length + silent.length)) * 100) : null,
        lines: sent.reduce((a, r) => a + (r.lines ?? 0), 0),
      },
      tokens: tok,
      taskTokens: taskUsageForDay(localDay(new Date())), // 学习/日记任务今日 token（独立流水，合并展示）
      hourly,
      // 最近流水取全量尾部（不限今日）——冷启动日鱼还没说话时，昨天的记录也是有效信息
      recent: wake.rows.slice(-10).reverse().map((r) => ({
        ts: r.ts, chat: maskChat(r.chatKey), msgs: r.msgs ?? 0, result: r.result,
        reason: r.reason ?? null, modelMs: r.modelMs ?? null, lines: r.lines ?? null,
      })),
    };
  }

  // 额度/队列：适配器在线才有（离线 = 该块降级显示 —，不是错误）
  if (stats && stats.status === 200 && stats.body && stats.body.ok) {
    const d = stats.body;
    out.adapter = { online: true, quotas: d.quotas, patrol: d.patrol };
  } else {
    out.adapter = { online: false };
  }
  out.silentHours = cfg.patrol?.silentHours ?? { start: '01:00', end: '07:00' };
  return out;
}

// ── GET /api/wakes?date=&chat=&result=：工作日志列表（G4）──
// wake.jsonl 只落元数据（审计红线本体不动）；prompt/thinking/reply 落在独立旁路文件 wake-trace.jsonl
// （2026-11-22 施法事故后加，见 /api/wakes/trace）——展开区按需二次请求该文件，列表本身仍零内容字段
function normDate(s) {
  const m = String(s ?? '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return localDay(new Date());
  return `${m[1]}-${Number(m[2])}-${Number(m[3])}`; // 与 localDay 同款不补零格式
}
function maskWakeRow(r) {
  return {
    ts: r.ts, batchId: r.batchId ?? null, chat: maskChat(r.chatKey),
    msgs: r.msgs ?? 0, result: r.result, reason: r.reason ?? null,
    waitMs: r.waitMs ?? null, modelMs: r.modelMs ?? null,
    lines: r.lines ?? null, usage: r.usage ?? null, error: r.error ?? null,
    dropped: r.dropped === true,
  };
}
function apiWakes(q) {
  const wake = readJsonlTail(WAKE_LOG, 512 * 1024);
  if (wake.state !== 'ready') return { wake: { state: wake.state, error: wake.error ?? null } };
  const date = normDate(q.get('date'));
  const chat = q.get('chat') || '';
  const result = q.get('result') || '';
  const dayRows = wake.rows.filter((r) => localDay(r.ts) === date);
  const chats = [...new Set(dayRows.map((r) => String(r.chatKey)))].sort();
  let rows = dayRows;
  if (chat) rows = rows.filter((r) => String(r.chatKey) === chat);
  if (result) rows = rows.filter((r) => r.result === result);
  rows = [...rows].reverse(); // 最新在上
  return {
    wake: {
      state: 'ready', date, chats: chats.map(maskChat), total: rows.length,
      partial: wake.partial, // 尾读截断标志：数据量大时早期历史可能不全（诚实标注）
      rows: rows.map(maskWakeRow),
    },
  };
}

// ── GET /api/wakes/trace?batchId=：单次唤醒思维链（G-wk，2026-11-22 施法事故后加）──
// wake-trace.jsonl 由适配器 wake/safe.mjs 落盘：{ts, batchId, chatKey, result, prompt, thinking, reply, usage, ...}
// 按需尾读按 batchId 匹配取最后一条（重试场景同名多行）；审计红线本体不变（wake.jsonl/audit.log 仍不落原文）
function apiWakesTrace(q) {
  const batchId = String(q.get('batchId') ?? '').trim();
  if (!batchId) throw httpErr(400, 'E_BAD_PARAM', 'batchId 必填');
  const r = readJsonlTail(WAKE_TRACE, 2 * 1024 * 1024);
  if (r.state !== 'ready') return { state: r.state, trace: null };
  const hit = r.rows.filter((x) => x && x.batchId === batchId).pop();
  if (!hit) return { state: 'not_found', trace: null };
  return { state: 'ready', trace: hit };
}

// reason 前缀 → 桶（拦截分桶，契约 §6.2 语义按实际前缀实现）
// 任务 token 流水聚合（按本地日过滤）：学习/日记每次运行 done 时由 finish() 追加一行到 task-usage.jsonl
function taskUsageForDay(date) {
  const agg = { input: 0, output: 0, cacheRead: 0, runs: 0, detail: { learn: 0, diary: 0, selfcheck: 0 } };
  const r = readJsonlTail(TASK_USAGE, 256 * 1024);
  if (r.state !== 'ready') return agg;
  for (const row of r.rows) {
    if (!row || localDay(row.ts) !== date) continue;
    const u = row.usage ?? {};
    agg.input += u.inputTokens ?? 0;
    agg.output += u.outputTokens ?? 0;
    agg.cacheRead += u.cacheReadTokens ?? 0;
    agg.runs++;
    if (row.kind === 'learn' || row.kind === 'diary' || row.kind === 'selfcheck') agg.detail[row.kind]++;
  }
  return agg;
}

function reasonBucket(reason) {
  const s = String(reason ?? '');
  if (s === 'silent-hours') return 'silent_hours';
  if (s.startsWith('circuit-open')) return 'circuit_open';
  if (s.startsWith('limit-daily-wakes')) return 'quota_wake';
  if (s.startsWith('limit-private-per-day')) return 'quota_private';
  if (s.startsWith('min-interval')) return 'interval';
  return 'other';
}

// ── GET /api/wakes/stats?date=：当日聚合（G4，口径写死防自我欺骗——v2 §5.2）──
// 说话率分母不含 timeout/skipped（那是"没问成"不是"她不说"）；平均响应排除 timeout（否则被 90s 拉爆）；
// 段数均值仅统计 sent
function apiWakeStats(q) {
  const wake = readJsonlTail(WAKE_LOG, 512 * 1024);
  if (wake.state !== 'ready') return { wake: { state: wake.state, error: wake.error ?? null } };
  const date = normDate(q.get('date'));
  const rows = wake.rows.filter((r) => localDay(r.ts) === date);
  const by = (res) => rows.filter((r) => r.result === res);
  const sent = by('sent'), silent = by('silent'), timeouts = by('timeout'), errors = by('error'), skipped = by('skipped');
  const measured = rows.filter((r) => r.result !== 'timeout' && Number.isFinite(r.modelMs)); // 均值排除 timeout
  const tok = { input: 0, output: 0, cacheRead: 0 };
  for (const r of rows) {
    const u = r.usage ?? {};
    tok.input += u.inputTokens ?? 0;
    tok.output += u.outputTokens ?? 0;
    tok.cacheRead += u.cacheReadTokens ?? 0;
  }
  const taskTok = taskUsageForDay(date); // 学习/日记任务的 token（独立流水，合并展示）
  const buckets = {};
  for (const r of skipped) {
    const b = reasonBucket(r.reason);
    buckets[b] = (buckets[b] ?? 0) + 1;
  }
  const hourly = new Array(24).fill(0);
  for (const r of rows) {
    if (r.result === 'skipped') continue;
    const d = new Date(r.ts);
    if (!Number.isNaN(d.getTime())) hourly[d.getHours()]++;
  }
  return {
    wake: {
      state: 'ready', date,
      counts: {
        wakes: rows.length - skipped.length, skipped: skipped.length,
        sent: sent.length, silent: silent.length, timeout: timeouts.length, error: errors.length,
        speakRate: sent.length + silent.length > 0 ? Math.round((sent.length / (sent.length + silent.length)) * 100) : null,
        avgModelMs: measured.length ? Math.round(measured.reduce((a, r) => a + r.modelMs, 0) / measured.length) : null,
        avgLines: sent.length ? Math.round((sent.reduce((a, r) => a + (r.lines ?? 0), 0) / sent.length) * 10) / 10 : null,
      },
      tokens: tok, taskTokens: taskTok, buckets, hourly,
    },
  };
}

// GET /api/models：可选模型列表（配置页下拉数据源）。
// 两个来源合并：① 用户 provider_config.json 的按量 api-key 条目（含 key，白名单提取，key 类字段根本不进返回对象）
// ② ZCode 内置 zcode-builtin.json 的 account: 订阅型条目（无 key，认证走登录 JWT；模型在 builtinModelIds）
//    ——路径从 patrol.cliPath 推导（resources/config/provider/），读不到则静默回退只出按量
function apiModels() {
  let pc;
  try { pc = JSON.parse(readFileSync(join(homedir(), '.zcode', 'v2', 'provider_config.json'), 'utf8')).config; }
  catch { return { providers: [], source: 'unavailable（读不到 ZCode provider 配置，可手填）' }; }
  const byId = new Map((pc.providerConfigRules?.providerRules ?? []).map((r) => [r.providerId, r]));
  const order = Array.isArray(pc.providerOrder) ? pc.providerOrder : [...byId.keys()];
  const providers = order.filter((id) => byId.has(id)).map((id) => {
    const r = byId.get(id);
    return { providerId: r.providerId, name: r.providerName ?? r.providerId, models: Array.isArray(r.config?.modelOrder) ? r.config.modelOrder : [] };
  });
  // 订阅型（account: 前缀）：登录态是否可用只看凭据文件有没有该字段名，字段值绝不读取
  let credentialOk = false;
  try { credentialOk = Object.prototype.hasOwnProperty.call(JSON.parse(readFileSync(join(homedir(), '.zcode', 'v2', 'credentials.json'), 'utf8')), 'zcodejwttoken'); } catch { /* 未登录 */ }
  let planCount = 0;
  try {
    const cliPath = String(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).patrol?.cliPath ?? '');
    const builtinPath = join(dirname(dirname(cliPath)), 'config', 'provider', 'zcode-builtin.json');
    const builtin = JSON.parse(readFileSync(builtinPath, 'utf8')).config?.providerConfigRules?.providerRules ?? [];
    const seen = new Set(providers.map((p) => p.providerId));
    for (const r of builtin) {
      if (!String(r.providerId ?? '').startsWith('account:')) continue;
      if (r.config?.visibility === 'hidden' || r.visibility === 'hidden' || seen.has(r.providerId)) continue;
      const models = Array.isArray(r.config?.builtinModelIds) ? r.config.builtinModelIds : [];
      if (!models.length) continue;
      providers.push({ providerId: r.providerId, name: r.providerName ?? r.providerId, models, plan: true, mode: r.config?.access?.mode ?? null, credentialOk });
      planCount++;
    }
  } catch { /* builtin 读不到 → 只有按量，现状回退 */ }
  return { providers, source: planCount ? `ZCode provider_config + ${planCount} 个订阅型` : 'ZCode provider_config' };
}

// ── 适配器 POST 代理（G7 测试发送用：控制台持有 console.token，前端绝不直连 3200）──
function fetchAdapterPost(path, body, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let token = '';
    try { token = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).console?.token ?? ''; } catch { /* 读不到就空 */ }
    const data = JSON.stringify(body ?? {});
    const req = httpRequest(ADAPTER_BASE + path, {
      method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-console-token': token },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, body: s }); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

// POST /api/send/preview（dryRun 干跑）与 /api/send（真发）：代理到适配器 /outbound/test，
// 走完整出站链（禁词→审计→限额→分段）——适配器离线整块降级，绝不退化成控制台直连 NapCat
async function apiSendProxy(body, dryRun) {
  const chatKey = String(body.chatKey ?? '');
  const text = typeof body.text === 'string' ? body.text : '';
  if (!/^(g|p):\d+$/.test(chatKey)) throw httpErr(400, 'E_BAD_PARAM', 'chatKey 必须是 g:<群号> 或 p:<QQ号>');
  if (!text.trim() || text.length > 500) throw httpErr(400, 'E_BAD_PARAM', '内容 1~500 字');
  const st = await fetchAdapter('/stats', 2000);
  if (!(st && st.status === 200 && st.body?.ok)) throw httpErr(502, 'E_ADAPTER_DOWN', '适配器离线——测试发送不可用（控制台绝不直连 NapCat）');
  const r = await fetchAdapterPost('/outbound/test', { chatKey, text, dryRun });
  if (!r) throw httpErr(502, 'E_ADAPTER_DOWN', '适配器 /outbound/test 无响应');
  // 适配器的结构化拒绝（403 白名单外 / 400 参数 / 403 token）原样透传，别包成 502 丢真实原因
  if (typeof r.body === 'object' && r.body !== null && r.body.ok === false) {
    return { dryRun, httpStatus: r.status, ...r.body };
  }
  if (r.status !== 200) throw httpErr(502, 'E_ADAPTER_DOWN', '适配器 /outbound/test 异常响应');
  return { dryRun, ...r.body };
}

// GET /api/send/sessions：白名单会话（脱敏展示，值为完整 key）
function apiSendSessions() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 空表 */ }
  const mk = (keys, kind) => (keys ?? []).map((k) => ({ key: `${kind}:${k}`, label: (kind === 'g' ? '群…' : '私…') + String(k).slice(-4), kind }));
  return { sessions: [...mk(cfg.allow?.groups, 'g'), ...mk(cfg.allow?.private, 'p')] };
}
// 字段白名单（v2 §8.1）：不在表里的 PATCH 一律 403 E_FORBIDDEN_POLICY——顺带挡住
// "改零工具黑名单/allowAllWhenEmpty/bridge.mode" 等红线字段（它们根本不进表）。
// 除 secret 外全部需重启生效（适配器是启动读一次的快照）。
const SCHEMA = {
  'botName': { type: 'string', max: 20 },
  'ownerQQ': { type: 'string', max: 20 },
  'allow.groups': { type: 'qq-list' },
  'allow.private': { type: 'qq-list' },
  'identity.names': { type: 'str-list', maxItems: 10 },
  'identity.blockPhrases': { type: 'str-list', maxItems: 50 },
  'patrol.maxDailyWakes': { type: 'int', min: 1, max: 1000 },
  'patrol.wakeTimeoutMs': { type: 'int', min: 10000, max: 300000 },
  'patrol.minWakeIntervalMs': { type: 'int', min: 0, max: 600000 },
  'patrol.batchWindowMs': { type: 'int', min: 1000, max: 60000 },
  'patrol.mustWindowMs': { type: 'int', min: 500, max: 10000 },
  'patrol.maxBufferPerPeer': { type: 'int', min: 5, max: 100 },
  'patrol.silentHours.start': { type: 'hhmm' },
  'patrol.silentHours.end': { type: 'hhmm' },
  'patrol.model.providerId': { type: 'string', max: 60 },
  'patrol.model.modelId': { type: 'string', max: 60 },
  'patrol.model.reasoningLevel': { type: 'enum', values: ['low', 'medium', 'high'] },
  'tasks.learnModel.providerId': { type: 'string', max: 60 },
  'tasks.learnModel.modelId': { type: 'string', max: 60 },
  'tasks.learnModel.reasoningLevel': { type: 'enum', values: ['low', 'medium', 'high'] },
  'tasks.diaryModel.providerId': { type: 'string', max: 60 },
  'tasks.diaryModel.modelId': { type: 'string', max: 60 },
  'tasks.diaryModel.reasoningLevel': { type: 'enum', values: ['low', 'medium', 'high'] },
  'tasks.selfCheckModel.providerId': { type: 'string', max: 60 },
  'tasks.selfCheckModel.modelId': { type: 'string', max: 60 },
  'tasks.selfCheckModel.reasoningLevel': { type: 'enum', values: ['low', 'medium', 'high'] },
  'private.maxPerDay': { type: 'int', min: 1, max: 200 },
  'maintenance.pruneAfterMin': { type: 'int', min: 5, max: 1440 },
  'maintenance.activeGraceMin': { type: 'int', min: 1, max: 120 },
  'limits.maxDailyTotal': { type: 'int', min: 1, max: 2000 },
  'limits.maxRepliesPerMessage': { type: 'int', min: 1, max: 10 },
  'limits.maxProactivePerGroupPerMinute': { type: 'int', min: 1, max: 10 },
  'limits.maxRepliesPerGroupPer5Min': { type: 'int', min: 1, max: 30 },
  'limits.maxSegments': { type: 'int', min: 1, max: 10 },
  'limits.busyMaxSegments': { type: 'int', min: 1, max: 10 },
  'limits.maxTotalChars': { type: 'int', min: 10, max: 1000 },
  'bannedWords': { type: 'str-list', maxItems: 200 },
  'audit.blockPrivateIP': { type: 'bool' },
  'onebot.accessToken': { type: 'secret' },
};

const SECRET_MASK = '****';
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = (o[ks[i]] ??= {});
  o[ks[ks.length - 1]] = v;
}
function sha1(s) { return createHash('sha1').update(s).digest('hex'); }

// 配置当前态：内容 + baseVersion（mtime+sha1，apply 前后各校验一次，外部改过即 409）
function configState() {
  const raw = readFileSync(CONFIG_PATH, 'utf8'); // 调用方兜 ENOENT
  const st = statSync(CONFIG_PATH);
  return { cfg: JSON.parse(raw), raw, baseVersion: `${Math.round(st.mtimeMs)}-${sha1(raw).slice(0, 12)}` };
}

// 校验单字段值；secret 值为掩码时返回 SKIP 标记（不写回）
function validateValue(path, def, v) {
  if (def.type === 'secret') return v === SECRET_MASK ? 'SKIP' : String(v);
  if (def.type === 'bool') return typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : null));
  if (def.type === 'int') return Number.isInteger(Number(v)) && String(Number(v)) === String(v).trim() ? Number(v) : null;
  if (def.type === 'enum') return def.values.includes(v) ? v : null;
  if (def.type === 'hhmm') return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : null;
  if (def.type === 'string') { const s = String(v); return s.length >= 1 && s.length <= (def.max ?? 100) ? s : null; }
  if (def.type === 'qq-list') {
    const a = Array.isArray(v) ? v : String(v).split(/[\s,，]+/);
    const out = a.map((x) => String(x).trim()).filter(Boolean);
    return out.every((x) => /^\d{5,12}$/.test(x)) && out.length <= (def.maxItems ?? 20) ? out : null;
  }
  if (def.type === 'str-list') {
    const a = Array.isArray(v) ? v : String(v).split('\n');
    const out = a.map((x) => String(x).trim()).filter(Boolean);
    return out.every((x) => x.length <= 100) && out.length <= (def.maxItems ?? 200) ? out : null;
  }
  return null;
}

// 脱敏展示值（diff 与 GET 都用它）
function maskValue(path, v) {
  if (SCHEMA[path]?.type === 'secret') return v == null || v === '' ? '' : SECRET_MASK;
  return v;
}

// GET /api/config：脱敏配置 + 白名单元数据 + baseVersion（表单渲染与预览的基线）
function apiGetConfig() {
  let st;
  try { st = configState(); } catch (e) {
    throw httpErr(500, 'E_IO', `config.json 读取失败：${e.message}`);
  }
  const masked = JSON.parse(JSON.stringify(st.cfg));
  if (masked.onebot?.accessToken) masked.onebot.accessToken = SECRET_MASK;
  return { config: masked, maskedPaths: ['onebot.accessToken'], baseVersion: st.baseVersion, schemaKeys: Object.keys(SCHEMA) };
}

// PATCH /api/config {patch, baseVersion} → {diff, warnings, applyToken, expiresAt}（30s 一次性）
const applyTokens = new Map(); // token -> {patchHash, baseVersion, newCfgRaw, expiresAt}
function apiPatchConfig(body) {
  const patch = body.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpErr(400, 'E_BAD_PARAM', 'patch 必须是 {字段: 新值} 对象');
  let st;
  try { st = configState(); } catch (e) { throw httpErr(500, 'E_IO', `config.json 读取失败：${e.message}`); }
  if (body.baseVersion !== st.baseVersion) {
    throw httpErr(409, 'E_CONFLICT', '配置基线已变化（文件被外部改过）——请刷新表单后重试');
  }
  const diff = [];
  const newCfg = JSON.parse(st.raw);
  for (const [path, v] of Object.entries(patch)) {
    const def = SCHEMA[path];
    if (!def) throw httpErr(403, 'E_FORBIDDEN_POLICY', `字段不在白名单：${path}（红线字段不可通过控制台修改）`);
    const validated = validateValue(path, def, v);
    if (validated === null) {
      throw httpErr(400, 'E_BAD_PARAM', `字段 ${path} 的值非法（期望 ${def.type}${def.min != null ? ` ${def.min}~${def.max}` : ''}）`);
    }
    if (validated === 'SKIP') continue; // secret 掩码：跳过不写
    if (def.min != null && def.max != null && (validated < def.min || validated > def.max)) {
      throw httpErr(400, 'E_BAD_PARAM', `字段 ${path} 超出范围 ${def.min}~${def.max}`);
    }
    const old = getPath(st.cfg, path);
    if (JSON.stringify(old) === JSON.stringify(validated)) continue; // 没变不进 diff
    setPath(newCfg, path, validated);
    diff.push({ path, from: maskValue(path, old), to: maskValue(path, validated) });
  }
  if (!diff.length) throw httpErr(400, 'E_BAD_PARAM', '没有任何实际变更（值与当前配置相同）');
  // 提示性警告（不阻断）
  const warnings = [];
  const after = (p) => getPath(newCfg, p);
  if (after('patrol.maxDailyWakes') > 300) warnings.push(`思考额度 ${after('patrol.maxDailyWakes')}/天 偏高——按当前单价每天成本可能明显上升`);
  if (after('patrol.model.reasoningLevel') === 'high') warnings.push('reasoningLevel=high 更聪明但更贵更慢（回复可能超过 30 秒）');
  if (after('patrol.silentHours.end') < after('patrol.silentHours.start')) warnings.push('静默时段跨午夜（如 01:00→07:00 反向则不跨，此提示供人工确认）');
  if (after('patrol.mustWindowMs') > 5000) warnings.push('必回短窗 >5 秒：@她的人会明显感觉变慢');
  const patchHash = sha1(JSON.stringify(Object.keys(patch).sort().map((k) => [k, patch[k]])));
  const token = randomUUID().replace(/-/g, '');
  applyTokens.set(token, { patchHash, baseVersion: st.baseVersion, newCfgRaw: JSON.stringify(newCfg, null, 2) + '\n', expiresAt: Date.now() + 30_000 });
  for (const [k, v] of applyTokens) if (v.expiresAt < Date.now()) applyTokens.delete(k);
  return { diff, warnings, applyToken: token, patchHash, expiresAt: Date.now() + 30_000 };
}

// POST /api/config/apply {applyToken, patchHash} → 备份轮换（10 份）+ 原子写
function apiApplyConfig(body) {
  const tk = applyTokens.get(String(body.applyToken ?? ''));
  if (!tk || tk.expiresAt < Date.now()) throw httpErr(410, 'E_TOKEN_INVALID', '应用令牌不存在或已过期（30 秒），请重新预览');
  if (body.patchHash !== tk.patchHash) throw httpErr(409, 'E_TOKEN_USED', '补丁与预览时不一致（改过表单？）——请重新预览');
  applyTokens.delete(String(body.applyToken)); // 一次性
  let st;
  try { st = configState(); } catch (e) { throw httpErr(500, 'E_IO', `config.json 读取失败：${e.message}`); }
  if (st.baseVersion !== tk.baseVersion) throw httpErr(409, 'E_CONFLICT', '配置在预览后被外部修改——拒绝落盘，请重新预览');
  // 备份（保留 10 份，时间序轮换）
  let backupId = null;
  try {
    mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
    backupId = `config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(join(CONFIG_BACKUP_DIR, backupId), st.raw, 'utf8');
    const olds = readdirSync(CONFIG_BACKUP_DIR).filter((f) => f.startsWith('config-')).sort();
    while (olds.length > 10) unlinkSync(join(CONFIG_BACKUP_DIR, olds.shift()));
  } catch (e) { throw httpErr(500, 'E_IO', `备份失败（未写入）：${e.message}`); }
  // 原子写：tmp → rename（写失败原文件不动）
  try {
    const tmp = CONFIG_PATH + '.tmp';
    writeFileSync(tmp, tk.newCfgRaw, 'utf8');
    JSON.parse(readFileSync(tmp, 'utf8')); // 回读校验：写出去的必须仍是合法 JSON
    renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    throw httpErr(500, 'E_IO', `写入失败：${e.message}（原文件未动，备份在 backups/${backupId}）`);
  }
  return { backupId, restartPending: true };
}

// POST /api/actions/restart {confirm:'RESTART'} → spawn restart-adapter.mjs（JSON 输出透传）
function apiRestart(body) {
  if (body.confirm !== 'RESTART') throw httpErr(400, 'E_BAD_PARAM', 'confirm 必须是 RESTART（二次确认）');
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ADAPTER_DIR, 'restart-adapter.mjs'), '--json', '--actor-console'],
      { cwd: ADAPTER_DIR, timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) {
          let stage = 'spawn';
          try { const j = JSON.parse(stdout); stage = j.stage ?? 'spawn'; } catch { /* 无 JSON */ }
          resolve({ ok: false, stage, exitCode: err.code ?? null, output: String(stdout || '').trim().split(/\r?\n/).slice(-3) });
          return;
        }
        try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, stage: 'output', error: '脚本输出不是 JSON' }); }
      });
  });
}

// POST /api/actions/mode {target:'online'|'offline', confirm} → spawn ps1 全家桶（G2 裁决：上下线走现有脚本）
function apiModeAction(body) {
  const target = body.target === 'offline' ? 'offline' : 'online';
  if (body.confirm !== target.toUpperCase()) throw httpErr(400, 'E_BAD_PARAM', `confirm 必须是 ${target.toUpperCase()}（二次确认防手滑）`);
  const ps1 = target === 'online' ? PS_ONLINE : PS_OFFLINE;
  try { statSync(ps1); } catch { throw httpErr(500, 'E_IO', `找不到脚本：${ps1}`); }
  // 下线脚本最后一步会杀掉本控制台（弑父）：execFile 干等它的回调永远等不到，浏览器侧
  // fetch 也随连接断开报错（2026-11-23 20:37 事故：页面报"下线失败"，实际下了一大半、流水没写）。
  // 改为 detach 发起即返回；脚本侧已把流水落盘挪到关控制台之前，结果以 ops 流水为准。
  if (target === 'offline') {
    // Windows/PowerShell 5.1 实测三坑（2026-11-23 演练逐个排除）：detached:true（DETACHED_PROCESS
    // 无控制台）秒退；stdio:'ignore'（stdin=NUL）秒退；父进程 spawn 后立即退出子也活不成。
    // 本场景父（控制台）会活到脚本最后一步才被杀，天然满足存活条件——输出落文件留排障日志。
    const logFd = openSync(join(PKG_ROOT, 'console', 'offline-spawn.log'), 'a');
    const p = childSpawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-NoPause', '-Actor', 'console'],
      { stdio: ['pipe', logFd, logFd], windowsHide: true });
    p.unref();
    return Promise.resolve({ target, ok: true, stage: 'dispatched', exitCode: null,
      output: ['下线流程已发起（约 5~10 秒完成）。', '控制台自身最后停止——本页面稍后会失联，属预期；鱼重新上线时控制台会随之拉起。'] });
  }
  return new Promise((resolve) => {
    // [Console]::OutputEncoding=UTF8：PowerShell 5 默认按控制台代码页(GBK)输出，中文会变乱码
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `& { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${ps1}' -NoPause -Actor console }`],
      { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 256 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-8);
        const fail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3);
        if (err) {
          resolve({ target, ok: false, stage: err.killed ? 'timeout' : 'script', exitCode: err.code ?? null, output: [...out, ...fail], error: err.killed ? '脚本超时被终止' : String(err.message).split('\n')[0] });
          return;
        }
        resolve({ target, ok: true, stage: 'ready', exitCode: 0, output: out });
      });
  });
}
// 审阅数据/裁决全部复用 G1 的脚本非交互接口（spawn + 看退出码），控制台不重写审校逻辑。
// 红线：core.md / vocab 只走 --apply 审批，控制台无直接编辑能力。

// ══════════ G5：审阅 + 记忆与行话 ══════════
// 审阅数据/裁决全部复用 G1 的脚本非交互接口（spawn + 看退出码），控制台不重写审校逻辑。
// 红线：core.md / vocab 只走 --apply 审批，控制台无直接编辑能力。

// spawn 审阅脚本（cwd=fish-adapter；stdout 是 JSON；超时 15s）
function runReviewScript(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ADAPTER_DIR, script), ...args], {
      cwd: ADAPTER_DIR, timeout: 15_000, windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: `脚本退出码 ${err.code ?? '?'}：${String(stderr || err.message).split('\n')[0].slice(0, 200)}` });
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: '脚本输出不是 JSON' }); }
    });
  });
}

// GET /api/review/memory|vocab：候选列表（脚本 --list 纯读）+ 同 kind 删除提案（G5b 合并进候选区）
async function apiReviewList(kind) {
  const r = await runReviewScript(kind === 'memory' ? 'memory-review.mjs' : 'vocab-review.mjs', ['--list', '--json']);
  if (!r.ok) throw httpErr(500, 'E_SCRIPT', r.error ?? '审阅脚本失败');
  const removes = readRemoveQueue().filter((q) => q.kind === kind);
  return { kind, removes, ...(kind === 'memory' ? { items: r.items ?? [], core: r.core ?? null } : { candidates: r.candidates ?? [], confirmed: r.confirmed ?? null }) };
}

// 裁决令牌（60s 一次性，内存）：approve/reject 是写操作，取令牌→确认→提交两步防手滑
const reviewTokens = new Map(); // token -> { kind, expiresAt }
function apiReviewToken(q) {
  const kind = q.get('kind') === 'vocab' ? 'vocab' : 'memory';
  for (const [k, v] of reviewTokens) if (v.expiresAt < Date.now()) reviewTokens.delete(k); // 顺手清扫
  const token = randomUUID().replace(/-/g, '');
  const expiresAt = Date.now() + 60_000;
  reviewTokens.set(token, { kind, expiresAt });
  return { kind, token, expiresAt };
}

// POST /api/review/decision {kind, token, items:[{id, action}]}
// items 走 --json-file（临时文件）——argv 传 JSON 有 Windows 32K 限制和引号地狱
async function apiReviewDecision(body) {
  const kind = body.kind === 'vocab' ? 'vocab' : 'memory';
  const tk = reviewTokens.get(String(body.token ?? ''));
  if (!tk || tk.expiresAt < Date.now()) throw httpErr(410, 'E_TOKEN_INVALID', '令牌不存在或已过期（60 秒），请重新确认');
  if (tk.kind !== kind) throw httpErr(410, 'E_TOKEN_INVALID', '令牌与目标不匹配');
  reviewTokens.delete(String(body.token)); // 一次性
  const OK_ACTIONS = kind === 'memory' ? ['approve', 'reject', 'remove-core'] : ['approve', 'reject', 'retire'];
  const items = Array.isArray(body.items) ? body.items : [];
  // G5b：removes = [{rid, action: approve|reject}]——approve 转 remove-core（记忆）/retire（行话）随批执行，reject 撤销提案
  const removesIn = Array.isArray(body.removes) ? body.removes : [];
  if ((!items.length && !removesIn.length) || items.length > 200 || removesIn.length > 100) {
    throw httpErr(400, 'E_BAD_PARAM', 'items/removes 至少要有一个（纯删除提案提交是合法场景；items ≤200，removes ≤100）');
  }
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || !it.id || !OK_ACTIONS.includes(it.action)) {
      throw httpErr(400, 'E_BAD_PARAM', `条目非法（action 必须是 ${OK_ACTIONS.join('/')}）：${JSON.stringify(it ?? null).slice(0, 80)}`);
    }
  }
  for (const rm of removesIn) {
    if (!rm || typeof rm.rid !== 'string' || !['approve', 'reject'].includes(rm.action)) {
      throw httpErr(400, 'E_BAD_PARAM', `removes 条目非法（action 必须是 approve/reject）：${JSON.stringify(rm ?? null).slice(0, 60)}`);
    }
  }
  const queue = readRemoveQueue();
  const ridSeen = new Set();
  const scriptItems = [...items];
  const scriptRemoveIds = new Set(); // remove 转成的脚本 id（结果里要拆到 removeResults 汇报）
  const removeMeta = []; // {rid, action, queueIdx} | {rid, ok:false, error}
  for (const rm of removesIn) {
    if (ridSeen.has(rm.rid)) continue;
    ridSeen.add(rm.rid);
    const qi = queue.findIndex((q) => q.rid === rm.rid && q.kind === kind);
    if (qi < 0) { removeMeta.push({ rid: rm.rid, ok: false, error: '提案不在队列（可能刚被处理）' }); continue; }
    if (rm.action === 'approve') {
      scriptRemoveIds.add(queue[qi].id);
      scriptItems.push({ id: queue[qi].id, action: kind === 'memory' ? 'remove-core' : 'retire' });
    }
    removeMeta.push({ rid: rm.rid, action: rm.action, queueIdx: qi });
  }
  const tmp = join(tmpdir(), `fish-console-review-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  try {
    writeFileSync(tmp, JSON.stringify({ items: scriptItems }), 'utf8');
    const r = await runReviewScript(kind === 'memory' ? 'memory-review.mjs' : 'vocab-review.mjs', ['--apply', '--json-file', tmp]);
    if (!r.ok) throw httpErr(500, 'E_SCRIPT', r.error ?? '裁决脚本失败');
    // 队列结算：approve 成功 / reject 的移出队列；失败的留在队列里可重试
    const allResults = r.results ?? [];
    const okIds = new Set(allResults.filter((x) => x.ok).map((x) => x.id));
    const doneIdx = new Set();
    const removeResults = removeMeta.map((m) => {
      if (m.ok === false) return m;
      if (m.action === 'reject') { doneIdx.add(m.queueIdx); return { rid: m.rid, ok: true, effect: 'withdrawn' }; }
      const q = queue[m.queueIdx];
      if (okIds.has(q.id)) { doneIdx.add(m.queueIdx); return { rid: m.rid, ok: true, effect: kind === 'memory' ? 'removed-from-core' : 'retired' }; }
      return { rid: m.rid, ok: false, error: allResults.find((x) => x.id === q.id && !x.ok)?.error ?? '脚本未处理该条' };
    });
    if (doneIdx.size) writeRemoveQueue(queue.filter((_, i) => !doneIdx.has(i)));
    return {
      kind,
      results: allResults.filter((x) => !scriptRemoveIds.has(x.id)), // remove 项拆去 removeResults
      removeResults,
      backup: r.backup ?? null,
    };
  } finally {
    try { unlinkSync(tmp); } catch { /* 清理失败随它去（系统 temp） */ }
  }
}

// POST /api/review/propose-remove {kind, id, reason}：生成删除提案进队列（G5b：审阅页批准才真删）
// 原文快照服务端自查（不信前端）；同目标去重
function apiProposeRemove(body) {
  const kind = body.kind === 'vocab' ? 'vocab' : 'memory';
  if (typeof body.id !== 'string' || !body.id) throw httpErr(400, 'E_BAD_PARAM', 'id 必填');
  let text = null;
  if (kind === 'memory') {
    const c = parseCoreMd();
    if (c.state !== 'ready') throw httpErr(409, 'E_CONFLICT', 'core.md 不可读，无法提案');
    text = (c.entries ?? []).find((e) => e.id === body.id)?.text ?? null;
  } else {
    try {
      const v = JSON.parse(readFileSync(VOCAB_JSON, 'utf8'));
      const e = (v.entries ?? []).find((x) => x.word === body.id && x.status === 'confirmed');
      text = e ? `${e.word} — ${e.meaning ?? ''}` : null;
    } catch { /* 词库读不了按不存在 */ }
  }
  if (text == null) throw httpErr(404, 'E_NOT_FOUND', '目标条目不存在（可能已删除或已下架）');
  const queue = readRemoveQueue();
  if (queue.some((q) => q.kind === kind && q.id === body.id)) {
    return { kind, id: body.id, recorded: false, reason: '已在审阅队列中' };
  }
  const rid = randomUUID().slice(0, 8);
  queue.push({ rid, ts: new Date().toISOString(), kind, id: body.id, reason: String(body.reason ?? '').slice(0, 200), text: String(text).slice(0, 200) });
  writeRemoveQueue(queue);
  return { kind, id: body.id, rid, recorded: true };
}

// core.md 解析：行首 `- [日期] 正文（来源：…）`——溯源内嵌在正文尾部（实测格式，无 front matter）
function parseCoreMd() {
  let lines;
  try { lines = readFileSync(CORE_MD, 'utf8').split(/\r?\n/); } catch (e) { return e.code === 'ENOENT' ? { state: 'not_enabled' } : { state: 'degraded', error: e.message }; }
  const entries = [];
  for (const l of lines) {
    if (typeof l !== 'string' || !l.startsWith('- [')) continue;
    const m = l.match(/^- \[([^\]]+)\]\s*(.*)$/);
    if (!m) continue;
    const src = m[2].match(/（来源：([^）]*)）\s*$/);
    entries.push({
      id: createHash('sha1').update(l).digest('hex').slice(0, 12), // 行内容 hash：与位置解耦
      date: m[1],
      text: (src ? m[2].slice(0, src.index) : m[2]).trim(),
      source: src ? src[1] : null,
    });
  }
  // 疑似重复（保守：只标"包含式"重复，短条目不参与——两句话说同一件事是记忆库最常见坏味道）
  const dup = new Set();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].text, b = entries[j].text;
      if (a.length >= 10 && b.length >= 10 && (a.includes(b) || b.includes(a))) { dup.add(entries[i].id); dup.add(entries[j].id); }
    }
  }
  const pending = readRemoveQueue().length; // 待审删除提案数（G5b）
  return { state: 'ready', entries, dupIds: [...dup], maxLines: 60, usedLines: lines.length, pendingProposals: pending.length };
}

// GET /api/memory：已生效记忆（解析 core.md，带来源/日期/重复标记）
function apiMemory() {
  const r = parseCoreMd();
  if (r.state !== 'ready') return { memory: r };
  return { memory: r };
}

// GET /api/vocab-effective：已上线行话（复用脚本 --list 的 confirmed 段）
async function apiVocabEffective() {
  const r = await runReviewScript('vocab-review.mjs', ['--list', '--json']);
  if (!r.ok) throw httpErr(500, 'E_SCRIPT', r.error ?? '审阅脚本失败');
  return { vocab: { state: 'ready', confirmed: r.confirmed ?? { count: 0, max: 20, items: [] } } };
}

// ══════════ G7：表情包页 ══════════
// index.json 实测结构：{文件名: 描述字符串}（无 tags/usedCount）——使用统计从 speak.jsonl 的
// emoji 字段聚合（G2 起累积，历史无记录，页面明示"自统计起算"）。
function sniffImage(buf) {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 4 && b.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function readEmojiIndex() {
  try { return JSON.parse(readFileSync(EMOJI_INDEX, 'utf8')); } catch { return {}; }
}
function writeEmojiIndex(idx) {
  const tmp = EMOJI_INDEX + '.tmp';
  writeFileSync(tmp, JSON.stringify(idx, null, 1), 'utf8');
  renameSync(tmp, EMOJI_INDEX);
}
function logConsoleOp(action, detail, ok = true) {
  try {
    appendFileSync(join(ADAPTER_DIR, 'state', 'ops.jsonl'), JSON.stringify({ ts: Date.now(), actor: 'console', action, ok, ms: 0, stage: null, err: null, detail }) + '\n', 'utf8');
  } catch { /* 流水失败不阻断 */ }
}

// GET /api/emoji：目录 + index 描述 + speak.jsonl 使用聚合（尾读）
function apiEmojiList(q) {
  let files;
  try { files = readdirSync(EMOJIS_DIR).filter((f) => EMOJI_NAME_RE.test(f)); } catch (e) {
    if (e.code === 'ENOENT') return { emoji: { state: 'not_enabled' } };
    throw httpErr(500, 'E_IO', `表情目录读取失败：${e.message}`);
  }
  const index = readEmojiIndex();
  const usage = {};
  for (const r of readJsonlTail(SPEAK_LOG, 512 * 1024).rows) {
    if (!r.emoji) continue;
    const e = (usage[r.emoji] ??= { count: 0, last: null });
    e.count += 1;
    if (!e.last || String(r.ts) > String(e.last)) e.last = r.ts;
  }
  const kw = (q.get('q') || '').trim();
  const items = files.map((f) => {
    let size = 0;
    try { size = statSync(join(EMOJIS_DIR, f)).size; } catch { /* 刚被并发删了 */ }
    return { name: f, desc: index[f] ?? null, size, used: usage[f]?.count ?? 0, last: usage[f]?.last ?? null };
  }).filter((i) => !kw || i.name.includes(kw) || (i.desc ?? '').includes(kw));
  const sort = q.get('sort') === 'name' ? 'name' : 'usage';
  items.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : (b.used - a.used) || a.name.localeCompare(b.name)));
  return {
    emoji: {
      state: 'ready',
      items,
      stats: { total: items.length, neverUsed: items.filter((i) => !i.used).length, trash: existsSync(join(EMOJIS_DIR, '.trash')) ? readdirSync(join(EMOJIS_DIR, '.trash')).length : 0 },
    },
  };
}

// GET /api/emoji/<name>：图片流（扩展名白名单 + nosniff + 防穿越）
function serveEmojiFile(name, res) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  if (!EMOJI_NAME_RE.test(base)) { res.writeHead(400).end(); return; }
  const p = join(EMOJIS_DIR, base);
  if (!p.startsWith(EMOJIS_DIR)) { res.writeHead(400).end(); return; }
  try {
    const ext = base.split('.').pop().toLowerCase();
    const ct = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
    res.writeHead(200, { 'Content-Type': ct, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(readFileSync(p));
  } catch { res.writeHead(404).end('not found'); }
}

// POST /api/emoji/gate {enabled}：表情硬闸开关（一键切换，写 config.emojiGate.enabled + 自动备份）
// 闸门本体在适配器出站链（outbound.mjs 现读 config，切换即时生效无需重启）
function apiEmojiGate(body) {
  const hasEnabled = typeof body.enabled === 'boolean';
  const hasWindow = body.window != null;
  const hasMax = body.max != null;
  if (!hasEnabled && !hasWindow && !hasMax) throw httpErr(400, 'E_BAD_PARAM', '需要 enabled / window / max 至少一项');
  if (hasWindow && (!Number.isInteger(Number(body.window)) || Number(body.window) < 2 || Number(body.window) > 50)) throw httpErr(400, 'E_BAD_PARAM', 'window 必须是 2~50 的整数');
  if (hasMax && (!Number.isInteger(Number(body.max)) || Number(body.max) < 1 || Number(body.max) > 30)) throw httpErr(400, 'E_BAD_PARAM', 'max 必须是 1~30 的整数');
  let st;
  try { st = configState(); } catch (e) { throw httpErr(500, 'E_IO', `config.json 读取失败：${e.message}`); }
  const cfg = JSON.parse(st.raw);
  cfg.emojiGate = { ...(cfg.emojiGate ?? {}), ...(hasEnabled ? { enabled: body.enabled } : {}), ...(hasWindow ? { window: Number(body.window) } : {}), ...(hasMax ? { max: Number(body.max) } : {}) };
  const newRaw = JSON.stringify(cfg, null, 2) + '\n';
  // 备份轮换（与两段式同款，10 份）
  let backupId = null;
  try {
    mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
    backupId = `config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(join(CONFIG_BACKUP_DIR, backupId), st.raw, 'utf8');
    const olds = readdirSync(CONFIG_BACKUP_DIR).filter((f) => f.startsWith('config-')).sort();
    while (olds.length > 10) unlinkSync(join(CONFIG_BACKUP_DIR, olds.shift()));
  } catch (e) { throw httpErr(500, 'E_IO', `备份失败（未写入）：${e.message}`); }
  const tmp = CONFIG_PATH + '.tmp';
  writeFileSync(tmp, newRaw, 'utf8');
  try { JSON.parse(readFileSync(tmp, 'utf8')); } catch (e) { unlinkSync(tmp); throw httpErr(500, 'E_IO', `回读校验失败：${e.message}`); }
  renameSync(tmp, CONFIG_PATH);
  logConsoleOp('emoji_gate', { enabled: body.enabled });
  return { ...(cfg.emojiGate ?? {}), backupId, note: '即时生效（适配器现读 config，无需重启）' };
}

// POST /api/emoji {name, dataBase64, desc, overwrite}：六道校验全过才写盘 + 同步补 index.json
// （出站只做存在性校验，鱼"知道"这张图靠 index.json 的描述——上传必须双写）
function apiEmojiUpload(body) {
  // ① basename + 文件名正则（①②合一：正则内已限扩展名白名单，svg 天然被拒）
  const base = String(body.name ?? '').split(/[\\/]/).pop();
  if (!EMOJI_NAME_RE.test(base)) throw httpErr(400, 'E_BAD_PARAM', '文件名非法（1~40 字，中文/字母/数字/横线；扩展名限 png/jpg/gif/webp，禁 svg）');
  // ③④⑤ 解码 + magic bytes + 5MB
  let buf;
  try { buf = Buffer.from(String(body.dataBase64 ?? '').replace(/^data:[^;]+;base64,/, ''), 'base64'); } catch { throw httpErr(400, 'E_BAD_PARAM', 'base64 解码失败'); }
  if (!buf.length) throw httpErr(400, 'E_BAD_PARAM', '文件内容为空');
  if (buf.length > 5 * 1024 * 1024) throw httpErr(400, 'E_BAD_PARAM', '超过 5MB 上限');
  const kind = sniffImage(buf);
  if (!kind) throw httpErr(400, 'E_BAD_PARAM', '文件头校验失败——不是真实的 PNG/JPG/GIF/WEBP（改名的 exe 不算）');
  // ⑤ resolve 前缀二次防穿越
  const dest = join(EMOJIS_DIR, base);
  if (!dest.startsWith(EMOJIS_DIR)) throw httpErr(400, 'E_BAD_PARAM', '路径非法');
  // ⑥ 防覆盖（openSync wx 语义：显式 overwrite 时旧图先进回收站）
  const trash = join(EMOJIS_DIR, '.trash');
  if (existsSync(dest)) {
    if (!body.overwrite) throw httpErr(409, 'E_EXISTS', `同名文件已存在——要覆盖请勾选"覆盖"（原图会进回收站）`);
    mkdirSync(trash, { recursive: true });
    renameSync(dest, join(trash, `${Date.now()}-${base}`));
  }
  mkdirSync(EMOJIS_DIR, { recursive: true });
  writeFileSync(dest, buf);
  const descFinal = String(body.desc ?? '').trim().slice(0, 200) || '（未写描述——鱼不一定知道何时用它）';
  const idx = readEmojiIndex();
  idx[base] = descFinal;
  writeEmojiIndex(idx);
  logConsoleOp('emoji_upload', { name: base, size: buf.length, overwrite: Boolean(body.overwrite) });
  return { name: base, kind, size: buf.length, desc: descFinal };
}

// POST /api/emoji/rename {from, to}：文件改名 + index.json 键同步搬移
// （鱼写 [表情: 文件名] 靠"从索引原样抄"——键与文件必须同改，只改一边她就会对着死键说话）
function apiEmojiRename(body) {
  const from = String(body.from ?? '').split(/[\\/]/).pop();
  const to = String(body.to ?? '').trim().split(/[\\/]/).pop();
  if (!EMOJI_NAME_RE.test(from)) throw httpErr(400, 'E_BAD_PARAM', '旧文件名非法');
  if (!EMOJI_NAME_RE.test(to)) throw httpErr(400, 'E_BAD_PARAM', '新文件名非法（1~40 字，中文/字母/数字/横线）');
  if (from === to) throw httpErr(400, 'E_BAD_PARAM', '新旧名字相同');
  const extOf = (s) => (s.match(/\.([a-z]+)$/i)?.[1] ?? '').toLowerCase();
  if (extOf(from) !== extOf(to)) throw httpErr(400, 'E_BAD_PARAM', `扩展名必须保持 .${extOf(from)}——改名只改主名，不动图片类型`);
  const src = join(EMOJIS_DIR, from);
  if (!src.startsWith(EMOJIS_DIR)) throw httpErr(400, 'E_BAD_PARAM', '路径非法');
  if (!existsSync(src)) throw httpErr(404, 'E_NOT_FOUND', '旧文件不存在');
  const dst = join(EMOJIS_DIR, to);
  if (!dst.startsWith(EMOJIS_DIR)) throw httpErr(400, 'E_BAD_PARAM', '路径非法');
  if (existsSync(dst)) throw httpErr(409, 'E_EXISTS', '新名字已被占用');
  const idx = readEmojiIndex();
  const desc = idx[from];
  // 先文件后索引；索引写失败回滚文件名（两边要么同旧要么同新，不留死键）
  renameSync(src, dst);
  try {
    delete idx[from];
    if (desc !== undefined) idx[to] = desc;
    writeEmojiIndex(idx);
  } catch (e) {
    try { renameSync(dst, src); } catch { /* 回滚也失败：只能留痕让主人手工对齐 */ }
    throw httpErr(500, 'E_INDEX_FAIL', '索引写入失败，已回滚文件名：' + e.message);
  }
  logConsoleOp('emoji_rename', { from, to, hadDesc: desc !== undefined });
  return { from, to, desc: (typeof desc === 'string' ? desc : desc?.desc) ?? null };
}

// DELETE /api/emoji/<name>：移入 .trash/<ts>-<name>（不真删），index.json 移除该键
function apiEmojiDelete(name) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  if (!EMOJI_NAME_RE.test(base)) throw httpErr(400, 'E_BAD_PARAM', '文件名非法');
  const dest = join(EMOJIS_DIR, base);
  if (!dest.startsWith(EMOJIS_DIR)) throw httpErr(400, 'E_BAD_PARAM', '路径非法');
  if (!existsSync(dest)) throw httpErr(404, 'E_NOT_FOUND', '文件不存在');
  const trash = join(EMOJIS_DIR, '.trash');
  mkdirSync(trash, { recursive: true });
  const trashName = `${Date.now()}-${base}`;
  renameSync(dest, join(trash, trashName));
  const idx = readEmojiIndex();
  const hadDesc = base in idx;
  const oldDesc = idx[base];
  delete idx[base];
  writeEmojiIndex(idx);
  logConsoleOp('emoji_delete', { name: base, trash: trashName, hadDesc, oldDesc: (oldDesc ?? '').slice(0, 100) });
  return { name: base, trash: trashName };
}

// ══════════ G8：运维页 ══════════
// GET /api/ops：操作流水最近 20 条（tail 16KB，绝不整文件读）
function apiOps() {
  const r = readJsonlTail(join(ADAPTER_DIR, 'state', 'ops.jsonl'), 16 * 1024);
  if (r.state !== 'ready') return { ops: { state: r.state, items: [] } };
  return { ops: { state: 'ready', items: r.rows.slice(-20).reverse() } };
}

// 会话清理：spawn maintenance.mjs（预览无参 / 执行 --apply），输出文本透传 + 数字提取
function runPrune(apply) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ADAPTER_DIR, 'maintenance.mjs'), ...(apply ? ['--apply'] : [])],
      { cwd: ADAPTER_DIR, timeout: 60_000, windowsHide: true, maxBuffer: 128 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (err) {
          resolve({ ok: false, error: `退出码 ${err.code ?? '?'}：${(String(stderr || err.message).split('\n')[0] || '').slice(0, 160)}` });
          return;
        }
        const m = out.match(/将软删 (\d+) 条/);
        resolve({ ok: true, tasks: m ? Number(m[1]) : null, output: out.split(/\r?\n/).slice(-8) });
      });
  });
}

// POST /api/actions/shutdown {confirm:'SHUTDOWN'}：关闭控制台（联动语义=主动关才下线鱼：
// 适配器在线时先走 offline 全家桶，再退出自己。SIGTERM/强杀/崩溃路径完全不碰鱼——安全铁律）
async function apiShutdown(body) {
  if (body.confirm !== 'SHUTDOWN') throw httpErr(400, 'E_BAD_PARAM', 'confirm 必须是 SHUTDOWN（关闭控制台不可逆，二次确认）');
  let fishOffline = false;
  const st = await fetchAdapter('/stats', 1500);
  if (st && st.status === 200 && st.body?.ok) {
    const off = await apiModeAction({ target: 'offline', confirm: 'OFFLINE' });
    fishOffline = Boolean(off.ok);
  }
  logConsoleOp('shutdown', { fishOffline });
  // 响应发出后延迟退出（给前端留收包时间）；exit 前不再做任何事
  setTimeout(() => process.exit(0), 1200).unref();
  return { shuttingDown: true, fishOffline };
}

// POST /api/actions/open-logs：explorer 打开日志目录（固定路径无参数，本机无害）
function apiOpenLogs() {
  try {
    childSpawn('explorer.exe', [join(ADAPTER_DIR, 'logs')], { detached: true, stdio: 'ignore' }).unref();
    return { opened: true };
  } catch (e) {
    throw httpErr(500, 'E_IO', `打开目录失败：${e.message}`);
  }
}

// ══════════ G8b：人格卡编辑（persona.md——主人创作的人格设定，非记忆，不属审阅闸门）══════════
// 特性：唤醒时每次现读盘 → 保存即生效无需重启（与 config 的快照语义不同，UI 必须标明）
// 保护：baseHash 防并发覆盖（编辑期间文件被外部改过 → 409）+ .bak 备份 + ops 流水 + 长度上限
function apiGetPersona() {
  let txt;
  try { txt = readFileSync(PERSONA_PATH, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { persona: { state: 'not_enabled' } };
    throw httpErr(500, 'E_IO', `persona.md 读取失败：${e.message}`);
  }
  return { persona: { state: 'ready', content: txt, hash: sha1(txt).slice(0, 12), chars: txt.length, lines: txt.split('\n').length } };
}

function apiSavePersona(body) {
  const content = typeof body.content === 'string' ? body.content : '';
  if (!content.trim()) throw httpErr(400, 'E_BAD_PARAM', '人格卡不能为空（空人格 = 鱼失忆失格）');
  if (content.length > 20_000) throw httpErr(400, 'E_BAD_PARAM', `超过 2 万字上限（当前 ${content.length} 字）——人格卡每次唤醒全文内嵌，太长会吃掉 token 预算`);
  let cur = null;
  try { cur = readFileSync(PERSONA_PATH, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw httpErr(500, 'E_IO', `persona.md 读取失败：${e.message}`);
  }
  if (body.baseHash && cur != null && sha1(cur).slice(0, 12) !== body.baseHash) {
    throw httpErr(409, 'E_CONFLICT', '人格卡在编辑期间被外部修改过——请刷新后重试（防止覆盖别人的改动）');
  }
  if (cur === content) throw httpErr(400, 'E_BAD_PARAM', '内容没有任何变化');
  try {
    if (cur != null) writeFileSync(PERSONA_PATH + '.bak', cur, 'utf8'); // 单备份（上一次的版本）
    const tmp = PERSONA_PATH + '.tmp';
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, PERSONA_PATH);
  } catch (e) {
    throw httpErr(500, 'E_IO', `写入失败：${e.message}（原文件未动，备份在 persona.md.bak）`);
  }
  logConsoleOp('persona_edit', { chars: content.length, backup: cur != null });
  return { persona: { state: 'ready', hash: sha1(content).slice(0, 12), chars: content.length, saved: true, effectiveNow: true } };
}

// ══════════ G8c：表情包回收站 ══════════
// 文件名格式 <ms时间戳>-<原名>；删除时的原描述从 ops.jsonl 反查（emoji_delete 的 detail.trash 匹配）
function apiEmojiTrash() {
  const trashDir = join(EMOJIS_DIR, '.trash');
  let files;
  try { files = readdirSync(trashDir).filter((f) => /^\d+-.+/.test(f)); } catch (e) {
    if (e.code === 'ENOENT') return { trash: { state: 'not_enabled', items: [] } };
    throw httpErr(500, 'E_IO', `回收站读取失败：${e.message}`);
  }
  // ops 流水建 trash 文件名 → 原描述 索引（同名多次删除取最新）
  const descBy = {};
  try {
    for (const o of readJsonlTail(join(ADAPTER_DIR, 'state', 'ops.jsonl'), 256 * 1024).rows) {
      if (o && o.action === 'emoji_delete' && o.detail?.trash) {
        descBy[o.detail.trash] = o.detail.oldDesc && o.detail.hadDesc ? o.detail.oldDesc : null;
      }
    }
  } catch { /* 流水读不了 → 描述留空 */ }
  const items = files.map((f) => {
    const m = f.match(/^(\d+)-(.+)$/);
    const size = (() => { try { return statSync(join(trashDir, f)).size; } catch { return 0; } })();
    return {
      trashName: f,
      name: m ? m[2] : f, // 原名（恢复时用）
      deletedAt: m ? new Date(Number(m[1])).toISOString() : null,
      size,
      oldDesc: descBy[f] ?? null,
    };
  }).sort((a, b) => String(b.deletedAt ?? '').localeCompare(String(a.deletedAt ?? '')));
  return { trash: { state: 'ready', items } };
}

// GET /api/emoji-trash-img?name=<trash文件名>：回收站缩略图（query 传名——路径含 / 会撞图片流路由）
function serveTrashImg(name, res) {
  if (!/^\d+-[\w\u4e00-\u9fa5-]{1,40}\.(png|jpe?g|gif|webp)$/i.test(String(name ?? ''))) { res.writeHead(400).end(); return; }
  const p = join(EMOJIS_DIR, '.trash', String(name));
  if (!p.startsWith(join(EMOJIS_DIR, '.trash'))) { res.writeHead(400).end(); return; }
  try {
    const ext = p.split('.').pop().toLowerCase();
    const ct = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
    res.writeHead(200, { 'Content-Type': ct, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(readFileSync(p));
  } catch { res.writeHead(404).end(); }
}

// POST /api/emoji/trash/restore {trashName, desc?}——搬回库里 + 索引恢复（描述优先级：请求 > ops 流水 > 空）
function apiEmojiRestore(body) {
  const trashName = String(body.trashName ?? '');
  if (!/^\d+-[\w\u4e00-\u9fa5-]{1,40}\.(png|jpe?g|gif|webp)$/i.test(trashName)) throw httpErr(400, 'E_BAD_PARAM', 'trashName 非法');
  const src = join(EMOJIS_DIR, '.trash', trashName);
  const origName = trashName.replace(/^\d+-/, '');
  const dest = join(EMOJIS_DIR, origName);
  if (!src.startsWith(join(EMOJIS_DIR, '.trash')) || !dest.startsWith(EMOJIS_DIR)) throw httpErr(400, 'E_BAD_PARAM', '路径非法');
  if (!existsSync(src)) throw httpErr(404, 'E_NOT_FOUND', '回收站里没有这个文件');
  if (existsSync(dest)) throw httpErr(409, 'E_EXISTS', `库里已有同名「${origName}」——先删掉现有的再来恢复`);
  renameSync(src, dest);
  // 描述恢复
  let desc = typeof body.desc === 'string' && body.desc.trim() ? body.desc.trim().slice(0, 200) : null;
  if (!desc) {
    try {
      const rows = readJsonlTail(join(ADAPTER_DIR, 'state', 'ops.jsonl'), 256 * 1024).rows;
      for (let i = rows.length - 1; i >= 0; i--) {
        const o = rows[i];
        if (o?.action === 'emoji_delete' && o.detail?.trash === trashName) { desc = o.detail.hadDesc ? o.detail.oldDesc : null; break; }
      }
    } catch { /* 流水读不了 */ }
  }
  const idx = readEmojiIndex();
  if (!idx[origName]) idx[origName] = desc || '（从回收站恢复——原描述未找到，建议补写）';
  writeEmojiIndex(idx);
  logConsoleOp('emoji_restore', { name: origName, from: trashName });
  return { name: origName, desc: idx[origName], restored: true };
}

// ══════════ G8d：自动化任务页（学习/信箱/日记/清理）══════════
// ⚠ 五轮协议实测结论：stdio 模式的 app-server 不暴露 automation RPC 方法面（automation/list 等属
//   桌面 UI 连接通道）→ 诚实降级：本页为**只读状态展示**，启停引导去 ZCode 桌面版 Automations 页面。
// 任务库 sqlite 只读（readOnly:true，任务书允许）；绝不直写（调度状态由 ZCode 内部维护）。
function apiAutomations() {
  const TASK_DB = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, '.zcode', 'v2', 'tasks-index.sqlite')
    : join(homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  let items = [];
  let dbState = 'ready';
  let dbError = null;
  let db = null;
  try {
    db = new DatabaseSync(TASK_DB, { readOnly: true });
    const rows = db.prepare('SELECT automation_id, title, cron_expr, enabled, lifecycle_status, last_run_at, next_run_at, run_count, updated_at FROM automations ORDER BY title').all();
    // 每任务 run 聚合（次数 + 最近结果）
    const runs = db.prepare('SELECT automation_id, COUNT(*) n, MAX(scheduled_at) last, SUM(CASE WHEN outcome = \'succeeded\' THEN 1 ELSE 0 END) ok FROM automation_runs GROUP BY automation_id').all();
    const byId = new Map(runs.map((r) => [r.automation_id, r]));
    const kindOf = (title) => {
      const t = String(title ?? '');
      if (t.includes('学习')) return 'learn';
      if (t.includes('信箱')) return 'inbox';
      if (t.includes('日记')) return 'diary';
      if (t.includes('清理') || t.includes('维护')) return 'clean';
      return 'other';
    };
    items = rows.map((r) => {
      const agg = byId.get(r.automation_id);
      return {
        id: r.automation_id,
        title: r.title,
        cron: r.cron_expr,
        enabled: Number(r.enabled) === 1,
        lifecycle: r.lifecycle_status ?? null,
        lastRunAt: r.last_run_at ?? null,
        nextRunAt: r.next_run_at ?? null,
        runCount: Number(r.run_count ?? 0),
        runs: agg ? { n: Number(agg.n), last: agg.last ?? null, ok: Number(agg.ok ?? 0) } : { n: 0, last: null, ok: 0 },
        kind: kindOf(r.title),
      };
    });
  } catch (e) {
    dbState = e.code === 'ENOENT' ? 'not_enabled' : 'degraded';
    dbError = String(e.message ?? e);
  } finally {
    try { db?.close(); } catch { /* 已关 */ }
  }

  // 学习积压：.learner-cursor（已学到行）vs logs/chat.jsonl 总行数
  // cursorOverflow（2026-11-22 实测）：learner 会话自己 Edit 游标无钳制，一次虚推到 2556（实际仅 2198 行）
  // → 积压永远算 0、空跑短路永远触发、学习链路静默断裂。这里标出越界，卡片显红，修游标前一眼可见。
  let backlog = null;
  try {
    const cursor = Number(readFileSync(join(FISHPOND, 'memory', '.learner-cursor'), 'utf8').trim());
    const chatLines = readFileSync(join(FISHPOND, 'logs', 'chat.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length;
    backlog = { cursor, chatLines, unlearned: Math.max(0, chatLines - cursor), cursorOverflow: cursor > chatLines + 2 };
  } catch { /* 任一文件缺失 → 不显示 */ }
  let vocabMtime = null;
  try { vocabMtime = statSync(join(FISHPOND, 'memory', 'vocab.json')).mtime.toISOString(); } catch { /* 无 */ }

  return { automations: { state: dbState, error: dbError, items, backlog, vocabMtime } };
}

// ══════════ G8e：学习/日记手动触发（按钮跑）+ 定时任务移除 ══════════
// 手动触发机制：spawn 短命 app-server → session/create（完整 workspace 参数，协议实测通）→
// subscribe → session/send（任务书 prompt + 原任务 modelSelection，不带 toolDenylist——
// 需要 Read/Write/Edit；fishpond 的 fish-guard hooks 继续兜底）→ 收终止事件 → close。
// 学习/日记的 cron 条目移除后由本机制取代（"不按不进行"）；prompt 真源=任务书文件（可随时编辑）。
const TASKS_MANUAL = join(HERE, 'tasks-manual.json');
const TASK_DB = join(process.env.USERPROFILE ?? homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
const TASK_USAGE = join(ADAPTER_DIR, 'state', 'task-usage.jsonl'); // 学习/日记任务 token 流水（每次 done 一行，控制台 token 统计合并用）
const TASK_PROMPTS = { learn: join(FISHPOND, '.learner-prompt.md'), diary: join(FISHPOND, '.diary-prompt.md') };
const TASK_MODEL_DEFAULT = {
  learn: { providerId: 'bigmodel-standard-api', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } }, // 库内原任务快照（Flash 而非满推理）
  diary: { providerId: 'bigmodel-standard-api', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } },
};
const TASK_TIMEOUT_MS = { learn: 20 * 60_000, diary: 10 * 60_000 };
// 任务宽松版 denylist：保 Read/Write/Edit/Glob/Grep/TodoWrite（学习/日记要读写盘 + 枚举目录——Glob 禁了会逼模型 Read 硬读目录），
// 禁危险与外联面（Bash/Agent/Task 族/Web/Skill/MCP 插件族）。巡逻的 DENY_ALL 全禁版在适配器侧，两不相扰。
const TASK_DENY = [
  'Bash', 'Shell', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'SendMessage', 'ReadSessionContext', 'ReadTopicResource',
  'WebFetch', 'WebSearch', 'Skill', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'MultiEdit', 'LS', 'CompatReadLocalFile', 'PluginTool', 'Workflow',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'CronCreate', 'CronDelete', 'CronList', 'CronUpdate', 'CronRead',
  'OffPeakCreate', 'OffPeakList', 'OffPeakUpdate', 'OffPeakResume',
  // MCP 全族（probe2 实测模型真会试着调 node_repl 列目录——hooks 虽拦，denylist 深度防御也点名）
  'mcp__node_repl__js',
  'mcp__plugin_zcode-fox-widget_whale__whale_balance',
  'mcp__plugin_zcode-fox-widget_whale__whale_config',
  'mcp__plugin_zcode-fox-widget_whale__whale_widget',
  'mcp__plugin_zcode-fox-widget_whale__whale_last_turn',
  'mcp__plugin_prts-boot_prts-boot__prts_boot_config',
  'mcp__plugin_prts-boot_prts-boot__prts_boot_replay',
  'mcp__plugin_prts-boot_prts-boot__prts_boot_status',
  'mcp__tools__report_image',
  'mcp__tools__report_input',
  'mcp__tools__report_image_content',
  'mcp__tools__report',
  'mcp__tools__checkpoint',
  'mcp__tools__checkpoint_rollback',
  'mcp__tools__workflow_init',
  'mcp__tools__workflow_execute',
];

// 生效模型：config.tasks.learnModel/diaryModel（配置页可改）→ 回落默认快照。
// 形状统一为协议 modelSelection {providerId, modelId, options:{reasoningLevel}}；空 provider/modelId 返回 null（走全局默认）
function effectiveTaskModel(kind) {
  let conf = null;
  try { conf = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).tasks?.[`${kind}Model`] ?? null; } catch { /* 读不到回落 */ }
  const src = conf && conf.providerId && conf.modelId ? conf : TASK_MODEL_DEFAULT[kind];
  if (!src?.providerId || !src?.modelId) return null;
  return {
    providerId: String(src.providerId), modelId: String(src.modelId),
    ...(src.reasoningLevel || src.options?.reasoningLevel ? { options: { reasoningLevel: src.reasoningLevel ?? src.options?.reasoningLevel } } : {}),
  };
}

const taskRuns = new Map(); // kind -> { status, startedAt, finishedAt, sessionId, error }
const taskEventLog = []; // 诊断：最近一次运行的事件形状（runTaskAsync 写入，status 端点暴露）

function readTasksManual() {
  try { return JSON.parse(readFileSync(TASKS_MANUAL, 'utf8')); } catch { return { archivedAt: null, tasks: {} }; }
}
function writeTasksManual(data) {
  const tmp = TASKS_MANUAL + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  renameSync(tmp, TASKS_MANUAL);
}

// POST /api/tasks/remove {id, confirm:'REMOVE'}：快照归档 → 删除 automations 行（runs 历史保留）
// 这是全控制台唯一一处直写任务库（用户明确要求的删除；当前四条均已 paused，无调度中风险）
function apiTaskRemove(body) {
  if (body.confirm !== 'REMOVE') throw httpErr(400, 'E_BAD_PARAM', 'confirm 必须是 REMOVE');
  if (typeof body.id !== 'string' || !body.id) throw httpErr(400, 'E_BAD_PARAM', 'id 必填');
  let db = null;
  try {
    db = new DatabaseSync(TASK_DB);
    const row = db.prepare('SELECT automation_id, title, cron_expr, prompt, model_selection FROM automations WHERE automation_id = ?').get(body.id);
    if (!row) throw httpErr(404, 'E_NOT_FOUND', '任务库里没有这条 automation（可能已删）');
    const kindOf = (t) => { const s = String(t ?? ''); return s.includes('学习') ? 'learn' : s.includes('信箱') ? 'inbox' : s.includes('日记') ? 'diary' : s.includes('清理') || s.includes('维护') ? 'clean' : 'other'; };
    const snap = readTasksManual();
    snap.archivedAt = new Date().toISOString();
    snap.tasks[kindOf(row.title) + '_' + row.automation_id.slice(-6)] = {
      id: row.automation_id, title: row.title, cron: row.cron_expr,
      prompt: row.prompt, modelSelection: (() => { try { return JSON.parse(row.model_selection ?? 'null'); } catch { return null; } })(),
      removedAt: new Date().toISOString(),
    };
    writeTasksManual(snap);
    db.prepare('DELETE FROM automations WHERE automation_id = ?').run(body.id);
    logConsoleOp('automation_remove', { id: body.id, title: row.title });
    return { removed: body.id, title: row.title, archived: true };
  } finally {
    try { db?.close(); } catch { /* 已关 */ }
  }
}

// 会话跑一次任务（异步后台；状态进 taskRuns）——G9 协议会话路线（与巡逻 wake 同一协议，生产验证）：
// 短命 spawn app-server → session/create → subscribe → send(prompt + modelSelection + TASK_DENY) → 收终止事件 → close → kill。
// 独立子进程，与适配器常驻的巡逻 app-server 互不干扰。模型来自 config.tasks.learnModel/diaryModel（配置页可改）。
// （G8e 曾改走 CLI -p 是因当时试的会话形态卡 MCP 认证循环；G9 用 wake 同款参数实测 6s 跑通，非协议问题。）
async function runTaskAsync(kind) {
  const st = taskRuns.get(kind);
  // prompt 真源 = tasks-manual.json 快照里库内纯 prompt（任务书 .xx-prompt.md 文件是"配置指南文档"，
  // 直接整发会让 AI 把自己当配置助手而非执行任务——G8e 实测）；快照缺失回落任务书文件
  const manual = readTasksManual();
  const keyHint = kind === 'learn' ? '学习' : '日记';
  const snapEntry = Object.values(manual.tasks ?? {}).find((t) => String(t.title ?? '').includes(keyHint));
  let prompt = snapEntry?.prompt ?? '';
  if (!prompt) {
    try { prompt = readFileSync(TASK_PROMPTS[kind], 'utf8'); } catch (e) {
      taskRuns.set(kind, { status: 'error', startedAt: st.startedAt, finishedAt: Date.now(), error: `prompt 获取失败（快照与任务书都不可用）：${e.message}` });
      return;
    }
  }
  let cliPath = '';
  try { cliPath = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).patrol.cliPath ?? ''; } catch { /* 读不到后面报 */ }
  if (!cliPath) { taskRuns.set(kind, { status: 'error', startedAt: st.startedAt, finishedAt: Date.now(), error: 'config 里没有 patrol.cliPath' }); return; }
  const modelSel = effectiveTaskModel(kind);

  // —— 精简协议客户端（照 wake 的 wakeOnce 收敛）——
  // 同款 ZCode 0.18.0 兼容：显式指定 builtin provider 配置路径（从 cliPath 推导）
  const builtinCfg = join(dirname(dirname(cliPath)), 'config', 'provider', 'zcode-builtin.json');
  const child = childSpawn(process.execPath, [cliPath, 'app-server'], { cwd: FISHPOND, env: { ...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinCfg }, stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0; let buf = '';
  const pending = new Map();
  const handlers = new Set();
  const frame = (f) => { try { child.stdin.write(JSON.stringify(f) + '\n'); } catch { /* 进程刚退，pending 由 exit 拒 */ } };
  const request = (method, params, timeoutMs = 20_000) => {
    const id = 't' + (++seq);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`request timeout: ${method}`)); }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      frame({ id, method, params });
    });
  };
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.method != null) {
        if (j.id != null) {
          // 服务端请求三应答：偏好关搜索增强；其余 -32601（服务端 15s 超时兜底，协议演进容忍）
          if (j.method === 'session/requestRuntimePreferences') frame({ id: j.id, result: { nativeSearchEnhancementsEnabled: false } });
          else frame({ id: j.id, error: { code: -32601, message: 'not supported by console task client' } });
        }
        for (const h of handlers) { try { h(j); } catch { /* 订阅者异常不反噬协议层 */ } }
      } else {
        const p = pending.get(String(j.id));
        if (p) { pending.delete(String(j.id)); j.error ? p.reject(new Error(String(j.error.message ?? 'jsonrpc error'))) : p.resolve(j.result); }
      }
    }
  });
  child.stderr.on('data', (d) => { taskEventLog.push({ t: new Date().toISOString(), kind, ev: 'stderr', msg: String(d).trim().slice(0, 150) }); });

  let outTail = '';
  let settled = false;
  const finish = (status, error = null, extra = {}) => {
    if (settled) return;
    settled = true;
    taskRuns.set(kind, { status, startedAt: st.startedAt, finishedAt: Date.now(), outTail: outTail.slice(-500), error, ...extra });
    // 任务 token 流水（只有 done 有 usage——失败/超时无产出不计费）：
    if (status === 'done' && extra.usage) {
      try {
        mkdirSync(dirname(TASK_USAGE), { recursive: true });
        appendFileSync(TASK_USAGE, JSON.stringify({ ts: new Date().toISOString(), kind, usage: extra.usage }) + '\n', 'utf8');
      } catch { /* 流水失败不影响任务结果 */ }
    }
  };
  const timer = setTimeout(() => {
    finish('error', `超过 ${Math.round(TASK_TIMEOUT_MS[kind] / 60000)} 分钟未完成（可能卡住——重试即可）`);
    try { child.kill(); } catch { /* 已退；kill 触发 exit 兜底，settled 守卫挡住误报 */ }
  }, TASK_TIMEOUT_MS[kind]);
  const cleanup = () => {
    clearTimeout(timer);
    try { child.kill(); } catch { /* 已退 */ }
  };
  child.on('exit', () => { // 会话正常路径先 finish 再 kill；这里只兜异常退出（create 阶段挂掉等）
    for (const [, p] of pending) p.reject(new Error('app-server exited'));
    pending.clear();
    finish('error', 'app-server 进程提前退出（create/subscribe 阶段失败）');
    cleanup();
  });

  try {
    await new Promise((r) => setTimeout(r, 1500)); // 等启动通知走完（wake 实测 ~1s 就绪）
    // mode:'edit' = CLI --mode edit 的协议入口（session/create schema 实测有 mode 字段）：自动批 Read/Write/Edit；
    // 危险工具仍走批准（非交互自动拒）+ fishpond fish-guard hooks + TASK_DENY 三层防线
    const created = await request('session/create', { workspace: { workspacePath: FISHPOND, workspaceKey: FISHPOND }, mode: 'edit' });
    const sessionId = created?.session?.sessionId ?? created?.sessionId;
    if (!sessionId) throw new Error('session/create 未返回 sessionId');
    taskRuns.set(kind, { ...taskRuns.get(kind), sessionId });
    await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    const answer = await new Promise((resolve, reject) => {
      let text = '';
      const onEvent = (f) => {
        if (f.method !== 'session/event') return;
        const p = f.params?.payload ?? {};
        if (p.kind === 'text_delta' && typeof p.delta === 'string') { text += p.delta; outTail = (outTail + p.delta).slice(-2000); }
        if (p.error && p.toolCallId == null) { cleanupEv(); reject(new Error(`turn-failed: ${String(p.error.message ?? p.error.type ?? '').slice(0, 140)}`)); }
        // 带 toolCallId 的 error 是工具执行失败——宿主自动回传给模型继续（probe2/三次实测），客户端不中断
        else if (p.stopReason != null && p.stopReason !== 'tool-calls') {
          // 终态（stop/length/…）。tool-calls 是中间快照：宿主自动执行工具并推进下一轮（probe2 实测），客户端只管等
          cleanupEv(); resolve({ content: String(p.content ?? text), stopReason: p.stopReason, usage: p.usage ?? null });
        }
      };
      function cleanupEv() { handlers.delete(onEvent); }
      handlers.add(onEvent); // 先订阅再 send，防事件竞态
      request('session/send', {
        sessionId,
        content: prompt,
        ...(modelSel ? { modelSelection: modelSel } : {}),
        toolDenylist: TASK_DENY,
      }, TASK_TIMEOUT_MS[kind]).catch((e) => { cleanupEv(); reject(e); });
    });
    finish('done', null, { stopReason: answer.stopReason, usage: answer.usage, model: modelSel });
    try { await request('session/close', { sessionId }, 5000); } catch { /* 关失败随它去，进程马上杀 */ }
  } catch (e) {
    finish('error', String(e.message ?? e));
  } finally {
    cleanup();
  }
}


// POST /api/tasks/run {kind, confirm:'RUN'}
function apiTaskRun(body) {
  const kind = body.kind === 'diary' ? 'diary' : body.kind === 'learn' ? 'learn' : null;
  if (!kind) throw httpErr(400, 'E_BAD_PARAM', "kind 必须是 'learn' 或 'diary'");
  if (body.confirm !== 'RUN') throw httpErr(400, 'E_BAD_PARAM', 'confirm 必须是 RUN（触发真实模型任务，二次确认）');
  const cur = taskRuns.get(kind);
  if (cur?.status === 'running') throw httpErr(409, 'E_RUNNING', `「${kind === 'learn' ? '学习' : '写日记'}」正在运行中（${Math.round((Date.now() - cur.startedAt) / 1000)}s），等它完成`);
  // 空跑短路（每次启动 ~35K tok 的固定开销，积压 0 时纯浪费）：
  if (kind === 'learn') {
    let unlearned = null;
    try {
      const cursor = Number(readFileSync(join(FISHPOND, 'memory', '.learner-cursor'), 'utf8').trim());
      const chatLines = readFileSync(join(FISHPOND, 'logs', 'chat.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length;
      unlearned = Math.max(0, chatLines - cursor);
      // 游标越界（虚推超过实际行数）时积压恒为 0——不能让"积压 0"把学习永久短路，
      // 提示里点名，让人一眼看到该修游标而不是以为没新消息。
      // +2 容忍带：AI 数行有 off-by-one 固有误差（11-22 实测重学 42 行写 2199，实际 2198），1~2 行无害自愈
      if (cursor > chatLines + 2) return { started: false, skipped: 'cursor-overflow', message: `游标越界（已学到 ${cursor} 行 > 日志现有 ${chatLines} 行）——游标虚高，学习被拦下；请回拨 .learner-cursor 后重试` };
    } catch { /* 读不到就放行，让任务自己处理 */ }
    if (unlearned === 0) return { started: false, skipped: 'no-backlog', message: '积压 0 行——没有新消息可学，本次跳过（不调模型）' };
  }
  if (kind === 'diary' && existsSync(join(FISHPOND, 'diary', `${localDay(new Date())}.md`))) {
    // 今日日记已存在 = 任务书"同名跳过"铁律的前置短路，省一次模型调用
    return { started: false, skipped: 'already-written', message: `今日日记已写过（${localDay(new Date())}.md）——同名跳过，本次不调模型` };
  }
  taskRuns.set(kind, { status: 'running', startedAt: Date.now() });
  // 学习任务前快照 candidates.md → .prev：纯保险。起因是 2026-11-22 排查时看到候选条目变少，
  // 一时分不清是人工审批删除还是任务误写（事后确认是人工审批）——留快照，下次再有疑问可以直接对账
  if (kind === 'learn') {
    try { copyFileSync(join(FISHPOND, 'memory', 'candidates.md'), join(FISHPOND, 'memory', 'candidates.md.prev')); } catch { /* 无旧文件则跳过 */ }
  }
  runTaskAsync(kind).catch((e) => taskRuns.set(kind, { status: 'error', startedAt: Date.now(), finishedAt: Date.now(), error: String(e.message ?? e) }));
  return { started: true, kind };
}

// GET /api/tasks/status：手动任务运行状态 + 学习积压 + 库内剩余 + 日记无关（省轮询请求）
function apiTaskStatus() {
  const runs = {};
  for (const [k, v] of taskRuns) runs[k] = { ...v, elapsedMs: v.status === 'running' ? Date.now() - v.startedAt : (v.finishedAt ?? 0) - (v.startedAt ?? 0) };
  const withDiag = { ...runs };
  if (taskEventLog.length) withDiag.__events = taskEventLog.slice(0, 10);
  // 学习积压（cursorOverflow 同 apiAutomations：虚推越界要显红，学习链路静默断裂不能无感知）
  let backlog = null;
  try {
    const cursor = Number(readFileSync(join(FISHPOND, 'memory', '.learner-cursor'), 'utf8').trim());
    const chatLines = readFileSync(join(FISHPOND, 'logs', 'chat.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length;
    backlog = { cursor, chatLines, unlearned: Math.max(0, chatLines - cursor), cursorOverflow: cursor > chatLines + 2 };
  } catch { /* 缺文件不显示 */ }
  let vocabMtime = null;
  try { vocabMtime = statSync(join(FISHPOND, 'memory', 'vocab.json')).mtime.toISOString(); } catch { /* 无 */ }
  // 日记积压（G9 加菜）：今日是否已写 / 今日素材（今天群消息行数）/ 连续记录 / 最近 7 天缺口。
  // 日期一律本地时区（diary 文件名与群友体感都是本地日）；今天还没写不掐断连击（从昨天起算）
  let diaryBacklog = null;
  try {
    const localDay = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const today = localDay(new Date());
    const files = readdirSync(join(FISHPOND, 'diary')).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    const daySet = new Set(files.map((f) => f.slice(0, 10)));
    const tf = files.find((f) => f === `${today}.md`);
    let todayMsgs = 0;
    try {
      for (const l of readFileSync(join(FISHPOND, 'logs', 'chat.jsonl'), 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { if (localDay(new Date(JSON.parse(l).ts)) === today) todayMsgs++; } catch { /* 坏行跳过 */ }
      }
    } catch { /* 无日志 = 0 条素材 */ }
    const streakFrom = new Date();
    if (!daySet.has(today)) streakFrom.setDate(streakFrom.getDate() - 1);
    let streak = 0;
    for (const cur = streakFrom; daySet.has(localDay(cur)); cur.setDate(cur.getDate() - 1)) streak++;
    const missing = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(Date.now() - i * 86_400_000);
      const dd = localDay(dt);
      if (dd !== today && !daySet.has(dd)) missing.push(dd);
    }
    diaryBacklog = {
      todayWritten: Boolean(tf),
      todaySize: tf ? statSync(join(FISHPOND, 'diary', tf)).size : 0,
      todayMsgs, streak, missing,
    };
  } catch { /* 无 diary 目录不显示 */ }
  const models = { learn: effectiveTaskModel('learn'), diary: effectiveTaskModel('diary'), selfcheck: effectiveTaskModel('selfcheck') }; // 当前生效模型（config ?? 默认快照；selfcheck 无默认，缺配置 = null = 跟随巡逻）
  return { tasks: { runs: withDiag, backlog, diaryBacklog, vocabMtime, models } };
}

// GET /api/diary：日记列表（fishpond/diary，日期倒序）
function apiDiaryList() {
  let files;
  try { files = readdirSync(join(FISHPOND, 'diary')).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)); } catch (e) {
    if (e.code === 'ENOENT') return { diary: { state: 'not_enabled', items: [] } };
    throw httpErr(500, 'E_IO', `日记目录读取失败：${e.message}`);
  }
  const items = files.map((f) => {
    const st = statSync(join(FISHPOND, 'diary', f));
    return { name: f, size: st.size, mtime: st.mtime.toISOString() };
  }).sort((a, b) => b.name.localeCompare(a.name));
  return { diary: { state: 'ready', items } };
}

// GET /api/diary/:name：日记内容（白名单正则 + 防穿越）
function serveDiary(name, res) {
  if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(String(name ?? ''))) { res.writeHead(400).end(); return; }
  const p = join(FISHPOND, 'diary', name);
  if (!p.startsWith(join(FISHPOND, 'diary'))) { res.writeHead(400).end(); return; }
  try {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(readFileSync(p));
  } catch { res.writeHead(404).end(); }
}

// DELETE /api/diary/:name：删除日记（确认在前端；删前全文归档 fish-adapter/logs/diary-deleted.jsonl——
// 鱼的工具面够不到该目录，与 dropped.jsonl 同理；误删可从归档手工写回恢复）
function apiDiaryDelete(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(base)) throw httpErr(400, 'E_BAD_PARAM', '日记文件名非法');
  const p = join(FISHPOND, 'diary', base);
  if (!p.startsWith(join(FISHPOND, 'diary'))) throw httpErr(400, 'E_BAD_PARAM', '路径非法');
  let content = '';
  let size = 0;
  try { content = readFileSync(p, 'utf8'); size = statSync(p).size; } catch { throw httpErr(404, 'E_NOT_FOUND', '日记不存在（可能已删）'); }
  try {
    mkdirSync(join(PKG_ROOT, 'fish-adapter', 'logs'), { recursive: true });
    appendFileSync(join(PKG_ROOT, 'fish-adapter', 'logs', 'diary-deleted.jsonl'), JSON.stringify({ deletedAt: new Date().toISOString(), name: base, size, content }) + '\n', 'utf8');
    unlinkSync(p);
  } catch (e) { throw httpErr(500, 'E_IO', `删除/归档失败：${e.message}`); }
  logConsoleOp('diary_delete', { name: base, size });
  return { name: base, deleted: true, archived: true };
}

// ── 静态文件白名单（只放行这三个，防目录穿越）──
const STATIC = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
]);

const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // style-src 'unsafe-inline'：前端图表柱高/KPI 进度条靠内联 style 属性（height/width 百分比）——
  // 无 unsafe-inline 时 CSP 会阻止全部内联样式（柱子 0 高不可见、进度条满宽假象，2026-11-21 实测踩坑）
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
};

const server = createServer((req, res) => {
  const t0 = Date.now();
  const finish = (code, obj, headers = {}) =>
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...COMMON_HEADERS, ...headers })
      .end(JSON.stringify(obj));

  // body 收集（上限 8MB：表情包上传是全站唯一二进制入口，5MB 图 base64 后约 6.8MB；GET 不受影响）
  const chunks = [];
  let size = 0;
  let oversized = false;
  let bodyCache = null;
  req.on('data', (c) => {
    size += c.length;
    if (size > 8_000_000) { oversized = true; chunks.length = 0; return; } // 超限丢弃后续（防内存），end 时回 413
    chunks.push(c);
  });
  const readBody = () => {
    if (!bodyCache) {
      bodyCache = Promise.resolve().then(() => {
        if (oversized) throw httpErr(413, 'E_TOO_LARGE', '请求体超过 8MB 上限');
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      }).catch((e) => {
        if (e.httpStatus) throw e;
        throw httpErr(400, 'E_BAD_PARAM', '请求体不是合法 JSON');
      });
    }
    return bodyCache;
  };

  req.on('end', async () => {
    try {
      // ① Host 校验：只接受本机环回域名（§11-5：Host: evil.com → 403）
  const host = String(req.headers.host ?? '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):3201$/.test(host)) {
    return finish(403, { ok: false, code: 'E_FORBIDDEN_HOST', message: '只允许 127.0.0.1 / localhost 访问' });
  }

  const url = (req.url ?? '/').split('?')[0];

  // ② 静态页
  const st = STATIC.get(url);
  if (st && req.method === 'GET') {
    try {
      const body = readFileSync(join(HERE, st.file));
      res.writeHead(200, { 'Content-Type': st.type, 'Cache-Control': 'no-cache', ...COMMON_HEADERS });
      return res.end(body);
    } catch {
      return finish(500, { ok: false, code: 'E_IO', message: `静态文件缺失: ${st.file}` });
    }
  }

  // ③ API（G3 只读子集；写请求框架先立住：Origin 必须为本机或空 + X-Fish-Console: 1，G6 的写端点直接继承）
  if (url.startsWith('/api/')) {
    if (req.method !== 'GET') {
      const origin = String(req.headers.origin ?? '');
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
        return finish(403, { ok: false, code: 'E_FORBIDDEN_ORIGIN', message: '跨站写请求被拒绝' });
      }
      if (req.headers['x-fish-console'] !== '1') {
        return finish(403, { ok: false, code: 'E_MISSING_HEADER', message: '写请求必须带 X-Fish-Console: 1' });
      }
    }
    const isRead = req.method === 'GET';
    if (!allow(isRead ? 'read' : 'write', isRead ? 40 : 10, isRead ? 2 : 10 / 60)) {
      return finish(429, { ok: false, code: 'E_RATELIMIT', message: '请求太频繁，稍候再试' });
    }

    const u = new URL(req.url, 'http://127.0.0.1');
    // Promise.resolve().then(handler)：同步 handler 抛错也走 .catch——直接 handler() 调用时
    // 异常会穿透 route() 炸掉整个进程（G4 排障实锤过一次连环崩溃）
    const route = (handler) => Promise.resolve().then(handler)
      .then((data) => finish(200, { ok: true, state: 'ready', data, meta: { ts: Date.now(), tookMs: Date.now() - t0 } }))
      .catch((e) => finish(e.httpStatus ?? 500, { ok: false, code: e.errorCode ?? 'E_IO', message: String(e.message ?? e) }));

        if (url === '/api/health' && req.method === 'GET') return route(() => apiHealth());
        if (url === '/api/overview' && req.method === 'GET') return route(() => apiOverview());
        if (url === '/api/wakes' && req.method === 'GET') return route(() => apiWakes(u.searchParams));
        if (url === '/api/wakes/stats' && req.method === 'GET') return route(() => apiWakeStats(u.searchParams));
        if (url === '/api/wakes/trace' && req.method === 'GET') return route(() => apiWakesTrace(u.searchParams));
        if (url === '/api/review/memory' && req.method === 'GET') return route(() => apiReviewList('memory'));
        if (url === '/api/review/vocab' && req.method === 'GET') return route(() => apiReviewList('vocab'));
        if (url === '/api/review/token' && req.method === 'GET') return route(() => apiReviewToken(u.searchParams));
        if (url === '/api/review/decision' && req.method === 'POST') return route(() => readBody().then(apiReviewDecision));
        if (url === '/api/review/propose-remove' && req.method === 'POST') return route(() => readBody().then(apiProposeRemove));
        if (url === '/api/memory' && req.method === 'GET') return route(() => apiMemory());
        if (url === '/api/vocab-effective' && req.method === 'GET') return route(() => apiVocabEffective());
        if (url === '/api/config' && req.method === 'GET') return route(() => apiGetConfig());
        if (url === '/api/models' && req.method === 'GET') return route(() => apiModels());
        if (url === '/api/config' && req.method === 'PATCH') return route(() => readBody().then(apiPatchConfig));
        if (url === '/api/config/apply' && req.method === 'POST') return route(() => readBody().then(apiApplyConfig));
        if (url === '/api/actions/mode' && req.method === 'POST') return route(() => readBody().then(apiModeAction));
        if (url === '/api/actions/restart' && req.method === 'POST') return route(() => readBody().then(apiRestart));
        if (url === '/api/actions/shutdown' && req.method === 'POST') return route(() => readBody().then(apiShutdown));
        if (url === '/api/send/sessions' && req.method === 'GET') return route(() => apiSendSessions());
        if (url === '/api/send/preview' && req.method === 'POST') return route(() => readBody().then((b) => apiSendProxy(b, true)));
        if (url === '/api/send' && req.method === 'POST') return route(() => readBody().then((b) => apiSendProxy(b, false)));
        if (url === '/api/emoji/gate' && req.method === 'GET') return route(() => { const g = (JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).emojiGate ?? {}); return { emoji: { enabled: g.enabled !== false, window: g.window ?? 5, max: g.max ?? 2 } }; });
        if (url === '/api/emoji/gate' && req.method === 'POST') return route(() => readBody().then(apiEmojiGate));
        if (url === '/api/emoji' && req.method === 'GET') return route(() => apiEmojiList(u.searchParams));
        if (url === '/api/emoji' && req.method === 'POST') return route(() => readBody().then(apiEmojiUpload));
        // 回收站三条路由必须在 /api/emoji/:name 图片流（emMatch）之前——否则 'trash' 被当文件名吃掉
        if (url === '/api/emoji/trash' && req.method === 'GET') return route(() => apiEmojiTrash());
        if (url === '/api/emoji/trash/restore' && req.method === 'POST') return route(() => readBody().then(apiEmojiRestore));
        if (url === '/api/emoji-trash-img' && req.method === 'GET') { serveTrashImg(u.searchParams.get('name') ?? '', res); return; }
        if (url === '/api/emoji/rename' && req.method === 'POST') return route(() => readBody().then(apiEmojiRename));
        const emMatch = url.match(/^\/api\/emoji\/([^/]+)$/);
        if (emMatch && req.method === 'GET') { serveEmojiFile(decodeURIComponent(emMatch[1]), res); return; }
        if (emMatch && req.method === 'DELETE') return route(() => apiEmojiDelete(decodeURIComponent(emMatch[1])));
        if (url === '/api/ops' && req.method === 'GET') return route(() => apiOps());
        if (url === '/api/automations' && req.method === 'GET') return route(() => apiAutomations());
        if (url === '/api/tasks/run' && req.method === 'POST') return route(() => readBody().then(apiTaskRun));
        if (url === '/api/tasks/status' && req.method === 'GET') return route(() => apiTaskStatus());
        if (url === '/api/tasks/remove' && req.method === 'POST') return route(() => readBody().then(apiTaskRemove));
        if (url === '/api/diary' && req.method === 'GET') return route(() => apiDiaryList());
        if (url.startsWith('/api/diary/') && req.method === 'DELETE') return route(() => apiDiaryDelete(decodeURIComponent(url.slice('/api/diary/'.length))));
        const dyMatch = url.match(/^\/api\/diary\/([^/]+)$/);
        if (dyMatch && req.method === 'GET') { serveDiary(decodeURIComponent(dyMatch[1]), res); return; }
        if (url === '/api/actions/prune' && req.method === 'GET') return route(() => runPrune(false));
        if (url === '/api/actions/prune' && req.method === 'POST') return route(() => readBody().then((b) => {
          if (b.confirm !== 'PRUNE') throw httpErr(400, 'E_BAD_PARAM', 'confirm 必须是 PRUNE（清会话删除不可逆，二次确认）');
          return runPrune(true);
        }));
        if (url === '/api/actions/open-logs' && req.method === 'POST') return route(() => apiOpenLogs());
        if (url === '/api/persona' && req.method === 'GET') return route(() => apiGetPersona());
        if (url === '/api/persona' && req.method === 'POST') return route(() => readBody().then(apiSavePersona));
        return finish(404, { ok: false, code: 'E_NOT_FOUND', message: `没有这个接口: ${req.method} ${url}` });
  }

  if (url === '/favicon.ico' && req.method === 'GET') {
    try {
      const ico = readFileSync(join(HERE, 'favicon.ico'));
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=604800' });
      res.end(ico);
    } catch { res.writeHead(204).end(); }
    return;
  }
      finish(404, { ok: false, code: 'E_NOT_FOUND', message: 'not found' });
    } catch (e) {
      // 处理器异常兜底：回 500，绝不让单个请求炸掉整个控制台进程
      console.error('[console] handler error:', e.stack ?? e);
      try { finish(500, { ok: false, code: 'E_IO', message: '内部错误: ' + String(e.message ?? e) }); } catch { /* 已响应 */ }
    }
  });
});

// 端口被占直接说明白（别静默崩——start-console 的探活可能探到旧进程造成"假就绪"）
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`[console] ${PORT} 端口已被占用——旧控制台还在跑（start-console.mjs 幂等，探活通即已在跑）`);
  else console.error('[console] server error:', e.message);
  process.exit(1);
});

// 进程级兜底：控制台是纯读服务无状态，单个请求炸了打日志撑住，绝不连累别的请求（更不连累鱼）
process.on('uncaughtException', (e) => console.error('[console] uncaught:', e.stack ?? e));
process.on('unhandledRejection', (e) => console.error('[console] unhandled:', e));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[console] listening on http://127.0.0.1:${PORT} (G4；数据源: wake.jsonl + 适配器 /stats)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[console] ${sig} received, bye`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
