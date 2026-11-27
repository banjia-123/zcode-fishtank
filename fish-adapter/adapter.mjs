// fish-adapter 主入口：QQ(OneBot v11) ⇄ ZCode webhook bot 的桥
// 启动：start.cmd（或 node adapter.mjs）
// 链路：NapCat WS 事件 → inbound（过滤/解析/组装）→ POST ZCode /api/bots/webhook
//       ZCode 出站回调 → :3200/zcode → outbound（验签/过滤/审计/限额）→ NapCat HTTP
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { existsSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hotJson, loadConfig, log } from './lib/util.mjs';
import { OneBotClient } from './lib/onebot.mjs';
import { createInbound, dedupHas } from './lib/inbound.mjs';
import { createOutbound } from './lib/outbound.mjs';
import { createPeers } from './lib/peer.mjs';
import { poolExtrasFor, sortByNewest } from './lib/imgpool.mjs';
import { createAppServerClient, DENY_ALL } from './wake/app-server.mjs';
import { createWakeSafe } from './wake/safe.mjs';
import { buildPrompt, fishpondDir, TOOL_AUDIT_PROMPT } from './wake/prompt.mjs';
import { noteNameOutcome } from './lib/name-tier.mjs';
import { appendNote } from './lib/sticky.mjs';
import { startOutboxPolling, ensureBridgeDirs, sweepInboxArchive, sweepEmojiTrash } from './lib/bridge.mjs';
import { rotateOversizedLogs } from './lib/rotate.mjs';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // adapter.mjs → fish-adapter/ → 包根

// —— 自检模型（2026-11-23）：config.tasks.selfCheckModel，缺省 null = 跟随巡逻模型（现状）。
// 现读 + mtime 缓存（util.hotJson——与 outbound 的 emojiGate/typing 共享同文件缓存），
// 控制台改完下一个自检周期即生效，无需重启。模块级（非巡逻闭包内）：/stats 端点与 toolSelfCheck 都要用
function selfCheckModel() {
  try {
    // 注意：adapter.mjs 的 PKG_ROOT 是两层 dirname = 工作区根（部署布局：fish-adapter 直接在工作区下），
    // 配置文件在 fish-adapter/ 里——按本文件位置取一层 dirname 才对（同 TASK_USAGE_PATH 的写法）
    const p = join(dirname(fileURLToPath(import.meta.url)), 'config.json');
    const c = hotJson(p, (d) => d.tasks?.selfCheckModel);
    return c && c.providerId && c.modelId ? {
      providerId: String(c.providerId), modelId: String(c.modelId),
      ...(c.reasoningLevel ? { reasoningLevel: String(c.reasoningLevel) } : {}),
    } : null;
  } catch (e) { log('selfcheck', `WARN selfCheckModel 读 config 失败，本轮自检按无覆盖模型（用巡逻默认模型）: ${e.message}`); return null; }
}

const cfg = loadConfig();
const FILE_MODE = cfg.bridge?.mode === 'file';
const PATROL = cfg.patrol?.enabled === true;

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

