// wake 唯一实现（S2.14）：ZCode Protocol (app-server) 客户端
// 协议为 S2-A 逆向实测：ndjson JSON-RPC 双向——
//   spawn 常驻子进程 → session/create（期间服务端反问 session/requestRuntimePreferences，
//   应答最小合法值）→ session/subscribe(desktop-continuous) → session/send
//   （modelSelection 按次指定模型 + toolDenylist 零工具）→ session/event 流里收
//   text_delta / 终止事件（content+stopReason+usage）→ session/close
// 安全：DENY_ALL 点名禁全部已知工具（零工具形态——模型只出文字，不读盘不写盘不联网）；
//   名单是点名的（协议不支持通配），ZCode 升级新增工具的漏禁由 S2-E 工具面自检兜底。
// 容错：未知帧一律忽略（协议漂移容忍）；子进程崩溃自动重启（指数退避封顶 60s），
//   崩溃时所有 pending 请求立即拒绝（上层熔断接管）。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../lib/util.mjs';

const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // wake/ → fish-adapter/ → 包根

// 零工具黑名单（钉死代码常量，不进 config——防线不许被配置误删）。
// S2-A 实测工具面 + Cron*/OffPeak* 定时任务族 + 本机 MCP 插件全量；
// 多列不存在的名字无害（协议只按名匹配），漏列才是风险——发现漏列找工具面自检。
export const DENY_ALL = [
  // 内置工具
  'Agent', 'Task', 'AskUserQuestion', 'Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode',
  'Glob', 'Grep', 'Read', 'Skill', 'TaskOutput', 'TaskStop', 'TodoRead', 'TodoWrite',
  'WebFetch', 'WebSearch', 'Write', 'SendMessage', 'ReadSessionContext', 'ReadTopicResource', 'Shell',
  // ReadTopicResource：2026-11-20 ZCode 升级新增（话题资源读取），工具面自检当场抓到漏禁后补入
  // ZCode 大版本升级第三抓（2026-11-20 13:46 自检五连报后合并补入；部分名字疑似模型自述幻觉，一并点名无害）
  'MultiEdit', 'LS', 'CompatReadLocalFile', 'PluginTool', 'Workflow',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  // 定时/闲时任务族（S2-A 实测 deny 后仍剩 Cron，必须点名）
  'CronCreate', 'CronDelete', 'CronList', 'CronUpdate', 'CronRead',
  'OffPeakCreate', 'OffPeakList', 'OffPeakUpdate', 'OffPeakResume',
  // Notebook 系：2026-11-22 04:52 自检双跑均报 NotebookEdit（本体一直漏列），00:38 幻觉轮报过 ReadCell/EditCell——一并点名
  'NotebookEdit', 'NotebookReadCell', 'NotebookEditCell',
  // MCP：鲸鱼挂件 / PRTS 启动动画 / node_repl（浏览器与计算机控制）/ 宿主 tools 上报
  'mcp__plugin_zcode-fox-widget_whale__whale_balance',
  'mcp__plugin_zcode-fox-widget_whale__whale_config',
  'mcp__plugin_zcode-fox-widget_whale__whale_widget',
  'mcp__plugin_zcode-fox-widget_whale__whale_last_turn',
  'mcp__plugin_prts-boot_prts-boot__prts_boot_config',
  'mcp__plugin_prts-boot_prts-boot__prts_boot_replay',
  'mcp__plugin_prts-boot_prts-boot__prts_boot_status',
  'mcp__node_repl__js',
  'mcp__tools__report_image',
  'mcp__tools__report_input',
  'mcp__tools__report_image_content',
  // mcp__tools__ 检查点/工作流族：2026-11-20 13:46 自检报出（checkpoint_rollback 等），与 report 裸名一并点名
  'mcp__tools__report',
  'mcp__tools__checkpoint',
  'mcp__tools__checkpoint_rollback',
  'mcp__tools__workflow_init',
  'mcp__tools__workflow_execute',
  // Task / report_image_content：2026-11-20 工具面自检第二抓（Agent 的自述别名 + MCP 上报族新增）
];

export function createAppServerClient(cfg) {
  const CLI = cfg.patrol?.cliPath;
  const WORKSPACE = cfg.bridge?.fishpondDir ?? join(PKG_ROOT, 'fishpond');
  const model = cfg.patrol?.model ?? {};

  let child = null;
  let reqSeq = 0;
  let restartDelay = 1000;
  let stopped = false;
  const pending = new Map(); // 请求 id -> {resolve, reject}
  const eventHandlers = new Set(); // 通知订阅者
  let starting = null; // 启动 Promise（防并发 spawn）

  function handleFrame(j) {
    // 服务端请求（带 method 且带 id）：偏好请求给最小合法应答，其余一律 -32601——
    // 服务端有 15s 请求超时兜底，新请求类型不会卡死 wake（协议演进容忍）
    if (j.method != null) {
      if (j.id != null) {
        if (j.method === 'session/requestRuntimePreferences') {
          send({ id: j.id, result: { nativeSearchEnhancementsEnabled: false } });
        } else {
          send({ id: j.id, error: { code: -32601, message: 'not supported by fish-adapter wake client' } });
        }
      }
      // 通知（无 id）：分发给订阅者；startup/storageState 等无人订阅自然丢弃
      for (const h of eventHandlers) {
        try { h(j); } catch { /* 订阅者异常不反噬协议层 */ }
      }
      return;
    }
    // 响应（有 id 无 method）
    const p = pending.get(String(j.id));
    if (p) {
      pending.delete(String(j.id));
      if (j.error) p.reject(new Error(String(j.error.message ?? 'jsonrpc error')));
      else p.resolve(j.result);
    }
    // 未知响应：忽略（协议漂移容忍）
  }

  function spawnServer() {
    // ZCode 0.18.0 起 builtin provider 配置的查找路径变化（找 <resources>/glm/provider/ 而实际在
    // <resources>/config/provider/）→ 无头 app-server 启动即崩（code=1 循环）。用官方环境变量显式
    // 指定配置文件路径（从 CLI 路径推导：<resources>/config/provider/zcode-builtin.json）
    const builtinCfg = join(dirname(dirname(CLI)), 'config', 'provider', 'zcode-builtin.json');
    child = spawn(process.execPath, [CLI, 'app-server'], {
      cwd: WORKSPACE,
      env: { ...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinCfg },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { handleFrame(JSON.parse(line)); } catch { /* 坏行跳过 */ } }
      }
    });
    child.stderr.on('data', (d) => log('wake', `app-server stderr: ${String(d).trim().slice(0, 200)}`));
    child.on('exit', (code) => {
      child = null;
      const err = new Error(`app-server exited (code=${code})`);
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      if (stopped) return; // 主动 stop 不重启
      log('wake', `WARN app-server 进程退出 code=${code}，${restartDelay}ms 后重启`);
      setTimeout(spawnServer, restartDelay);
      restartDelay = Math.min(restartDelay * 2, 60_000); // 成功跑稳后由 ensure() 重置
    });
  }

  function send(frame) {
    try { child?.stdin.write(JSON.stringify(frame) + '\n'); } catch { /* 进程刚退，pending 会被 exit 拒绝 */ }
  }

  function request(method, params, timeoutMs = 15_000) {
    const id = 'c' + (++reqSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      send({ id, method, params });
    });
  }

  async function ensure() {
    if (child?.exitCode == null && child) { restartDelay = 1000; return; }
    if (!starting) {
      starting = (async () => { spawnServer(); await sleep(1500); })(); // 等启动通知走完（实测 ~1s 就绪）
      starting.finally(() => { starting = null; }).catch(() => {});
    }
    await starting;
  }

  // 单次唤醒：新会话一次性往返（S2.14 只做 new-session；群聊复用长会话会串台）
  // 返回 { content, stopReason, usage }；[SILENT] 判定归上层 safe（wake 只管协议）
  // attachments（2026-11-21）：{type:'image', path:'绝对路径'} 数组——协议原生附件（宿主自己读文件），
  // 群图随行让她真能"看到"图（此前 [图片: xxx] 对她只是字面文本，零工具形态又读不了盘）
  // inFlight 包装层：活跃唤醒计数（见 return 处 inFlight 暴露说明）
  let unknownKindLogged = false; // 帧形状探测去重（进程级一次即可）
  async function wakeOnce(prompt, opts = {}) {
    inFlight++;
    try {
      return await wakeOnceRaw(prompt, opts);
    } finally {
      inFlight--;
    }
  }

  // modelSelection（按次覆盖，2026-11-23 自检模型用）：覆盖值优先，缺省回落客户端创建时的巡逻模型快照；
  // 两种形状都认——扁平 reasoningLevel（config 形）或 options.reasoningLevel（协议形）
  async function wakeOnceRaw(prompt, { timeoutMs = 90_000, attachments, modelSelection } = {}) {
    await ensure();
    const m = modelSelection ?? model;
    const msel = m.providerId && m.modelId ? { modelSelection: {
      providerId: m.providerId, modelId: m.modelId,
      ...(m.reasoningLevel || m.options?.reasoningLevel ? { options: { reasoningLevel: m.reasoningLevel ?? m.options.reasoningLevel } } : {}),
    } } : {};
    const created = await request('session/create', {
      workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE },
    });
    const sessionId = created?.session?.sessionId ?? created?.sessionId;
    if (!sessionId) throw new Error('session/create 未返回 sessionId');
    try {
      await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
      return await new Promise((resolve, reject) => {
        let text = '';
        let thinking = ''; // 思考过程采集（wake trace 用，2026-11-22）；协议若无思考帧则保持空串，trace 降级为 prompt+reply
        const onEvent = (frame) => {
          if (frame.method !== 'session/event') return;
          // 并发串线隔离（2026-11-22 09:38 实测事故）：宿主事件流是广播型——每小时自检 probe 与
          // 业务唤醒并发时，probe 的终态帧被业务处理器 resolve，7 行工具名被当鱼嘴发言出了站，
          // 业务真正的回复被 probe 处理器吃掉。宿主多会话并存，帧带会话标识，按它严格过滤；
          // 帧缺标识（协议漂移兜底）不过滤，靠自检错峰双保险。
          const evSid = frame.params?.sessionId ?? frame.params?.payload?.sessionId;
          if (evSid && evSid !== sessionId) return;
          const p = frame.params?.payload ?? {};
          if (p.kind === 'text_delta' && typeof p.delta === 'string') text += p.delta;
          // 思考 delta：**实测协议命名 reasoning_delta**（2026-11-22 02:03 探测日志抓到）；thinking_delta 为常见约定别名，一并兼容
          else if ((p.kind === 'reasoning_delta' || p.kind === 'thinking_delta') && typeof p.delta === 'string') thinking += p.delta;
          else if (p.kind === 'thinking' && typeof (p.delta ?? p.content ?? p.text) === 'string') thinking += (p.delta ?? p.content ?? p.text);
          else if (p.kind !== 'text_delta' && typeof p.delta === 'string' && !unknownKindLogged) {
            // 帧形状探测（进程级一次）：上线后瞄一眼 adapter.log 就知道协议还有哪些 delta 形态
            unknownKindLogged = true;
            log('wake', `unknown event kind=${JSON.stringify(String(p.kind ?? '?')).slice(0, 40)}（带 string delta，未采集——若这是思考/工具帧请补分支）`);
          }
          if (p.error) {
            cleanup();
            reject(new Error(`turn-failed: ${String(p.error.message ?? p.error.type ?? '').slice(0, 140)}`));
          } else if (p.content != null && p.stopReason != null) {
            cleanup();
            resolve({ content: String(p.content ?? text), thinking: thinking || null, stopReason: p.stopReason, usage: p.usage ?? null });
          }
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('wake-timeout')); }, timeoutMs);
        function cleanup() { clearTimeout(timer); eventHandlers.delete(onEvent); }
        eventHandlers.add(onEvent); // 先订阅再 send，防事件竞态
        request('session/send', {
          sessionId,
          content: prompt,
          ...(attachments?.length ? { attachments } : {}),
          ...msel,
          toolDenylist: DENY_ALL,
        }, timeoutMs).catch((e) => { cleanup(); reject(e); });
      });
    } finally {
      // 超时/失败也关会话——挂着没关的会话继续烧钱
      request('session/close', { sessionId }, 5000).catch(() => { /* 关失败随它去，进程级兜底 */ });
    }
  }

  function stop() {
    stopped = true;
    try { child?.kill(); } catch { /* 已退 */ }
  }

  let inFlight = 0; // 活跃 wakeOnce 数（自检错峰用：串线已按 sessionId 过滤，此为帧缺标识时的兜底）
  return { wakeOnce, ensure, stop, isAlive: () => Boolean(child), inFlight: () => inFlight };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