// 本地巡逻（S2-B/D）：patrol.enabled=true 时消息进 Peer 缓冲攒批，wake 客户端常驻待命。
// flush 出口本阶段仍为临时 handler（只留痕）；S2-E 接上 wakeSafe（合成报文 → 唤醒 → 出站）。
// patrol 未启用时传 null，inbound 走老链路（file 桥/webhook），行为与之前完全一致
let patrolPeers = null;
let wakeClient = null;
let wakeStats = null; // createWakeSafe 的 stats()（/stats 端点用；patrol 未启用时为 null）
let toolsOk = true;   // 工具面自检状态（false = 发现名单外工具，patrol 已熔断闭嘴——控制台要能看见原因）
if (PATROL) {
  if (!cfg.patrol?.cliPath) {
    log('boot', 'config.patrol.cliPath 未填写（ZCode CLI 的 zcode.cjs 路径）—— 拒绝启动（fail-closed）');
    process.exit(1);
  }
  const P_DIR = fishpondDir(cfg, PKG_ROOT);
  wakeClient = createAppServerClient(cfg);
  const { wakeSafe, stats: ws } = createWakeSafe(cfg, wakeClient);
  wakeStats = ws;

  // —— 工具面自检（残余风险缓解：ZCode 升级新增工具会漏禁）——
  // 启动时 + 每小时一次：问模型可用工具清单，与 DENY_ALL 比对；发现名单外工具 → 立即二次确认，
  // 两轮均在名单外才熔断（fail-closed 但抗幻觉噪声——2026-11-20 六连熔断复盘：模型自述不稳定，
  // FileRead/LS/CompatReadLocalFile 等均为幻觉名，单轮判定把幻觉当漏禁， DENY_ALL 被迫吃进一堆假名）
  // toolsOk 声明在模块级（/stats 端点要把熔断状态暴露给控制台）
  const parseToolList = (content) => String(content ?? '').split(/\r?\n/).map((s) => s.replace(/^[-*\s]+/, '').trim()).filter((s) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s));
  // 自检 probe 的 token 流水（与控制台 learn/diary 同文件，kind:'selfcheck' 区分——probe 每小时 1~2 次，
  // usage 此前完全丢弃，token 统计系统性偏低。留痕失败不影响自检）
  const TASK_USAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'state', 'task-usage.jsonl');
  const logProbeUsage = (usage) => {
    try {
      if (!usage) return;
      appendFileSync(TASK_USAGE_PATH, JSON.stringify({ ts: new Date().toISOString(), kind: 'selfcheck', usage }) + '\n', 'utf8');
    } catch { /* 留痕失败不阻断自检 */ }
  };
  async function toolSelfCheck() {
    try {
      const deny = new Set(DENY_ALL);
      const scm = selfCheckModel();
      const mTag = `（模型 ${scm ? `${scm.modelId}/${scm.reasoningLevel ?? '默认档'}` : '跟随巡逻'}）`;
      const r1 = await wakeClient.wakeOnce(TOOL_AUDIT_PROMPT, { timeoutMs: 30_000, ...(scm ? { modelSelection: scm } : {}) });
      logProbeUsage(r1.usage);
      const listed1 = parseToolList(r1.content);
      const missing1 = listed1.filter((n) => !deny.has(n));
      if (!missing1.length) {
        toolsOk = true;
        log('patrol', `工具面自检通过${mTag}：模型自述 ${listed1.length} 项，全部在黑名单内`);
        return;
      }
      // 名单外出现：可能是幻觉——立即二次确认，两轮都报的才算真工具
      const r2 = await wakeClient.wakeOnce(TOOL_AUDIT_PROMPT, { timeoutMs: 30_000, ...(scm ? { modelSelection: scm } : {}) });
      logProbeUsage(r2.usage);
      const missing2 = parseToolList(r2.content).filter((n) => !deny.has(n));
      const confirmed = missing1.filter((n) => missing2.includes(n));
      if (confirmed.length) {
        toolsOk = false;
        log('patrol', `WARN 工具面自检失败${mTag}：两轮自述均出现名单外工具 [${confirmed.join(', ')}]（一轮 ${missing1.join(', ')} / 二轮 ${missing2.join(', ') || '无'}）—— patrol 已熔断（补 DENY_ALL 后恢复）`);
      } else {
        toolsOk = true;
        log('patrol', `工具面自检${mTag}：一轮名单外 [${missing1.join(', ')}] 未在二轮复现——判定自述噪声，不熔断（真实面无漏禁）`);
      }
    } catch (e) {
      log('patrol', `工具面自检未完成（${e.message}）—— 保持上次状态 toolsOk=${toolsOk}`);
    }
  }
  // 自检节奏：每小时一次。两轮确认下真漏禁最多存活 1 小时；幻觉噪声不再哑火
  // 自检错峰（2026-11-22 事故双保险）：probe 与业务唤醒并发曾串线（app-server 已按 sessionId
  // 过滤根治，此为帧缺标识时的兜底）——有活跃唤醒时推迟 60s，宁可自检晚点也不并发
  async function toolSelfCheckGuarded() {
    if (wakeClient.inFlight() > 0) { setTimeout(toolSelfCheckGuarded, 60_000).unref?.(); return; }
    return toolSelfCheck();
  }
  setTimeout(toolSelfCheckGuarded, 3_000).unref?.();
  setInterval(toolSelfCheckGuarded, 60 * 60 * 1000).unref?.();

  // —— flush 正式出口：合成报文 → wakeSafe → 原出站链路（S2-E 接线）——
  patrolPeers = createPeers(cfg, async (chatKey, batch, info) => {
    if (!toolsOk) {
      log('patrol', `batch=${info.batchId} msgs=${batch.length} 工具面自检未过，跳过唤醒（消息已留档）`);
      return;
    }
    const prompt = buildPrompt(cfg, batch, { personaDir: P_DIR, chatKey });
    // 图片随行（2026-11-21：群图此前只进 prompt 字面标记、她看不到——协议 attachments 走本地路径由宿主读取）：
    // inbound 下载的图在 fishpond/attachments/，正则限定该前缀+图片扩展名（"下载失败"占位自动排除）
    const IMG_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const mkImgAttach = (rel) => {
      try {
        const abs = join(P_DIR, rel);
        // 附件形状按协议 M4c/N4c 归一化实测（2026-11-21）：kind/localPath/filename/mimeType——
        // {type,path} 键名会被静默丢弃（她看到的 prompt 说"图已附上"实际零附件 → "图是空的"）
        if (!abs.startsWith(join(P_DIR, 'attachments')) || !existsSync(abs)) return null;
        return { kind: 'image', localPath: abs, filename: rel.split('/').pop(), mimeType: IMG_MIME[abs.split('.').pop().toLowerCase()] ?? 'image/jpeg' };
      } catch { return null; }
    };
    let attachments = [];
    for (const m of batch) {
      for (const mm of String(m.text ?? '').matchAll(/\[图片[:：]\s*(attachments\/[^\]\s]+?\.(?:png|jpe?g|gif|webp))\]/gi)) {
        const a = mkImgAttach(mm[1]);
        if (a) attachments.push(a);
        if (attachments.length >= 5) break; // 单批图片上限（2026-11-26：3→5，按需复核需要余量）
      }
      if (attachments.length >= 5) break;
    }
    // 按需复核（2026-11-26）：本批是图话题（消息文本含"图/photo/pic"）时，把池内近 5 分钟的旧图
    // 重新附带——修复"图与话分批"与"首轮消费后无法复核"两类失明；话题离开自动不带（无消费标记，
    // 讨论中每轮可见正是复核需求）。同 peer 隔离 + 与批内新图按文件名去重，合计守 5 上限
    for (const fname of poolExtrasFor(batch, chatKey, new Set(attachments.map((a) => a.filename)))) {
      if (attachments.length >= 5) break;
      const a = mkImgAttach(`attachments/inbox/${fname}`);
      if (a) attachments.push(a);
    }
    // 串台修复（2026-11-26）：统一"从新到旧"排序（文件名 ts 前缀降序）——纯复核轮池图
    // 按入池序是旧前新后、批内图轮是新前旧后，两种"第一张"语义相反，她把新图题答成旧图角色
    attachments = sortByNewest(attachments);
    const last = batch[batch.length - 1];
    const mustMsg = batch.find((m) => m.must) ?? last;
    const hadTier2 = batch.some((m) => m.nameTier === 2);
    const r = await wakeSafe(chatKey, prompt, {
      batchId: info.batchId,
      msgs: batch.length,
      must: Boolean(mustMsg.must), // must 批次豁免最小间隔闸（有人叫她必须回）
      hadTier2,
      attachments,
      onTier2Silent: () => noteNameOutcome(chatKey, true), // tier2 批次沉默 → 退避计数 +1
    });
    if (r.skipped) { log('patrol', `batch=${info.batchId} skipped: ${r.reason}`); return; }
    if (r.error) { log('patrol', `batch=${info.batchId} 唤醒失败: ${r.error}`); return; }
    if (r.silent) {
      log('patrol', `batch=${info.batchId} msgs=${batch.length} → [SILENT]（模型选择不说话）`);
      return;
    }
    if (hadTier2) noteNameOutcome(chatKey, false); // tier2 批次有实际回复 → 退避计数归零
    // 原出站链路：审计 / 限额 / 表情 / 分段全走这一条（不绕过任何一道闸）
    // inboxFile 传批次被回复消息的 id：出站的"每消息回复数"按它计数（同批共享、跨批独立）——
    // patrol 不带真文件名，不传会退化成按整群累计（两批后全被 limit-replies-per-message 误拦）
    const out = await outbound.processMessage({ text: r.content }, {
      chatType: last.chatType,
      chatId: last.chatId,
      userId: mustMsg.userId,
      inboxFile: mustMsg.messageId,
      replyToMessageId: mustMsg.messageId,
      source: 'patrol',
    });
    log('patrol', `batch=${info.batchId} msgs=${batch.length} → 出站 ${out.action}（${r.modelMs}ms）`);
    // S3.1：鱼的回复也记便签（sent 才记——[SILENT]/被审计丢弃的不进，否则它看不到自己说过什么）
    if (out.action === 'sent') {
      appendNote(chatKey, last.chatType === 'private' ? 'private' : 'group', { from: cfg.botName || '鱼', uid: 'bot', text: r.content });
    }
  });
  // S2.13 兜底：60 秒扫一次，队首滞留超 bufferStaleMs 的强制 flush（WS 断流不憋死消息）
  setInterval(() => patrolPeers.sweep(), 60_000).unref();
  log('boot', `patrol 已启用：batchWindow=${cfg.patrol?.batchWindowMs ?? 5000}ms mustWindow=${cfg.patrol?.mustWindowMs ?? 1500}ms model=${cfg.patrol?.model?.modelId ?? '(未配)'} maxDailyWakes=${cfg.patrol?.maxDailyWakes ?? 100}`);
}

const inbound = createInbound(cfg, onebot, patrolPeers);
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
      // —— 控制台只读端点（接口契约 §5.2）：进程/缓冲/额度/模型快照。只读无副作用，不触发任何唤醒 ——
      if (req.method === 'GET' && req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          pid: process.pid,
          uptimeMs: Math.round(process.uptime() * 1000),
          mode: FILE_MODE ? 'file-bridge' : 'webhook',
          patrol: {
            enabled: PATROL,
            toolsOk,
            napcatConnected: onebot.connected, // WS 已连上 NapCat = 鱼真正在线（控制台"鱼已上线"判定）
            peers: patrolPeers ? patrolPeers.size() : 0,
            buffers: patrolPeers ? patrolPeers.pending() : [],
            appServerAlive: wakeClient ? wakeClient.isAlive() : null,
            selfCheckModel: selfCheckModel(), // null = 跟随巡逻模型（控制台健康面板显示用）
          },
          quotas: {
            wakes: wakeStats ? wakeStats() : null, // { active, queued, dailyWakes, maxDailyWakes, privateWakes, privateMaxPerDay }
            says: outbound.stats(),                // { dailyCount, maxDailyTotal, roll }
          },
          health: {
            groups: [...healthLastSeen.keys()],
            stale: [...healthStale.entries()].filter(([, c]) => c > 0),
          },
          model: cfg.patrol?.model ?? null,
        }));
        return;
      }
      // —— 控制台测试发送（接口契约 §5.3 安全四条件缺一不可）：本机回环由 listen 保证；
      // X-Console-Token 必须匹配 config.console.token；chatKey 必须在白名单；走完整出站链。
      // dryRun 默认 true（四道闸全过后原路返回，不发送不扣额度）；显式 dryRun:false 才真发（计数、进聊天记录）
      if (req.method === 'POST' && req.url === '/outbound/test') {
        const token = String(req.headers['x-console-token'] ?? '');
        if (!cfg.console?.token || token !== cfg.console.token) {
          log('http', 'rejected /outbound/test: bad/missing x-console-token');
          res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"ok":false,"code":"E_TOKEN"}');
          return;
        }
        let tBody;
        try { tBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { res.writeHead(400).end('bad json'); return; }
        const m = String(tBody.chatKey ?? '').match(/^(g|p):(\d+)$/);
        const isGroup = m?.[1] === 'g';
        const numId = m?.[2] ?? '';
        const allowed = Boolean(m) && (isGroup
          ? (cfg.allow.groups ?? []).includes(numId)
          : (cfg.allow.private ?? []).includes(numId));
        if (!allowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"ok":false,"code":"E_CHAT_NOT_ALLOWED"}');
          return;
        }
        const text = typeof tBody.text === 'string' ? tBody.text : '';
        if (!text.trim() || text.length > 500) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false,"code":"E_BAD_PARAM","field":"text"}');
          return;
        }
        const result = await outbound.processMessage({ text }, {
          chatType: isGroup ? 'group' : 'private',
          chatId: isGroup ? numId : null,
          userId: isGroup ? null : numId,
          source: 'console-test',
          dryRun: tBody.dryRun !== false,
        });
        // reason 粗分桶（契约 §5.3 stage 枚举），控制台直接映射中文不解析文本
        const r = result.reason ?? '';
        const stage = /^audit/.test(r) ? 'audit'
          : /^banned/.test(r) ? 'banned_words'
          : /^limit-(window|replies|proactive)/.test(r) ? 'interval'
          : /^limit/.test(r) ? 'quota'
          : r ? 'other' : null;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: result.action === 'dry-run' || result.action === 'sent',
          action: result.action,
          reason: r || null,
          stage,
          segments: result.segments ?? null,
          emoji: result.emoji ?? null,
        }));
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
// S2.5/D10 漏单主动补：断流确认后拉最近 10 条，去重后重放进站（补拉的消息天然 stale，
//   inbound 会打 stale 标记让模型知道不是实时的）。补拉不依赖 patrol——老链路同样受益
async function recoverGroup(gid) {
  try {
    const r = await onebot.action('get_group_msg_history', { group_id: Number(/^\d+$/.test(gid) ? gid : 0), count: 10 });
    const msgs = r?.data?.messages ?? [];
    let n = 0;
    for (const m of msgs) {
      if (!m?.message_id || dedupHas(m.message_id)) continue;
      n++;
      // 不 await：重放走完整入站判断链（白名单/去重/tier/节流），异常各自兜底
      inbound.handle({ ...m, message_type: 'group', post_type: 'message', group_id: Number(gid) }).catch(() => {});
    }
    if (n > 0) log('health', `群 ${gid} 断流补拉 recovered=${n}（已重放进站）`);
  } catch (e) {
    log('health', `群 ${gid} 补拉失败: ${e.message}`);
  }
}
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
        if (c >= 2) {
          log('health', `警告: 群 ${gid} 有新消息未入站（事件流疑似断流，连续 ${c} 轮），建议重启 NapCat`);
          recoverGroup(gid); // D10：告警的同时把漏掉的消息补回来
        }
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
    ensureBridgeDirs(cfg); // inbox 留档目录保证存在（writeInboxFile 自带 ensure，双保险）
    // 老链路关闭（2026-11-20 用户拍板提前关）：outbox 轮询停——信箱任务已删、无生产者，patrol 秒回是唯一出站。
    // 回滚 = 恢复下面一行 startOutboxPolling + 重启（信箱任务书快照在 console/tasks-manual.json）
    // startOutboxPolling(cfg, (text, meta) => outbound.processMessage(text, meta));
    // inbox 留档 + 表情回收站 7 天滚动清理；运行日志 2MB 轮转：启动 10s 清一遍存量，之后每 6 小时一轮
    const housekeep = () => {
      sweepInboxArchive(cfg);
      sweepEmojiTrash(cfg);
      rotateOversizedLogs(cfg);
    };
    setTimeout(housekeep, 10_000).unref?.();
    setInterval(housekeep, 6 * 3600_000).unref?.();
    log('boot', '文件桥：仅 inbox 留档 + 存档滚动清理（inbox/表情回收站 7 天、运行日志 2MB 轮转）');
  }
  onebot.start();
});

// —— 优雅退出 ——
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('boot', `${sig} received, shutting down`);
    wakeClient?.stop();
    onebot.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
