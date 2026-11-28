// 鱼缸控制台 · 前端（G3 骨架）：原生 DOM + 单轮询器 + hash 路由 + 三态渲染
// 原则（方案 v2 §6/§10）：数据旧 > 数据空——断线/降级保留上次快照；"尚未启用"不是错误
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMs = (n) => n == null ? '—' : (n >= 1000 ? (n / 1000).toFixed(1) + 's' : n + 'ms');
const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toTimeString().slice(0, 8); };
const fmtNum = (n) => n == null ? '—' : (n >= 10000 ? (n / 1000).toFixed(1) + 'K' : String(n));
const hhmm = (h) => String(h).padStart(2, '0') + ':00';

// ── API 封装：AbortController 超时（默认 8s；长任务用 timeoutMs 覆盖，如上线全家桶 150s）──
async function api(path, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000);
  try {
    const r = await fetch(path, {
      signal: ac.signal,
      method: opts.method || 'GET',
      headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), 'X-Fish-Console': '1' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || ('HTTP ' + r.status));
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('前端等待超时——后端脚本仍在后台执行，稍等片刻看顶栏状态即可');
    throw e;
  } finally { clearTimeout(timer); }
}

// ── 单轮询器：一个 setInterval，内部按 nextDue 调度（方案 v2 §10）──
const pollTasks = new Map(); // key -> { ms, fn, nextDue, running, fails }
setInterval(() => {
  if (document.hidden) return; // 后台标签暂停轮询
  const now = Date.now();
  for (const [key, t] of pollTasks) {
    if (now < t.nextDue || t.running) continue;
    t.nextDue = now + t.ms;
    t.running = true;
    t.fn().then(() => { t.fails = 0; })
      .catch(() => { t.fails = (t.fails ?? 0) + 1; })
      .finally(() => {
        t.running = false;
        $('#refreshHint').textContent = t.fails >= 3 ? '连接中断' : `${Math.round(t.ms / 1000)}s 轮询`;
      });
  }
}, 1000);
function pollEvery(key, ms, fn) {
  pollTasks.set(key, { ms, fn, nextDue: 0, running: false, fails: 0 });
}

// ── hash 路由 ──
const PAGES = ['overview', 'wakes', 'review', 'memory', 'automations', 'config', 'send', 'chattest', 'emoji', 'ops'];
function route() {
  const h = (location.hash || '#/overview').replace(/^#\//, '');
  const page = PAGES.includes(h) ? h : 'overview';
  for (const p of PAGES) {
    $('#page-' + p).classList.toggle('hidden', p !== page);
    document.querySelector(`.nav-item[data-page="${p}"]`)?.classList.toggle('active', p === page);
  }
  // 工作日志：进入页面立即渲染一轮 + 挂轮询（仅今天 10s），离开摘除
  if (page === 'wakes') { renderWakes().catch(() => {}); startWakesPolling(); }
  else pollTasks.delete('wakes');
  // 审阅 / 记忆与行话 / 配置：进页加载一轮（手动刷新型，不轮询）
  if (page === 'review') loadReview().catch(() => {});
  if (page === 'memory') loadMemoryPage().catch(() => {});
  if (page === 'config') { loadConfig().catch(() => {}); loadPersona().catch(() => {}); }
  if (page === 'send') loadSend().catch(() => {});
  if (page === 'chattest') loadChatTest().catch(() => {});
  if (page === 'emoji') loadEmoji().catch(() => {});
  if (page === 'ops') { loadOps().catch(() => {}); loadBackupStatus().catch(() => {}); }
  if (page === 'automations') { loadAutomations().catch(() => {}); loadDiary().catch(() => {}); }
}
window.addEventListener('hashchange', route);
document.querySelectorAll('.nav-item').forEach((n) => n.addEventListener('click', () => { location.hash = '#/' + n.dataset.page; }));

// ── toast ──
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

// ── 顶栏胶囊（/api/health，3s）──
const lastGood = {}; // key -> 快照（断线保留）
function setPill(id, cls, html) {
  const p = $(id);
  p.className = 'pill ' + cls;
  p.innerHTML = '<i class="dot"></i>' + html;
}
function renderHealth() {
  return api('/api/health').then((j) => {
    const a = j.data.adapter;
    lastGood.health = j.data;
    renderModeSwitch(Boolean(a.online));
    if (a.online) {
      setPill('#pill-adapter', a.stats || a.quotas ? 'ok' : 'warn', `适配器 <b>在线</b> <span class="mono" style="color:#6f838d">${a.ms}ms</span>`);
      const pt = a.patrol;
      if (pt) {
        const cls = !pt.enabled ? 'warn' : (pt.toolsOk === false ? 'err' : 'ok');
        const label = !pt.enabled ? '已停' : (pt.toolsOk === false ? '熔断' : '正常');
        setPill('#pill-patrol', cls, `巡逻 <b>${label}</b>`);
      } else {
        setPill('#pill-patrol', 'warn', '巡逻 <b>未知</b>');
      }
    } else {
      setPill('#pill-adapter', 'err', '适配器 <b>离线</b>');
      setPill('#pill-patrol', 'warn', '巡逻 <b>—</b>');
    }
    $('#ov-banner').classList.add('hidden');
  }).catch(() => {
    // 控制台自身失联：胶囊转红但不清数据（数据旧 > 数据空）
    setPill('#pill-adapter', 'err', '适配器 <b>?</b>');
    renderModeSwitch(false);
  });
}

// ── KPI 卡渲染（8 张）──
function kpiCard({ label, value, den, unit, meterPct, meterCls, foot, na, degraded }) {
  const cls = 'kpi' + (na ? ' na' : '') + (degraded ? ' degraded' : '');
  const meter = meterPct != null ? `<div class="meter ${meterCls || ''}"><i style="width:${Math.min(100, meterPct)}%"></i></div>` : '';
  return `<div class="${cls}">
    <div class="kpi-top"><span class="kpi-label">${label}</span></div>
    <div class="kpi-val"><b>${value}</b>${den ? `<span class="den">${den}</span>` : ''}${unit ? `<span class="unit">${unit}</span>` : ''}</div>
    ${meter}
    <div class="kpi-foot">${foot || '&nbsp;'}</div>
  </div>`;
}

function renderOverview() {
  return api('/api/overview').then((j) => {
    const d = j.data;
    lastGood.overview = d;
    $('#ov-sub').textContent = `${d.botName} · 数据截至 ${new Date().toTimeString().slice(0, 8)} · 今日 ${d.day}`;

    const w = d.wake;
    const a = d.adapter;
    const notEnabled = w.state === 'not_enabled';
    const degraded = w.state === 'degraded';

    // —— 8 张 KPI ——
    const c = notEnabled ? null : (w.counts || {});
    const q = a.online ? (a.quotas || {}) : null;
    const cards = [
      kpiCard({
        label: '今日唤醒', value: notEnabled ? '—' : c.wakes, den: q && q.wakes ? '/' + q.wakes.maxDailyWakes : '',
        meterPct: notEnabled ? null : (q && q.wakes ? (c.wakes / Math.max(1, q.wakes.maxDailyWakes)) * 100 : null),
        meterCls: 'warn',
        foot: notEnabled ? '尚未启用（还没有唤醒记录）' : `本地拦截 ${c.skipped} 次（没花钱）`,
        na: notEnabled, degraded,
      }),
      kpiCard({
        label: '今日说话', value: q ? q.says.dailyCount : '—', den: q ? '/' + q.says.maxDailyTotal : '',
        meterPct: q ? (q.says.dailyCount / Math.max(1, q.says.maxDailyTotal)) * 100 : null,
        foot: q ? '来源：出站计数器（/stats）' : '适配器离线，显示 —',
        na: !q, degraded: !q && a.online === false,
      }),
      kpiCard({
        label: '沉默次数', value: notEnabled ? '—' : c.silent, unit: '次',
        foot: notEnabled ? '尚未启用' : '模型选择不说话（tier2 正常行为）',
        na: notEnabled, degraded,
      }),
      kpiCard({
        label: '说话率', value: notEnabled || c.speakRate == null ? '—' : c.speakRate, unit: notEnabled ? '' : '%',
        foot: notEnabled ? '尚未启用' : '口径：sent / (sent+silent)，不含超时与拦截',
        na: notEnabled || c.speakRate == null, degraded,
      }),
      kpiCard({
        label: '异常', value: notEnabled ? '—' : (c.timeout + c.error), unit: notEnabled ? '' : '次',
        foot: notEnabled ? '尚未启用' : `超时 ${c.timeout} · 错误 ${c.error}`,
        na: notEnabled, degraded,
      }),
      kpiCard({
        label: '今日 Tokens', value: notEnabled ? '—' : fmtNum(w.tokens.input + w.tokens.output + (w.taskTokens?.input ?? 0) + (w.taskTokens?.output ?? 0)),
        unit: notEnabled || degraded ? '' : ((w.taskTokens?.runs ?? 0) > 0 ? `含任务${fmtNum((w.taskTokens?.input ?? 0) + (w.taskTokens?.output ?? 0))}` : ''),
        foot: notEnabled ? '尚未启用' : `唤醒 ${fmtNum(w.tokens.input + w.tokens.output)} · 任务 ${fmtNum((w.taskTokens?.input ?? 0) + (w.taskTokens?.output ?? 0))}（学习${w.taskTokens?.detail?.learn ?? 0}+日记${w.taskTokens?.detail?.diary ?? 0}+自检${w.taskTokens?.detail?.selfcheck ?? 0}次）`,
        na: notEnabled, degraded,
      }),
      kpiCard({
        label: '私聊额度', value: q && q.wakes ? q.wakes.privateWakes : '—', den: q && q.wakes ? '/' + q.wakes.privateMaxPerDay : '',
        meterPct: q && q.wakes ? (q.wakes.privateWakes / Math.max(1, q.wakes.privateMaxPerDay)) * 100 : null,
        foot: q ? '独立钱包，与全局各查一遍' : '适配器离线',
        na: !q,
      }),
      kpiCard({
        label: '排队', value: q ? (q.wakes.queued + (a.patrol?.buffers || []).reduce((s, b) => s + b.pending, 0)) : '—', unit: q ? '条' : '',
        foot: q ? `进行中 ${q.wakes.active} · 缓冲群 ${a.patrol?.peers ?? 0}` : '适配器离线',
        na: !q,
      }),
    ];
    $('#kpis').innerHTML = cards.join('');

    if (notEnabled || degraded) {
      const b = $('#ov-banner');
      b.classList.remove('hidden', 'err');
      $('#ov-banner-text').innerHTML = degraded
        ? `wake.jsonl 读取失败（${esc(w.error || '未知原因')}）——以上为最后成功快照`
        : 'wake.jsonl 尚不存在——鱼还没被唤醒过。这不是错误，陪她聊两句就有了。';
    } else {
      $('#ov-banner').classList.add('hidden');
    }

    // —— 今日小时柱状图（0-23，静默时段高亮）——
    const sh = d.silentHours || {};
    $('#ov-sh').textContent = `${sh.start ?? '—'} ~ ${sh.end ?? '—'}`;
    let [ss, se] = [-1, -1];
    if (sh.start && sh.end) {
      ss = Number(sh.start.split(':')[0]); se = Number(sh.end.split(':')[0]);
    }
    const hours = notEnabled ? new Array(24).fill(0) : w.hourly;
    const maxH = Math.max(1, ...hours);
    const nowH = new Date().getHours();
    let bars = '';
    for (let h = 0; h < 24; h++) {
      const inNight = ss >= 0 && (ss <= se ? (h >= ss && h < se) : (h >= ss || h < se));
      const pct = (hours[h] / maxH) * 100;
      // 柱高用像素内联（150px 容器，1%=1.5px；有数据至少 3px 可见）——
      // 百分比高度在 grid 行高 auto + align-items:end 下会塌陷为 0（实测柱子全不可见的根因）
      const px = Math.max(hours[h] > 0 ? 3 : 0, Math.round((hours[h] / maxH) * 150));
      bars += `<div class="bar ${inNight ? 'night-bar' : ''} ${hours[h] === 0 ? 'zero' : ''}" title="${hhmm(h)} · ${hours[h]} 次唤醒"><i style="height:${px}px"></i></div>`;
    }
    $('#chart').innerHTML = (ss >= 0
      ? `<div class="night" style="left:calc(26px + ${(ss <= se ? ss : 0) / 24} * (100% - 26px)); width:calc(${(ss <= se ? se - ss : 24 - ss + se) / 24} * (100% - 26px))"></div>`
      : '') + bars;
    $('#xaxis').innerHTML = Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? h : ''}</span>`).join('');

    // —— 侧栏：额度钱包 + 队列 ——
    if (q && q.wakes) {
      const wq = q.wakes, sq = q.says;
      $('#quotas-body').innerHTML = [
        ['思考（唤醒）', `${wq.dailyWakes} / ${wq.maxDailyWakes}`, wq.dailyWakes / wq.maxDailyWakes],
        ['说话（出站）', `${sq.dailyCount} / ${sq.maxDailyTotal}`, sq.dailyCount / sq.maxDailyTotal],
        ['私聊（独立）', `${wq.privateWakes} / ${wq.privateMaxPerDay}`, wq.privateWakes / wq.privateMaxPerDay],
      ].map(([k, v, r]) => `<div class="row"><span class="k">${k}</span><span class="v ${r > 0.8 ? 'warn' : ''}">${v}</span></div>`).join('');
      $('#queues-body').innerHTML = [
        ['唤醒排队', wq.queued], ['进行中', wq.active],
        ['缓冲群数', a.patrol?.peers ?? '—'],
        ['缓冲消息', (a.patrol?.buffers || []).reduce((s, b) => s + b.pending, 0)],
        ['app-server', a.patrol?.appServerAlive ? '存活' : '未拉起'],
      ].map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
    } else {
      $('#quotas-body').innerHTML = '<div class="na-box"><div class="t">适配器离线</div><div class="d">额度与队列为运行时数据，适配器启动后自动显示。</div></div>';
      $('#queues-body').innerHTML = '';
    }

    // —— 最近流水 ——
    if (notEnabled) {
      $('#recent-body').innerHTML = '<tr><td colspan="7" class="dim" style="text-align:center;height:60px">尚未启用——没有唤醒记录</td></tr>';
    } else {
      const RES = { sent: ['sent', '已回'], silent: ['silent', '沉默'], timeout: ['timeout', '超时'], error: ['error', '错误'], skipped: ['skip', '拦截'] };
      $('#recent-body').innerHTML = (w.recent || []).map((r) => {
        const [cls, label] = RES[r.result] || ['skip', r.result];
        return `<tr>
          <td class="num">${fmtTime(r.ts)}</td>
          <td title="${esc(r.chat.full)}">${esc(r.chat.display)}</td>
          <td class="num">${r.msgs}</td>
          <td class="num">${fmtMs(r.modelMs)}</td>
          <td><span class="bdg ${cls}">${label}</span></td>
          <td class="num">${r.lines ?? '—'}</td>
          <td class="dim" title="${esc(r.reason ?? '')}">${esc(r.reason ?? '')}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="7" class="dim" style="text-align:center;height:60px">今天还没有记录</td></tr>';
    }
  });
}

// ── 工作日志页（G4）：筛选 + 列表 + 统计 + 展开 ──
// 口径（v2 §5.2 写死）：说话率分母不含 timeout/skipped；平均响应排除 timeout；段数均值仅 sent
const wkState = { date: '', chat: '', result: '', open: new Set() };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const BUCKET_NAMES = { silent_hours: '静默时段', circuit_open: '熔断退避', quota_wake: '思考额度', quota_private: '私聊额度', interval: '同群间隔', other: '其他' };
const RES_LABEL = { sent: '已回', silent: '沉默', timeout: '超时', error: '错误', skipped: '拦截' };

function startWakesPolling() {
  pollTasks.delete('wakes');
  // date 未初始化（刚进页）视同今天——renderWakes 首轮才会给它赋值，先判断会漏挂轮询
  if (!wkState.date || wkState.date === todayStr()) pollEvery('wakes', 10000, renderWakes); // 历史日期不轮询（v2 §10）
}

function renderWkStats(sw) {
  const el = $('#wk-stats');
  if (!sw || sw.state !== 'ready') {
    el.innerHTML = `<div class="na-box"><div class="t">${sw && sw.state === 'degraded' ? 'wake.jsonl 读取失败' : 'wake.jsonl 尚未启用'}</div><div class="d">${sw && sw.state === 'degraded' ? esc(sw.error || '') : '鱼还没被唤醒过——这不是错误。'}</div></div>`;
    return;
  }
  const c = sw.counts ?? {};
  const chips = Object.entries(sw.buckets ?? {}).filter(([, n]) => n > 0)
    .map(([k, n]) => `<span class="chip">${BUCKET_NAMES[k] ?? k} <b>${n}</b></span>`).join('');
  const t = sw.tokens ?? { input: 0, output: 0, cacheRead: 0 };
  el.innerHTML = `<div class="stats-row">
      <div class="stat"><div class="k">真唤醒</div><div class="v">${c.wakes ?? 0}<small>次</small></div></div>
      <div class="stat"><div class="k">说话率</div><div class="v">${c.speakRate == null ? '—' : c.speakRate}<small>%</small></div></div>
      <div class="stat"><div class="k">平均响应</div><div class="v">${c.avgModelMs == null ? '—' : fmtMs(c.avgModelMs)}<small>· 排除超时</small></div></div>
      <div class="stat"><div class="k">段数均值</div><div class="v">${c.avgLines ?? '—'}<small>· 仅已回</small></div></div>
      <div class="stat"><div class="k">Tokens</div><div class="v">${fmtNum(t.input + t.output + (sw.taskTokens?.input ?? 0) + (sw.taskTokens?.output ?? 0))}<small>缓存 ${fmtNum(t.cacheRead)}${(sw.taskTokens?.runs ?? 0) > 0 ? ` · 任务 ${fmtNum((sw.taskTokens?.input ?? 0) + (sw.taskTokens?.output ?? 0))}` : ''}</small></div></div>
    </div>
    ${chips ? `<div class="stats-row2">本地拦截 ${c.skipped ?? 0} 次：${chips}</div>` : (c.skipped ? `<div class="stats-row2">本地拦截 ${c.skipped} 次（没花钱）</div>` : '')}`;
}

function renderWkList(w) {
  const el = $('#wk-list');
  if (!w || w.state !== 'ready') {
    el.innerHTML = `<div class="wempty"><div class="na-box"><div class="t">${w && w.state === 'degraded' ? 'wake.jsonl 读取失败' : '尚未启用'}</div><div class="d">鱼还没被唤醒过——陪她聊两句就有了。</div></div></div>`;
    return;
  }
  if (!w.rows.length) {
    el.innerHTML = `<div class="wempty">这一天没有唤醒记录${w.partial ? '（或超出可回溯范围）' : ''}</div>`;
    return;
  }
  $('#wk-hint').textContent = `${w.total} 条${w.partial ? ' · 尾读截断：早期记录可能不全' : ''} · wake.jsonl 只落元数据（审计红线本体）· 思维链点开行加载（wake-trace.jsonl）`;
  el.innerHTML = w.rows.map((r, i) => {
    const open = wkState.open.has(r.batchId ?? String(i));
    const pct = r.modelMs != null ? Math.min(100, (r.modelMs / 90000) * 100) : 0;
    const msCls = r.modelMs >= 90000 ? 'over' : (r.modelMs >= 60000 ? 'slow' : '');
    const u = r.usage ?? {};
    const uTotal = u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0));
    const dl = [
      ['batchId', r.batchId], ['排队等待', r.waitMs != null ? fmtMs(r.waitMs) : '—'],
      ['模型耗时', r.modelMs != null ? fmtMs(r.modelMs) : '—'],
      ['回复段数', r.lines ?? '—'],
      r.reason ? ['拦截原因', r.reason] : null,
      r.error ? ['错误', r.error] : null,
    ].filter(Boolean).map(([k, v]) => `<div class="dl"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    const gate = [
      ['inputTokens', u.inputTokens], ['outputTokens', u.outputTokens],
      ['totalTokens', u.totalTokens], ['cacheReadTokens', u.cacheReadTokens], ['reasoningTokens', r.usage ? (r.usage.reasoningTokens ?? 0) : null],
    ].map(([k, v]) => `<div class="gline"><span class="k">${k}</span><b>${v == null ? '—' : fmtNum(v)}</b></div>`).join('');
    return `<div class="wrow r-${r.result} ${open ? 'open' : ''}">
      <div class="wrow-head" data-i="${i}">
        <span class="wt">${fmtTime(r.ts)}</span>
        <span title="${esc(r.chat.full)}">${esc(r.chat.display)}</span>
        <span class="wcell-dim">${r.msgs}</span>
        <span class="ms-cell"><span class="ms"><i class="${msCls}" style="width:${pct}%"></i></span><span class="lbl">${r.modelMs != null ? fmtMs(r.modelMs) : '—'}</span></span>
        <span><span class="bdg ${r.result === 'skipped' ? 'skip' : r.result}">${RES_LABEL[r.result] ?? r.result}</span></span>
        <span class="wcell-dim">${r.lines ?? '—'}</span>
        <span class="wcell-dim">${r.usage ? fmtNum(uTotal) : '—'}</span>
        <span class="chev">▶</span>
      </div>
      <div class="wdetail"><div class="wdetail-inner">
        <div>
          <div class="detail-note">wake.jsonl 只落元数据（审计红线本体）；本批 ${r.msgs} 条消息的完整报文/思考/回复在 trace 旁路文件，展开即加载。${r.dropped ? ' · 本批已丢弃不重放' : ''}</div>
          ${dl || '<div class="detail-note">（无附加字段）</div>'}
        </div>
        <div class="gate"><div class="gline"><span class="k">usage</span><b>${r.usage ? '' : '（无）'}</b></div>${r.usage ? gate : ''}</div>
        <div class="wk-trace" data-batch="${esc(r.batchId ?? '')}"><div class="detail-note">思维链：尚未加载</div></div>
      </div></div>
    </div>`;
  }).join('');
}

async function renderWakes() {
  if (!wkState.date) {
    wkState.date = todayStr();
    $('#wk-date').value = wkState.date;
  }
  const qs = new URLSearchParams({ date: wkState.date });
  if (wkState.chat) qs.set('chat', wkState.chat);
  if (wkState.result) qs.set('result', wkState.result);
  const [j, s] = await Promise.all([
    api('/api/wakes?' + qs.toString()),
    api('/api/wakes/stats?date=' + wkState.date),
  ]);
  const w = j.data.wake, sw = s.data.wake;
  lastGood.wakes = { w, sw };
  $('#wk-sub').textContent = `按所选日期聚合 · ${wkState.date === todayStr() ? '今天（10s 轮询）' : '历史日期（静态）'} · ${wkState.date}`;
  renderWkStats(sw);
  renderWkList(w);
  // 会话筛选下拉同步（保留当前选择）
  if (w.state === 'ready' && Array.isArray(w.chats)) {
    const sel = $('#wk-chat');
    const cur = wkState.chat;
    sel.innerHTML = '<option value="">全部会话</option>' + w.chats.map((c) => `<option value="${esc(c.full)}" ${c.full === cur ? 'selected' : ''}>${esc(c.display)}</option>`).join('');
  }
}

// 列表事件：行点击展开/收起（事件委托）
$('#wk-list').addEventListener('click', (e) => {
  const head = e.target.closest('.wrow-head');
  if (!head) return;
  const row = head.parentElement;
  // 用行首字段做开合键（batchId 优先，退回索引）
  const rows = (lastGood.wakes?.w?.rows) ?? [];
  const r = rows[Number(head.dataset.i)];
  const k = r?.batchId ?? head.dataset.i;
  if (wkState.open.has(k)) wkState.open.delete(k); else wkState.open.add(k);
  row.classList.toggle('open');
  // 展开时按需加载思维链（一次缓存，收起再开不重复请求）
  if (row.classList.contains('open') && r?.batchId) loadWkTrace(row.querySelector('.wk-trace'), r.batchId);
});

// ── 思维链 trace（2026-11-22 施法事故后加）：▶ 展开时按需拉取，不进轮询 ──
function renderTrace(t) {
  if (!t || (!t.prompt && !t.reply && !t.thinking)) {
    return '<div class="detail-note">无 trace 内容——此记录早于 trace 功能（2026-11-22 上线）。</div>';
  }
  const att = Array.isArray(t.attachments) && t.attachments.length ? `<div class="detail-note">附件：${esc(t.attachments.join('、'))}</div>` : '';
  return `
    ${t.thinking ? `<details class="wk-tr-sec"><summary>🧠 思考过程</summary><pre>${esc(t.thinking)}</pre></details>` : '<div class="detail-note">🧠 思考过程：无（该批未吐思考帧）</div>'}
    ${t.reply ? `<div class="wk-tr-sec"><b>💬 回复</b><pre>${esc(t.reply)}</pre></div>` : ''}
    ${t.prompt ? `<details class="wk-tr-sec"><summary>📥 收到报文</summary>${att}<pre>${esc(t.prompt)}</pre></details>` : ''}`;
}

async function loadWkTrace(el, batchId) {
  if (!el || el.dataset.loaded === '1' || !batchId) return;
  el.dataset.loaded = '1';
  try {
    const j = await api('/api/wakes/trace?batchId=' + encodeURIComponent(batchId));
    const d = j.data ?? {};
    el.innerHTML = d.state === 'ready'
      ? renderTrace(d.trace)
      : `<div class="detail-note">trace ${d.state === 'not_enabled' ? '文件尚未生成（功能上线后第一条唤醒起才有）' : d.state === 'not_found' ? '未找到该批次（早于功能上线或超出尾读范围）' : '读取失败：' + esc(d.error ?? d.state)}</div>`;
  } catch (err) {
    el.dataset.loaded = ''; // 失败允许重试
    el.innerHTML = `<div class="detail-note">trace 加载失败：${esc(err.message)}</div>`;
  }
}
$('#wk-date').addEventListener('change', (e) => { wkState.date = e.target.value || todayStr(); wkState.open.clear(); startWakesPolling(); renderWakes(); });
$('#wk-chat').addEventListener('change', (e) => { wkState.chat = e.target.value; wkState.open.clear(); renderWakes(); });
$('#wk-result').addEventListener('change', (e) => { wkState.result = e.target.value; wkState.open.clear(); renderWakes(); });
$('#wk-refresh').addEventListener('click', () => { renderWakes(); toast('已刷新'); });

// ── 审阅页（G5）：候选裁决 · 只批不编 + 删除提案闭环（G5b：批准=执行删除，驳回=撤销提案）──
const rvSel = { memory: new Set(), vocab: new Set(), roster: new Set() };
const rvSelRm = { memory: new Set(), vocab: new Set(), roster: new Set() }; // 删除提案按 rid 选中（与普通 id 空间分开）
const RV_LABEL = { memory: '记忆', vocab: '行话', roster: '名册' };

function rvRemoveCard(q) {
  const sel = rvSelRm[q.kind].has(q.rid);
  return `<div class="rcard remove ${sel ? 'sel' : ''}" data-kind="${q.kind}" data-rid="${esc(q.rid)}">
    <span class="rc-tag del">删除提案</span><span class="rc-tag">${RV_LABEL[q.kind] ?? q.kind}</span><span class="rc-tag">${esc((q.ts || '').slice(0, 10))}</span>
    <div class="rc-text">${esc(q.text)}</div>
    ${q.reason ? `<div class="rc-src">理由：${esc(q.reason)}</div>` : ''}
  </div>`;
}

function rvCard(kind, it) {
  const sel = rvSel[kind].has(it.id);
  if (kind === 'memory') {
    return `<div class="rcard ${sel ? 'sel' : ''}" data-kind="memory" data-id="${esc(it.id)}">
      <span class="rc-tag">${esc(it.date)}</span><span class="rc-tag">候选</span>
      <div class="rc-text">${esc(it.text)}</div>
    </div>`;
  }
  if (kind === 'roster') {
    // 名册候选：id=uid 不渲染进 UI 文本（QQ 号只存在于 data-id 属性供选中传输）
    const act = { high: '常在', mid: '偶尔在', low: '少来' };
    return `<div class="rcard ${sel ? 'sel' : ''}" data-kind="roster" data-id="${esc(it.id)}">
      <span class="rc-tag">${esc(it.nick ?? '(无名)')}</span><span class="rc-tag">${act[it.activity] ?? it.activity ?? '?'}</span><span class="rc-tag">首见 ${esc(it.firstSeen ?? '?')}</span>
      <div class="rc-text">${esc(it.note ?? '(无备注)')}</div>
      ${it.source ? `<div class="rc-src">来源群 ${esc(it.source)}</div>` : ''}
    </div>`;
  }
  return `<div class="rcard ${sel ? 'sel' : ''}" data-kind="vocab" data-id="${esc(it.id)}">
    <span class="rc-tag">${esc(it.id)}</span><span class="rc-tag">热度 ${it.seenCount ?? 0}</span><span class="rc-tag">首见 ${esc(it.firstSeen ?? '?')}</span>
    <div class="rc-text">${esc(it.meaning ?? '(无释义)')}${it.usage ? ' · ' + esc(it.usage) : ''}</div>
    ${(it.examples || []).length ? `<div class="rc-src">例：${esc((it.examples || []).join(' / ').slice(0, 100))}</div>` : ''}
  </div>`;
}

async function loadReview() {
  const [m, v, r] = await Promise.all([api('/api/review/memory'), api('/api/review/vocab'), api('/api/review/roster')]);
  const md = m.data, vd = v.data, rd = r.data;
  lastGood.review = { md, vd, rd };
  const mItems = md.items ?? [], vItems = vd.candidates ?? [];
  const mRm = md.removes ?? [], vRm = vd.removes ?? [];
  $('#rv-m-cnt').textContent = (mItems.length + mRm.length)
    ? `${mItems.length} 条待审${mRm.length ? ` + ${mRm.length} 条删除提案` : ''} · core ${md.core ? `${md.core.entries} 条/${md.core.lines} 行（红线 ${md.core.maxLines}）` : '—'}`
    : '没有待审';
  $('#rv-v-cnt').textContent = (vItems.length + vRm.length)
    ? `${vItems.length} 条待审${vRm.length ? ` + ${vRm.length} 条下架提案` : ''} · confirmed ${vd.confirmed ? `${vd.confirmed.count}/${vd.confirmed.max}` : '—'}`
    : '没有待审';
  $('#rv-memory').innerHTML = (mRm.length ? mRm.map(rvRemoveCard).join('') : '')
    + (mItems.length ? mItems.map((it) => rvCard('memory', it)).join('')
      : (mRm.length ? '' : '<div class="na-box"><div class="t">没有记忆候选</div><div class="d">学习任务攒出候选后出现在这里等审批。</div></div>'));
  $('#rv-vocab').innerHTML = (vRm.length ? vRm.map(rvRemoveCard).join('') : '')
    + (vItems.length ? vItems.map((it) => rvCard('vocab', it)).join('')
      : (vRm.length ? '' : '<div class="na-box"><div class="t">没有行话候选</div><div class="d">等学习任务从群聊里攒出新词。</div></div>'));
  const rItems = rd.candidates ?? [], rRm = rd.removes ?? [];
  $('#rv-r-cnt').textContent = (rItems.length + rRm.length)
    ? `${rItems.length} 条待审${rRm.length ? ` + ${rRm.length} 条下架提案` : ''} · confirmed ${rd.confirmed ? rd.confirmed.count : '—'}`
    : '没有待审';
  $('#rv-roster').innerHTML = (rRm.length ? rRm.map(rvRemoveCard).join('') : '')
    + (rItems.length ? rItems.map((it) => rvCard('roster', it)).join('')
      : (rRm.length ? '' : `<div class="na-box"><div class="t">没有名册候选</div><div class="d">学习任务攒出新面孔后出现在这里；转正后她开口就能认人。</div></div>`));
  rvSel.memory.clear(); rvSel.vocab.clear(); rvSel.roster.clear();
  rvSelRm.memory.clear(); rvSelRm.vocab.clear(); rvSelRm.roster.clear();
  rvUpdateBar();
}

function rvUpdateBar() {
  const m = rvSel.memory.size + rvSelRm.memory.size, v = rvSel.vocab.size + rvSelRm.vocab.size, r = rvSel.roster.size + rvSelRm.roster.size;
  const rm = rvSelRm.memory.size + rvSelRm.vocab.size + rvSelRm.roster.size;
  const total = m + v + r;
  $('#rv-sel').innerHTML = (total === 0) ? '点击卡片选择（可跨三栏混合提交）'
    : `已选 <b>${total}</b> 条（记忆 ${m} · 行话 ${v} · 名册 ${r}${rm ? `，其中删除提案 ${rm}` : ''}）`;
  $('#rv-approve').disabled = $('#rv-reject').disabled = (total === 0);
}

function rvToggle(c) {
  if (c.dataset.rid) {
    const kind = c.dataset.kind, rid = c.dataset.rid;
    if (rvSelRm[kind].has(rid)) { rvSelRm[kind].delete(rid); c.classList.remove('sel'); }
    else { rvSelRm[kind].add(rid); c.classList.add('sel'); }
  } else {
    const kind = c.dataset.kind, id = c.dataset.id;
    if (rvSel[kind].has(id)) { rvSel[kind].delete(id); c.classList.remove('sel'); }
    else { rvSel[kind].add(id); c.classList.add('sel'); }
  }
  rvUpdateBar();
}

async function submitReview(action) {
  const kinds = [
    ['memory', rvSel.memory, rvSelRm.memory],
    ['vocab', rvSel.vocab, rvSelRm.vocab],
    ['roster', rvSel.roster, rvSelRm.roster],
  ].filter(([, s, srm]) => s.size || srm.size);
  if (!kinds.length) return;
  const total = kinds.reduce((a, [, s, srm]) => a + s.size + srm.size, 0);
  const label = action === 'approve' ? '批准' : '驳回';
  const detail = action === 'approve'
    ? '批准 = 立即生效（候选迁入/转正，删除提案执行删除，自动备份）'
    : '驳回 = 候选从待审区删除；删除提案撤销（什么都不动）';
  if (!confirm(`确定${label}选中的 ${total} 条？\n${detail}`)) return;
  const parts = [];
  const errs = [];
  for (const [kind, sel, selRm] of kinds) {
    try {
      const t = await api('/api/review/token?kind=' + kind);
      const r = await api('/api/review/decision', {
        method: 'POST',
        body: {
          kind, token: t.data.token,
          items: [...sel].map((id) => ({ id, action })),
          removes: [...selRm].map((rid) => ({ rid, action })),
        },
      });
      parts.push({ kind, ...r.data });
    } catch (e) {
      errs.push(`${RV_LABEL[kind] ?? kind}：${e.message}`);
    }
  }
  const box = $('#rv-result');
  box.classList.remove('hidden');
  box.innerHTML = `<b>${label}完成</b><br>` + parts.map((r) => {
    const all = [...(r.results ?? []), ...(r.removeResults ?? [])];
    const okN = all.filter((x) => x.ok).length, failN = all.length - okN;
    const bk = r.backup ? (typeof r.backup === 'string' ? r.backup : Object.values(r.backup).filter(Boolean).join('，')) : null;
    return `${RV_LABEL[r.kind] ?? r.kind}：成功 ${okN}${failN ? ` · 失败 ${failN}` : ''}${bk ? ` · 备份 <code>${esc(bk)}</code>` : ''}`
      + all.filter((x) => !x.ok).map((x) => `<br><span class="fail">✗ ${esc(String(x.id ?? x.rid ?? '').slice(0, 12))}：${esc(x.error)}</span>`).join('');
  }).join('<br>') + errs.map((e) => `<br><span class="fail">✗ ${esc(e)}</span>`).join('');
  loadReview().catch(() => {});
}

$('#rv-memory').addEventListener('click', (e) => { const c = e.target.closest('.rcard'); if (c) rvToggle(c); });
$('#rv-vocab').addEventListener('click', (e) => { const c = e.target.closest('.rcard'); if (c) rvToggle(c); });
$('#rv-roster').addEventListener('click', (e) => { const c = e.target.closest('.rcard'); if (c) rvToggle(c); });
$('#rv-approve').addEventListener('click', () => submitReview('approve').catch((e) => toast('批准失败：' + e.message)));
$('#rv-reject').addEventListener('click', () => submitReview('reject').catch((e) => toast('驳回失败：' + e.message)));
$('#rv-refresh').addEventListener('click', () => { loadReview().then(() => toast('已刷新')).catch((e) => toast(e.message)); });

// ── 记忆与行话页（G5）：已生效条目只读 + 搜索 + 疑似重复标黄 + 删除提案 ──
const memState = { tab: 'memory', search: '' };

async function loadMemoryPage() {
  if (memState.tab === 'memory') {
    const r = await api('/api/memory');
    const m = r.data.memory;
    lastGood.memMemory = m;
    if (m.state !== 'ready') {
      $('#mem-strip').innerHTML = '';
      $('#mem-sub').textContent = 'core.md 尚未启用或读取失败';
      $('#mem-list').innerHTML = `<div class="wempty"><div class="na-box"><div class="t">${m.state === 'degraded' ? 'core.md 读取失败' : '她还没形成长期记忆'}</div><div class="d">${esc(m.error ?? '记忆由人工审批积累，不是错误。')}</div></div></div>`;
      return;
    }
    $('#mem-sub').textContent = `已生效 ${m.entries.length} 条 / ${m.usedLines} 行（红线 ${m.maxLines}，超线尾部鱼读不到）${m.pendingProposals ? ` · 删除提案 ${m.pendingProposals} 条待处理` : ''}`;
    $('#mem-strip').innerHTML = `记忆 <b>${m.entries.length}</b> 条 · 疑似重复 <b class="${m.dupIds.length ? 'warn' : ''}">${m.dupIds.length}</b> · 提案待处理 <b>${m.pendingProposals}</b>`;
    const kw = memState.search;
    const rows = m.entries.filter((e) => !kw || e.text.includes(kw) || (e.source || '').includes(kw) || e.date.includes(kw));
    $('#mem-list').innerHTML = rows.map((e) => {
      const dup = m.dupIds.includes(e.id);
      return `<div class="mem-item ${dup ? 'dup' : ''}">
        <div>
          <div class="mi-text">${esc(e.text)}</div>
          <div class="mi-meta"><span>${esc(e.date)}</span>${e.source ? `<span>来源：${esc(e.source)}</span>` : '<span>来源未知</span>'}</div>
          ${dup ? '<div class="mi-dup">疑似与另一条重复（内容互相包含）——考虑删除其一</div>' : ''}
        </div>
        <button class="mi-more" data-kind="memory" data-id="${esc(e.id)}" title="申请删除（进提案，人工执行）">···</button>
      </div>`;
    }).join('') || '<div class="wempty">没有匹配的条目</div>';
  } else if (memState.tab === 'roster') {
    // 名册生效态（2026-11-28 对齐闸门模式）：confirmed 列表 + 下架提案入口
    const r = await api('/api/review/roster');
    const rd = r.data;
    lastGood.memRoster = rd;
    const conf = rd.confirmed ?? { count: 0, items: [] };
    $('#mem-sub').textContent = `名册已转正 ${conf.count} 条（每群注入上限 8 人；candidate 去审阅页批）`;
    $('#mem-strip').innerHTML = `名册 confirmed <b>${conf.count}</b> 条 · 来源群可在条目上看`;
    const kw = memState.search;
    const rows = (conf.items || []).filter((e) => !kw || ((e.nick ?? '') + (e.note ?? '') + (e.source ?? '')).includes(kw));
    $('#mem-list').innerHTML = rows.map((e) => `<div class="mem-item">
      <div>
        <div class="mi-text"><b>${esc(e.nick ?? '(无名)')}</b> — ${esc(e.note ?? '(无备注)')}</div>
        <div class="mi-meta"><span>${{ high: '常在', mid: '偶尔在', low: '少来' }[e.activity] ?? e.activity ?? '?'}</span>${e.firstSeen ? `<span>首见 ${esc(e.firstSeen)}</span>` : ''}${e.source ? `<span>来源群 ${esc(e.source)}</span>` : ''}</div>
      </div>
      <button class="mi-more" data-kind="roster" data-id="${esc(e.id)}" title="申请下架（进提案，人工执行）">···</button>
    </div>`).join('') || '<div class="wempty">名册还没有已转正条目</div>';
  } else {
    const r = await api('/api/vocab-effective');
    const v = r.data.vocab;
    lastGood.memVocab = v;
    $('#mem-sub').textContent = `已上线 ${v.confirmed.count}/${v.confirmed.max} 条（超员尾部鱼读不到）`;
    $('#mem-strip').innerHTML = `行话 confirmed <b>${v.confirmed.count}</b>/${v.confirmed.max} · 来源群可在条目上看`;
    const kw = memState.search;
    const rows = (v.confirmed.items || []).filter((e) => !kw || (e.id + (e.meaning ?? '') + (e.usage ?? '')).includes(kw));
    $('#mem-list').innerHTML = rows.map((e) => `<div class="mem-item">
      <div>
        <div class="mi-text"><b>${esc(e.id)}</b> — ${esc(e.meaning ?? '(无释义)')}${e.usage ? ' · ' + esc(e.usage) : ''}</div>
        <div class="mi-meta"><span>热度 ${e.seenCount ?? 0}</span>${e.firstSeen ? `<span>首见 ${esc(e.firstSeen)}</span>` : ''}${e.source ? `<span>来源群 ${esc(e.source)}</span>` : ''}</div>
      </div>
      <button class="mi-more" data-kind="vocab" data-id="${esc(e.id)}" title="申请下架（进提案，人工执行）">···</button>
    </div>`).join('') || '<div class="wempty">没有匹配的条目</div>';
  }
}

$('#mem-list').addEventListener('click', async (e) => {
  if (!e.target.matches('.mi-more')) return;
  const kind = e.target.dataset.kind, id = e.target.dataset.id;
  const verb = kind === 'memory' ? '删除这条记忆' : kind === 'roster' ? '下架这个名册条目' : '下架这个词';
  if (!confirm(`确定为「${id.slice(0, 16)}」申请${verb}吗？\n提案会进入审阅页，你在那里批准后才真删（驳回则什么都不动）。`)) return;
  const reason = prompt('理由（可选，会显示在提案卡片上）：') ?? '';
  try {
    const r = await api('/api/review/propose-remove', { method: 'POST', body: { kind, id, reason } });
    const d = r.data;
    toast(d.recorded ? '已加入审阅队列——去审阅页批准后生效' : ('未入队：' + (d.reason ?? '')));
    loadMemoryPage().catch(() => {});
  } catch (err) {
    toast('提案失败：' + err.message);
  }
});

$('#mem-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  memState.tab = b.dataset.k;
  [...$('#mem-seg').children].forEach((x) => x.classList.toggle('on', x === b));
  loadMemoryPage().catch((e2) => toast(e2.message));
});
$('#mem-search').addEventListener('input', (e) => {
  memState.search = e.target.value.trim();
  // 前端本地过滤（数据已在手），不打服务端
  loadMemoryPage().catch(() => {});
});
$('#mem-refresh').addEventListener('click', () => { loadMemoryPage().then(() => toast('已刷新')).catch((e) => toast(e.message)); });

// ── 配置页（G6）：五组表单 + 两段式（PATCH 预览 → 30s applyToken → 落盘备份）──
const GROUPS = ['白名单与人格', '说多少（限额）', '什么时候醒（作息）', '脑子（模型）', '卫生与门禁'];
const FIELD_DEFS = [
  { path: 'allow.groups', label: '群白名单', type: 'qq-list', group: 0, hint: '每行一个群号（5~12 位数字）' },
  { path: 'allow.private', label: '私聊白名单', type: 'qq-list', group: 0, hint: '每行一个 QQ 号，名单外私聊不回' },
  { path: 'ownerQQ', label: '主人 QQ', type: 'string', group: 0 },
  { path: 'botName', label: '她叫什么', type: 'string', group: 0 },
  { path: 'identity.names', label: '她的名字（多档触发）', type: 'str-list', group: 0, hint: '每行一个，长名优先匹配' },
  { path: 'identity.blockPhrases', label: '屏蔽短语（不算叫她）', type: 'str-list', group: 0, hint: '每行一个，如「伊丽莎白女王」' },
  { path: 'patrol.maxDailyWakes', label: '思考额度', type: 'int', unit: '次/天', group: 1, hint: '一批消息送模型看一眼算一次' },
  { path: 'private.maxPerDay', label: '私聊额度', type: 'int', unit: '次/天', group: 1, hint: '独立钱包，与全局各查一遍' },
  { path: 'limits.maxDailyTotal', label: '说话额度', type: 'int', unit: '条/天', group: 1 },
  { path: 'limits.maxRepliesPerMessage', label: '每条消息最多回几条', type: 'int', group: 1 },
  { path: 'limits.maxProactivePerGroupPerMinute', label: '每群每分钟主动上限', type: 'int', group: 1 },
  { path: 'limits.maxRepliesPerGroupPer5Min', label: '每群 5 分钟上限', type: 'int', group: 1 },
  { path: 'limits.maxSegments', label: '单次最多分段', type: 'int', group: 1 },
  { path: 'limits.busyMaxSegments', label: '热闹时分段上限', type: 'int', group: 1 },
  { path: 'limits.maxTotalChars', label: '单次总字数', type: 'int', group: 1 },
  { path: 'patrol.silentHours.start', label: '静默开始', type: 'hhmm', group: 2 },
  { path: 'patrol.silentHours.end', label: '静默结束', type: 'hhmm', group: 2, hint: '群里零唤醒；私聊不受限' },
  { path: 'patrol.minWakeIntervalMs', label: '同群最小间隔', type: 'int', unit: 'ms', group: 2, hint: '@她（必回）豁免此间隔' },
  { path: 'patrol.batchWindowMs', label: '攒批窗口', type: 'int', unit: 'ms', group: 2, hint: '闲聊攒几秒一起回' },
  { path: 'patrol.mustWindowMs', label: '必回短窗', type: 'int', unit: 'ms', group: 2, hint: '@她后多少毫秒内必回' },
  { path: 'patrol.maxBufferPerPeer', label: '每群缓冲上限', type: 'int', unit: '条', group: 2 },
  { path: 'maintenance.pruneAfterMin', label: '清会话窗口', type: 'int', unit: '分钟', group: 2 },
  { path: 'maintenance.activeGraceMin', label: '活跃保护', type: 'int', unit: '分钟', group: 2, hint: '最近有活动的会话不清理' },
  { path: 'patrol.wakeTimeoutMs', label: '唤醒超时', type: 'int', unit: 'ms', group: 2, hint: '单次思考的耐心上限，超时算一次空过' },
  { path: 'patrol.model.providerId', label: '聊天·供应商', type: 'provider', trio: 'chat', trioLabel: '聊天模型', group: 3 },
  { path: 'patrol.model.modelId', label: '聊天·模型', type: 'model', provPath: 'patrol.model.providerId', trio: 'chat', group: 3 },
  { path: 'patrol.model.reasoningLevel', label: '聊天·档位', type: 'enum', values: ['low', 'medium', 'high'], trio: 'chat', group: 3, hint: 'GLM-5.3 系列必选，low 快且便宜' },
  { path: 'tasks.learnModel.providerId', label: '学习·供应商', type: 'provider', trio: 'learn', trioLabel: '学习任务模型', group: 3, hint: '「立即学习」按钮用；不配走默认 GLM-5.3-Flash/low' },
  { path: 'tasks.learnModel.modelId', label: '学习·模型', type: 'model', provPath: 'tasks.learnModel.providerId', trio: 'learn', group: 3 },
  { path: 'tasks.learnModel.reasoningLevel', label: '学习·档位', type: 'enum', values: ['low', 'medium', 'high'], trio: 'learn', group: 3 },
  { path: 'tasks.diaryModel.providerId', label: '日记·供应商', type: 'provider', trio: 'diary', trioLabel: '日记任务模型', group: 3, hint: '「写今日日记」按钮用；不配走默认 GLM-5.3-Flash/low' },
  { path: 'tasks.diaryModel.modelId', label: '日记·模型', type: 'model', provPath: 'tasks.diaryModel.providerId', trio: 'diary', group: 3 },
  { path: 'tasks.diaryModel.reasoningLevel', label: '日记·档位', type: 'enum', values: ['low', 'medium', 'high'], trio: 'diary', group: 3 },
  { path: 'tasks.selfCheckModel.providerId', label: '自检·供应商', type: 'provider', trio: 'selfcheck', trioLabel: '自检模型', group: 3, hint: '每小时工具面自检用；不配跟随聊天模型，改完下个自检周期生效（无需重启）' },
  { path: 'tasks.selfCheckModel.modelId', label: '自检·模型', type: 'model', provPath: 'tasks.selfCheckModel.providerId', trio: 'selfcheck', group: 3 },
  { path: 'tasks.selfCheckModel.reasoningLevel', label: '自检·档位', type: 'enum', values: ['low', 'medium', 'high'], trio: 'selfcheck', group: 3 },
  { path: 'bannedWords', label: '禁词', type: 'str-list', group: 4, hint: '每行一个，命中整条丢弃并审计' },
  { path: 'audit.blockPrivateIP', label: '拦内网 IP', type: 'bool', group: 4, hint: '误伤率高（聊路由器会中招），默认关' },
  { path: 'onebot.accessToken', label: 'NapCat 令牌', type: 'secret', group: 4, hint: '显示 **** 时保持原样即不改' },
];

const cfgState = { baseVersion: null, original: null, pending: null, models: [] }; // pending = PATCH 预览返回；models = /api/models
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// provider/model 联动下拉的 options（列表拉不到时回退手填）
function providerOptions(cur) {
  const list = cfgState.models;
  if (!list.length) return null;
  // 订阅型（account:）条目：ZCode 无头会话运行时不装载账号型 provider（实测 modelUnavailable），置灰留位——
  // 未来 ZCode 无头支持后 option 恢复可选即自动可用
  const label = (p) => p.plan ? `${esc(p.name)} · 订阅🎫（无头会话暂不可用）` : `${esc(p.name)}（${esc(p.providerId)}）`;
  const opts = list.map((p) => `<option value="${esc(p.providerId)}" ${p.providerId === cur ? 'selected' : ''} ${p.plan ? 'disabled' : ''}>${label(p)}</option>`).join('');
  return cur && !list.some((p) => p.providerId === cur)
    ? `<option value="${esc(cur)}" selected>${esc(cur)}（当前值，不在列表）</option>` + opts
    : `<option value="">（选择供应商）</option>` + opts;
}
function modelOptions(cur, provIdOverride, provPath) {
  // 联动源优先级：显式传入 > DOM 里同 provPath 的供应商下拉（用户刚换、config 未落的场景）
  const pp = provPath ?? 'patrol.model.providerId';
  const provId = provIdOverride ?? document.querySelector(`[data-path="${CSS.escape(pp)}"]`)?.value ?? '';
  const p = cfgState.models.find((x) => x.providerId === provId);
  const models = p ? p.models : [];
  if (!cfgState.models.length) return null;
  const opts = models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('');
  return cur && !models.includes(cur)
    ? `<option value="${esc(cur)}" selected>${esc(cur)}（当前值，不在该供应商列表）</option>` + opts
    : opts;
}

function fieldInput(def, val, providerId) {
  const v = val == null ? '' : val;
  const name = `data-path="${esc(def.path)}"`;
  if (def.type === 'bool') {
    return `<div class="bool-row"><input type="checkbox" ${name} ${v === true ? 'checked' : ''}><span>${v === true ? '开' : '关'}</span></div>`;
  }
  if (def.type === 'enum') {
    return `<select ${name}>${def.values.map((x) => `<option value="${x}" ${x === v ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  }
  if (def.type === 'provider') {
    const opts = providerOptions(v);
    return opts == null ? `<input type="text" ${name} value="${esc(v ?? '')}">` : `<select ${name}>${opts}</select>`;
  }
  if (def.type === 'model') {
    const opts = modelOptions(v, providerId, def.provPath);
    return opts == null ? `<input type="text" ${name} value="${esc(v ?? '')}">` : `<select ${name}>${opts}</select>`;
  }
  if (def.type === 'qq-list' || def.type === 'str-list') {
    return `<textarea ${name} placeholder="${esc(def.hint ?? '')}">${esc(Array.isArray(v) ? v.join('\n') : v)}</textarea>`;
  }
  if (def.type === 'secret') {
    return `<input type="text" ${name} value="${esc(v || '****')}" autocomplete="off">`;
  }
  if (def.type === 'hhmm') {
    return `<input type="text" ${name} value="${esc(v)}" placeholder="HH:MM">`;
  }
  return `<input type="${def.type === 'int' ? 'number' : 'text'}" ${name} value="${esc(v)}">`;
}

async function loadConfig(reload) {
  const [r, m] = await Promise.all([
    api('/api/config'),
    api('/api/models').catch(() => ({ data: { providers: [] } })), // 拉不到列表 → 手填回退
  ]);
  cfgState.models = m.data.providers ?? [];
  const d = r.data;
  cfgState.baseVersion = d.baseVersion;
  cfgState.original = d.config;
  cfgState.pending = null;
  const byGroup = GROUPS.map((_, gi) => FIELD_DEFS.filter((f) => f.group === gi));
  // 渲染：trio 标记的字段聚合成一行三下拉（供应商/模型/档位），其余一字段一行
  const renderRow = (fields, cfg) => {
    if (fields[0].trio) {
      const head = fields.find((x) => x.trioLabel) ?? fields[0];
      return `<div class="frow" data-row="${esc(fields[0].path)}">
        <div class="flabel">${esc(head.trioLabel ?? fields[0].label)}${head.hint ? `<small>${esc(head.hint)}</small>` : ''}</div>
        <div class="trio">${fields.map((f) => `<div class="trio-cell" title="${esc(f.label)}">${fieldInput(f, getPath(cfg, f.path), f.provPath ? getPath(cfg, f.provPath) : getPath(cfg, 'patrol.model.providerId'))}</div>`).join('')}</div>
      </div>`;
    }
    const f = fields[0];
    return `<div class="frow" data-row="${esc(f.path)}">
      <div class="flabel">${f.label}${f.unit ? ` <span class="unit">(${f.unit})</span>` : ''}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</div>
      <div>${fieldInput(f, getPath(cfg, f.path), f.provPath ? getPath(cfg, f.provPath) : getPath(cfg, 'patrol.model.providerId'))}</div>
    </div>`;
  };
  $('#cfg-forms').innerHTML = GROUPS.map((g, gi) => {
    const rows = [];
    for (const f of byGroup[gi]) {
      if (f.trio) { // trio 组头（首个成员）整行渲染，其余成员跳过
        if (!rows.some((r) => r[0].trio === f.trio)) rows.push(byGroup[gi].filter((x) => x.trio === f.trio));
        continue;
      }
      rows.push([f]);
    }
    return `<div class="cfg-card">
      <div class="card-head"><h2>${g}</h2></div>
      ${gi === 3 ? `<div style="padding:8px 14px 0;font-size:10.5px;color:#54656e;line-height:1.6">下拉里带「订阅🎫」的条目（Start Plan 等）已列出但置灰：ZCode 的无头任务/巡逻会话暂不装载账号型订阅模型（2026-11-21 实测 modelUnavailable，刷新 registry 与 --surface desktop 均无效）——官方开放后置灰自动解除。当前请从按量条目选择。</div>` : ''}
      <div class="cfg-body">${rows.map((r) => renderRow(r, d.config)).join('')}</div>
    </div>`;
  }).join('');
  $('#cfg-sub').textContent = `两段式：改表单 → 预览 diff → 30 秒内确认应用（自动备份 10 份）· 基线 ${d.baseVersion.slice(-8)}`;
  if (reload) toast('已重载（未应用的修改已丢弃）');
}

// 收集与原值不同的字段 → patch
function collectPatch() {
  const patch = {};
  let dirty = 0;
  for (const f of FIELD_DEFS) {
    const el = document.querySelector(`[data-path="${CSS.escape(f.path)}"]`);
    if (!el) continue;
    let v;
    if (f.type === 'bool') v = el.checked;
    else if (f.type === 'qq-list') v = el.value.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean);
    else if (f.type === 'str-list') v = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
    else if (f.type === 'int') {
      if (el.value.trim() === '') continue; // 空输入不进 patch——未显式配置的字段保持用默认值（Number('')=0 会误判）
      v = Number(el.value);
    }
    else v = el.value;
    const old = getPath(cfgState.original, f.path);
    const changed = JSON.stringify(old ?? (f.type === 'qq-list' || f.type === 'str-list' ? [] : '')) !== JSON.stringify(v);
    // 从输入元素向上找所属行（trio 聚合行没有独立 data-row，closest 通用）
    el.closest('.frow')?.classList.toggle('dirty', changed);
    if (changed) { patch[f.path] = v; dirty++; }
  }
  return { patch, dirty };
}

async function previewConfig() {
  const { patch, dirty } = collectPatch();
  if (!dirty) { toast('没有修改任何字段'); return; }
  try {
    const r = await api('/api/config', { method: 'PATCH', body: { patch, baseVersion: cfgState.baseVersion } });
    cfgState.pending = { ...r.data, patch };
    renderDiffModal(r.data);
  } catch (e) {
    toast('预览失败：' + e.message);
  }
}

function renderDiffModal(d) {
  $('#cfg-diff').innerHTML = d.diff.map((x) => `<div class="diff-row">
    <div class="dp">${esc(x.path)}</div>
    <div class="from">${esc(JSON.stringify(x.from) ?? '')}</div><div class="arrow">→</div><div class="to">${esc(JSON.stringify(x.to) ?? '')}</div>
  </div>`).join('');
  $('#cfg-warnings').innerHTML = (d.warnings || []).length
    ? `<div class="warn-list">${d.warnings.map((w) => `<div class="w">⚠ ${esc(w)}</div>`).join('')}</div>` : '';
  $('#cfg-modal').classList.remove('hidden');
  const t0 = Date.now();
  const tick = setInterval(() => {
    const left = Math.max(0, d.expiresAt - Date.now());
    $('#cfg-countdown').textContent = `令牌剩余 ${Math.ceil(left / 1000)} 秒（过期需重新预览）`;
    if (left <= 0) { clearInterval(tick); closeCfgModal(); toast('令牌已过期，请重新预览'); }
  }, 500);
  cfgState._tick = tick;
}
function closeCfgModal() {
  $('#cfg-modal').classList.add('hidden');
  clearInterval(cfgState._tick);
}

async function applyConfig() {
  if (!cfgState.pending) return;
  try {
    const r = await api('/api/config/apply', { method: 'POST', body: { applyToken: cfgState.pending.applyToken, patchHash: cfgState.pending.patchHash } });
    closeCfgModal();
    const b = $('#cfg-banner');
    b.classList.remove('hidden', 'err');
    b.innerHTML = `<b>已写入</b>（备份 ${esc(r.data.backupId)}）——配置是启动时读一次的快照，<b>重启适配器后生效</b>。
      <button class="btn sm" id="cfg-restart" style="margin-left:10px">现在重启适配器</button>`;
    document.querySelector('#cfg-restart').addEventListener('click', () => doRestart());
    await loadConfig();
  } catch (e) {
    toast('应用失败：' + e.message);
  }
}

async function doRestart() {
  toast('正在重启适配器…');
  try {
    const r = await api('/api/actions/restart', { method: 'POST', body: { confirm: 'RESTART' }, timeoutMs: 30_000 });
    if (r.data.ok) { toast(`适配器已重启（pid=${r.data.pid}，${r.data.ms}ms 就绪）`); renderHealth(); }
    else toast('重启失败：停在 ' + (r.data.stage ?? '?') + '，看 fish-adapter/logs/adapter.log');
  } catch (e) { toast('重启失败：' + e.message); }
}

$('#cfg-preview').addEventListener('click', previewConfig);
$('#cfg-apply').addEventListener('click', applyConfig);
$('#cfg-cancel').addEventListener('click', closeCfgModal);
$('#cfg-modal-x').addEventListener('click', closeCfgModal);
$('#cfg-reload').addEventListener('click', () => loadConfig(true).catch((e) => toast(e.message)));
// 表单输入即时脏标记 + provider→model 联动（select 的变化走 change 不走 input）
$('#cfg-forms').addEventListener('input', () => collectPatch());
$('#cfg-forms').addEventListener('change', (e) => {
  const changed = e.target.dataset?.path;
  // 任意供应商下拉变化 → 联动刷新以它为 provPath 的模型下拉（G9 起三组模型各自独立联动）
  for (const f of FIELD_DEFS) {
    if (f.type !== 'model' || f.provPath !== changed) continue;
    const sel = document.querySelector(`[data-path="${CSS.escape(f.path)}"]`);
    if (sel && sel.tagName === 'SELECT') {
      const cur = cfgState.original ? getPath(cfgState.original, f.path) : '';
      sel.innerHTML = modelOptions(cur, undefined, f.provPath) ?? '';
    }
  }
  collectPatch();
});

// ── 顶栏上下线开关（G6/A11）：预检 → 确认模态 → spawn ps1 全家桶 ──
let modeBusy = false;
function renderModeSwitch(online) {
  const sw = $('#modeSwitch');
  sw.className = 'mode-switch ' + (online ? 'on' : 'off') + (modeBusy ? ' busy' : '');
  $('#modeLabel').textContent = modeBusy ? '执行中…' : (online ? '秒回 · 已上线' : '已下线');
  sw.dataset.online = online ? '1' : '';
}

async function openModeModal() {
  if (modeBusy) return;
  const online = Boolean($('#modeSwitch').dataset.online);
  const target = online ? 'offline' : 'online';
  $('#mode-title').textContent = online ? '下线（全家桶）' : '上线（全家桶）';
  // 预检
  const checks = [];
  let cfg = null;
  try { cfg = (await api('/api/config')).data.config; } catch { /* 配置读不了 */ }
  if (target === 'online') {
    checks.push([cfg?.allow?.groups?.length > 0, `群白名单非空（${cfg?.allow?.groups?.length ?? 0} 群）`]);
    checks.push([Boolean(cfg?.allow?.private?.length), `私聊白名单非空（${cfg?.allow?.private?.length ?? 0} 人）`]);
    checks.push([Boolean(cfg?.patrol?.model?.modelId), `模型已配置（${cfg?.patrol?.model?.modelId ?? '未配'}）`]);
    checks.push([cfg?.patrol?.cliPath !== undefined, 'ZCode CLI 路径已配置（上线脚本自动拉起 NapCat/watchdog/适配器）']);
  } else {
    if (online) {
      try {
        const s = (await api('/api/health')).data.adapter;
        const q = s.quotas?.wakes;
        checks.push([!q || q.active === 0, `进行中唤醒 ${q ? q.active : '—'} 个`]);
        checks.push([!q || q.queued === 0, `排队唤醒 ${q ? q.queued : '—'} 条`]);
        checks.push([!s.patrol || s.patrol.peers === 0, `缓冲群 ${s.patrol?.peers ?? '—'} 个（有积压建议等她说完）`]);
      } catch { checks.push([true, '适配器状态未知——按直接下线处理']); }
    } else {
      checks.push([true, '已是下线状态（幂等，再执行一遍也行）']);
    }
  }
  $('#mode-body').innerHTML = `<div class="mode-pre">${checks.map(([ok, text]) =>
    `<div class="p"><span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span><span>${esc(text)}</span></div>`).join('')}
    <div class="p"><span>↻</span><span>${target === 'online' ? '将依次拉起 NapCat → watchdog → 适配器，约 60~90 秒后鱼上线' : '将停止 watchdog → NapCat → 适配器 → app-server → 控制台（不动主号 QQ）'}</span></div>
  </div><div class="mode-out hidden" id="mode-out"></div>`;
  $('#mode-go').textContent = target === 'online' ? '上线' : '下线';
  $('#mode-go').dataset.target = target;
  $('#mode-modal').classList.remove('hidden');
}

async function execMode() {
  const target = $('#mode-go').dataset.target;
  modeBusy = true;
  renderModeSwitch(Boolean($('#modeSwitch').dataset.online));
  $('#mode-go').disabled = true;
  const out = $('#mode-out');
  out.classList.remove('hidden');
  out.textContent = `正在${target === 'online' ? '上线' : '下线'}…（最长等 2 分钟，别关页面）\n`;
  try {
    const r = await api('/api/actions/mode', { method: 'POST', body: { target, confirm: target.toUpperCase() }, timeoutMs: 150_000 }); // 服务端上限 120s，前端留余量
    const d = r.data;
    out.textContent = (d.output || []).join('\n') + (d.error ? `\n[失败] ${d.error}` : '');
    if (!d.ok) {
      toast(`${target === 'online' ? '上线' : '下线'}失败（退出码 ${d.exitCode ?? '?'}）`);
    } else if (target === 'offline') {
      // 下线是 detach 发起即返回（脚本最后一步会停掉控制台自身，等不到完成回调）——
      // 页面失联属预期；成败以操作流水（ops）里的 offline 记录为准
      out.textContent += '\n✓ 下线流程已发起——全家桶停止后控制台也会退出，本页面失联属预期（上线时会自动拉回）。';
      toast('下线流程已发起');
    } else {
      // 上线：适配器就绪 ≠ 鱼上线——轮询 WS 连接状态，给确定结论
      out.textContent += '\n[确认] 等待鱼连上 QQ（NapCat 快速登录 + WS 重连，约 60~90 秒）…';
      const deadline = Date.now() + 180_000;
      let fishOk = false;
      while (Date.now() < deadline) {
        await new Promise((r2) => setTimeout(r2, 3000));
        try {
          const h = await api('/api/health');
          const nc = h.data.adapter.patrol?.napcatConnected;
          const left = Math.round((deadline - Date.now()) / 1000);
          out.textContent = out.textContent.replace(/\n\[确认\][^\n]*$/, `\n[确认] 等待鱼连上 QQ…（剩余 ${left}s，WS ${nc ? '已连接' : '未连接'}）`);
          if (nc) { fishOk = true; break; }
        } catch { /* 适配器可能还在起，继续等 */ }
      }
      if (fishOk) {
        out.textContent += '\n✓ 鱼已上线（WS 已连接，群里可以 @她了）';
        toast('鱼已上线');
      } else {
        out.textContent += '\n⚠ 迟迟未连上——NapCat 可能需要扫码登录，去 NapCat 窗口看一眼；或看 fish-adapter/logs/adapter.log';
        toast('全家桶已拉起，但鱼还没连上 QQ');
      }
    }
    renderHealth();
  } catch (e) {
    if (target === 'offline') {
      // 下线后控制台随之停止：此后任何请求失败都不是新故障——失联本就是下线的一部分
      out.textContent += '\n✓ 控制台已停止（页面失联属下线的预期一环）——成败以操作流水里的 offline 记录为准。';
      toast('下线中/已下线：控制台停止属预期');
    } else {
      out.textContent += '\n[失败] ' + e.message;
      toast('执行失败：' + e.message);
    }
  } finally {
    modeBusy = false;
    renderModeSwitch(Boolean($('#modeSwitch').dataset.online));
    $('#mode-go').disabled = false;
  }
}

$('#modeSwitch').addEventListener('click', openModeModal);
$('#mode-go').addEventListener('click', execMode);
$('#mode-cancel').addEventListener('click', () => { if (!modeBusy) $('#mode-modal').classList.add('hidden'); });
$('#mode-modal-x').addEventListener('click', () => { if (!modeBusy) $('#mode-modal').classList.add('hidden'); });

// ── 测试发送页（G7/A9）：干跑预检 → 真发两档，同一根出站链，拦了置灰不许绕 ──
const STAGE_NAMES = { banned_words: '禁词闸', audit: '泄露审计', quota: '额度闸', interval: '频率/错峰闸', other: '其他' };
const sendState = { sessions: [], online: null, lastOk: null };

async function loadSend() {
  const body = $('#send-body');
  // 适配器离线 → 整块降级（绝不退化成直连 NapCat）
  let online = false;
  try { online = Boolean((await api('/api/health')).data.adapter.online); } catch { /* 离线 */ }
  sendState.online = online;
  if (!online) {
    body.innerHTML = '<div class="na-box"><div class="t">适配器离线——测试发送不可用</div><div class="d">出站链在适配器进程里，控制台绝不直连 NapCat。先在顶栏把鱼上线，再回来用这一页。</div></div>';
    return;
  }
  if (!body.querySelector('#send-chat')) {
    body.innerHTML = `
      <div class="frow"><div class="flabel">发给谁</div><div><select id="send-chat"></select></div></div>
      <div class="frow"><div class="flabel">内容<small>最多 500 字，与真发完全同链</small></div><div><textarea id="send-text" maxlength="500" placeholder="想发什么就写什么——预检不花钱不发送，真发计入额度并进聊天记录"></textarea></div></div>
      <div class="frow"><div class="flabel"></div><div style="display:flex;gap:8px">
        <button class="btn" id="send-preview">① 预检（干跑）</button>
        <button class="btn primary" id="send-go" disabled>② 真发送（计入额度）</button>
      </div></div>
      <div id="send-result" class="send-result"></div>`;
  }
  const s = await api('/api/send/sessions');
  sendState.sessions = s.data.sessions;
  const sel = body.querySelector('#send-chat');
  sel.innerHTML = sendState.sessions.map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('');
}

// 按钮事件用委托绑在容器上（loadSend 可能重建内部 DOM，委托不受影响）
$('#send-card').addEventListener('click', (e) => {
  if (e.target.id === 'send-preview') doSendTest(true).catch((err) => toast(err.message));
  if (e.target.id === 'send-go') {
    if (confirm('真发送：计入今日说话额度、会进聊天记录、真的发到对方 QQ。\n确定？')) doSendTest(false).catch((err) => toast(err.message));
  }
});

function renderSendResult(d) {
  const box = document.querySelector('#send-result');
  const go = document.querySelector('#send-go');  box.classList.add('on');
  if (d.action === 'dry-run') {
    box.innerHTML = `<span class="send-ok">✓ 预检通过：四道闸全过，将发 ${d.segments ?? '?'} 段${d.emoji ? '（含表情）' : ''}${d.replyTo ? '（带引用）' : ''}</span><div class="send-meta">干跑不发送不扣额度；真发与预检走完全相同的链。</div>`;
    go.disabled = false;
    sendState.lastOk = true;
  } else if (d.action === 'sent') {
    box.innerHTML = `<span class="send-ok">✓ 已发送</span><div class="send-meta">已计入今日说话额度，聊天记录里能看到。</div>`;
    go.disabled = true;
  } else {
    const stage = STAGE_NAMES[d.stage] ?? (d.code === 'E_CHAT_NOT_ALLOWED' ? '白名单闸' : (d.code ? '参数/权限闸' : '出站闸'));
    const why = d.message || d.reason || d.error || d.code || '未知';
    box.innerHTML = `<span class="send-bad">✗ 会被「${stage}」拦截</span><div class="send-meta">原因：${esc(why)}（${esc(d.action)}）——这是出站闸在正常工作，不许绕。</div>`;
    go.disabled = true;
    sendState.lastOk = false;
  }
}

async function doSendTest(dryRun) {
  const chatKey = document.querySelector('#send-chat')?.value;
  const text = document.querySelector('#send-text')?.value ?? '';
  if (!sendState.online) { toast('适配器离线'); return; }
  if (!chatKey) { toast('没有可选会话（白名单为空）'); return; }
  if (!text.trim()) { toast('内容不能为空'); return; }
  const r = await api(dryRun ? '/api/send/preview' : '/api/send', { method: 'POST', body: { chatKey, text }, timeoutMs: 60000 });
  renderSendResult(r.data);
}

// ── 试聊台（2026-11-27，人格调试）：与鱼直聊，完全隔离正式状态 ──
// 历史由前端持有（localStorage 持久化，刷新不丢）；[SILENT] 显示为沉默；thinking 折叠展示
const ctState = { history: [], busy: false, online: null };
const CT_STORE_KEY = 'chattest-history-v1';

function ctSaveHistory() { try { localStorage.setItem(CT_STORE_KEY, JSON.stringify(ctState.history.slice(-40))); } catch { /* 私密模式等 */ } }
function ctLoadHistory() { try { const a = JSON.parse(localStorage.getItem(CT_STORE_KEY) ?? '[]'); return Array.isArray(a) ? a.filter((h) => h && typeof h.text === 'string') : []; } catch { return []; } }

function ctBubble(h) {
  const isUser = h.role === 'user';
  const body = /^\s*\[?(SILENT|沉默)\]?\s*$/i.test(h.text) && !isUser
    ? '<div class="ct-silent">（她选择了沉默）</div>'
    : `<div class="ct-text">${esc(h.text).replace(/\n/g, '<br>')}</div>`;
  const think = h.thinking ? `<details class="ct-think"><summary>思考过程（${h.thinking.length} 字）</summary><div>${esc(h.thinking).replace(/\n/g, '<br>')}</div></details>` : '';
  const meta = h.usage ? `<div class="ct-meta">${h.usage.inputTokens ?? '?'}→${h.usage.outputTokens ?? '?'} tok${h.modelMs ? ` · ${Math.round(h.modelMs / 100) / 10}s` : ''}</div>` : '';
  return `<div class="ct-row ${isUser ? 'ct-user' : 'ct-fish'}">${think}${body}${meta}</div>`;
}

function ctRender() {
  const log = $('#chattest-log');
  if (!log) return;
  log.innerHTML = ctState.history.length
    ? ctState.history.map(ctBubble).join('')
    : '<div class="na-box">还没有对话——发一条试试（改完 persona.md 立刻生效，每次 prompt 现读）</div>';
  log.scrollTop = log.scrollHeight;
}

async function loadChatTest() {
  const body = $('#chattest-body');
  if (!body) return;
  try {
    const h = await api('/api/health', { timeoutMs: 5000 });
    ctState.online = Boolean(h?.data?.adapter?.online);
  } catch { ctState.online = false; }
  if (!ctState.online) {
    $('#chattest-log')?.replaceWith(Object.assign(document.createElement('div'), { className: 'na-box', textContent: '适配器离线——试聊台需要巡逻链路在线（fish-adapter :3200）' }));
    return;
  }
  if (!ctState.history.length) ctState.history = ctLoadHistory();
  ctRender();
}

async function doChatTest() {
  if (ctState.busy) { toast('上一条还在等她回……'); return; }
  const ta = $('#chattest-text');
  const message = (ta?.value ?? '').trim();
  if (!ctState.online) { toast('适配器离线'); return; }
  if (!message) { toast('内容不能为空'); return; }
  ta.value = '';
  ctState.history.push({ role: 'user', text: message });
  ctState.history.push({ role: 'fish', text: '……', pending: true });
  ctRender();
  ctState.busy = true;
  const btn = $('#chattest-go');
  if (btn) { btn.disabled = true; btn.textContent = '等她回…'; }
  try {
    const r = await api('/api/chat-test', {
      method: 'POST',
      body: { history: ctState.history.slice(0, -2), message }, // 发给后端的历史不含本条（后端拼"主人：本条"）
      timeoutMs: 120_000,
    });
    const d = r.data;
    ctState.history[ctState.history.length - 1] = { role: 'fish', text: d.reply ?? '', thinking: d.thinking ?? null, usage: d.usage ?? null, modelMs: d.modelMs ?? null };
  } catch (e) {
    ctState.history[ctState.history.length - 1] = { role: 'fish', text: `〔出错：${e.message}〕` };
    toast(e.message);
  } finally {
    ctState.busy = false;
    if (btn) { btn.disabled = false; btn.textContent = '发送'; }
    ctSaveHistory();
    ctRender();
  }
}

// 事件委托绑在 page section 上（清空按钮在 page-head 的 .page-actions 里，不在 #chattest-card
// 内——绑 card 会让清空按钮的点击根本到不了处理函数，2026-11-27 用户实测踩到）
$('#page-chattest').addEventListener('click', (e) => {
  if (e.target.id === 'chattest-go') doChatTest().catch((err) => toast(err.message));
  if (e.target.id === 'chattest-clear') {
    if (ctState.history.length && confirm('清空试聊历史？（不影响任何正式数据）')) {
      ctState.history = [];
      try { localStorage.removeItem(CT_STORE_KEY); } catch { /* 无妨 */ }
      ctRender();
    }
  }
});
$('#chattest-text')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doChatTest().catch((err) => toast(err.message)); }
});

// ── 表情包页（G7/A10）：浏览/搜索/排序 + 上传（六道校验+补索引）+ 删除进回收站 ──
const emState = { q: '', sort: 'usage' };

async function loadEmoji() {
  const qs = new URLSearchParams({ sort: emState.sort, ...(emState.q ? { q: emState.q } : {}) });
  const [r, g] = await Promise.all([
    api('/api/emoji?' + qs.toString()),
    api('/api/emoji/gate').catch(() => null), // 闸门状态（config.emojiGate，独立于表情列表）
  ]);
  const d = r.data.emoji;
  const gateBtn = $('#em-gate-btn');
  if (gateBtn) {
    const on = g?.data?.emoji?.enabled;
    gateBtn.textContent = '🚦 表情硬闸：' + (on ? '开（防刷屏生效中）' : '关');
    gateBtn.style.color = on ? '#6cc494' : '#8a959c';
    gateBtn.dataset.on = on ? '1' : '0';
    const gw = document.getElementById('em-gate-window');
    const gm = document.getElementById('em-gate-max');
    if (gw && g?.data?.emoji?.window) gw.value = g.data.emoji.window;
    if (gm && g?.data?.emoji?.max) gm.value = g.data.emoji.max;
  }
  if (d.state !== 'ready') {
    $('#em-strip').innerHTML = '';
    $('#emoji-grid').innerHTML = `<div class="wempty" style="grid-column:1/-1"><div class="na-box"><div class="t">表情库还没建</div><div class="d">fishpond/emojis 目录不存在或读不了。上传第一张也会自动建目录。</div></div></div>`;
    $('#em-sub').textContent = '尚未启用';
    return;
  }
  const s = d.stats;
  $('#em-sub').textContent = `${s.total} 张 · 回收站 ${s.trash} 张 · 上传会同步补选图索引`;
  $('#em-strip').innerHTML = `共 <b>${s.total}</b> 张 · 从未使用（自统计起）<b class="${s.neverUsed ? 'warn' : ''}">${s.neverUsed}</b> 张 · 使用数据来源 speak.jsonl（G2 起累积，历史无记录）`;
  $('#emoji-grid').innerHTML = d.items.map((i) => `<div class="emo ${i.desc ? '' : 'no-desc'}">
    <div class="emo-img"><img loading="lazy" src="/api/emoji/${encodeURIComponent(i.name)}" alt="${esc(i.name)}"></div>
    <button class="emo-ren" data-name="${esc(i.name)}" title="改名">✎</button><button class="emo-del" data-name="${esc(i.name)}" title="删除（进回收站）">×</button>
    <div class="emo-info">
      <div class="emo-name" title="${esc(i.name)}">${esc(i.name)}</div>
      <div class="emo-meta"><span class="${i.used ? 'used-mark' : ''}">${i.used} 次</span><span>${i.last ? esc(i.last.slice(0, 10)) : '—'}</span></div>
    </div>
  </div>`).join('') || '<div class="wempty" style="grid-column:1/-1">没有匹配的表情</div>';
  $('#emoji-foot').innerHTML = `悬停图片右上角 ✎ 改名 / × 删除（进回收站可捞回）· 描述空着的图（半透明）鱼不太知道什么时候用`;
}

$('#em-search').addEventListener('input', (e) => { emState.q = e.target.value.trim(); loadEmoji().catch(() => {}); });
$('#em-sort').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  emState.sort = b.dataset.k;
  [...$('#em-sort').children].forEach((x) => x.classList.toggle('on', x === b));
  loadEmoji().catch(() => {});
});
$('#em-upload-btn').addEventListener('click', () => {
  $('#em-modal').classList.remove('hidden');
  $('#em-file').value = ''; $('#em-desc').value = ''; $('#em-overwrite').checked = false;
  $('#em-upload-go').disabled = true;
  document.querySelectorAll('.emo-preview').forEach((x) => x.remove());
});
$('#em-modal-x').addEventListener('click', () => $('#em-modal').classList.add('hidden'));
$('#em-cancel').addEventListener('click', () => $('#em-modal').classList.add('hidden'));
$('#em-file').addEventListener('change', (e) => {
  document.querySelectorAll('.emo-preview').forEach((x) => x.remove());
  $('#em-upload-go').disabled = !e.target.files?.length;
});
$('#em-upload-go').addEventListener('click', () => {
  const f = $('#em-file').files?.[0];
  if (!f) { toast('先选一张图'); return; }
  const rd = new FileReader();
  rd.onload = async () => {
    try {
      const r = await api('/api/emoji', {
        method: 'POST', timeoutMs: 30000,
        body: { name: f.name, dataBase64: String(rd.result).split(',')[1] ?? '', desc: $('#em-desc').value, overwrite: $('#em-overwrite').checked },
      });
      $('#em-modal').classList.add('hidden');
      toast(`已上传 ${r.data.name}（${(r.data.size / 1024).toFixed(0)}KB，索引已同步）`);
      loadEmoji().catch(() => {});
    } catch (e) { toast('上传失败：' + e.message); }
  };
  rd.readAsDataURL(f);
});
// ── 回收站（G8c）：列表 + 一键恢复（描述从 ops 流水找回，恢复时可改）──
async function loadTrash() {
  const r = await api('/api/emoji/trash');
  const t = r.data.trash;
  const list = $('#trash-list');
  if (t.state !== 'ready' || !t.items.length) {
    list.innerHTML = '<div class="na-box"><div class="t">回收站是空的</div><div class="d">删掉的表情包会在这里等你反悔。</div></div>';
    $('#trash-hint').textContent = '';
    return;
  }
  list.innerHTML = t.items.map((i) => `<div style="display:grid;grid-template-columns:64px 1fr auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(36,49,56,.5)">
    <img loading="lazy" src="/api/emoji-trash-img?name=${encodeURIComponent(i.trashName)}" style="width:64px;height:64px;object-fit:contain;border-radius:4px;background:#101820">
    <div>
      <div style="font-size:12px;color:#cfdde4">${esc(i.name)}</div>
      <div class="send-meta">${i.deletedAt ? esc(i.deletedAt.replace('T', ' ').slice(0, 16)) : '—'} 删除 · ${(i.size / 1024).toFixed(0)}KB${i.oldDesc ? ` · 原描述：${esc(i.oldDesc.slice(0, 30))}` : ' · 原描述未留档'}</div>
    </div>
    <button class="btn sm" data-trash="${esc(i.trashName)}" data-name="${esc(i.name)}" data-desc="${esc(i.oldDesc ?? '')}">恢复</button>
  </div>`).join('');
  $('#trash-hint').textContent = `共 ${t.items.length} 张 · 恢复 = 搬回表情库 + 索引描述找回（库里已有同名会拒绝，先处理冲突）`;
}

$('#emoji-grid').addEventListener('click', async (e) => {
  if (e.target.matches('.emo-ren')) {
    const name = e.target.dataset.name;
    const stem = name.replace(/\.[a-z]+$/i, '');
    const ext = name.slice(stem.length);
    const nn = prompt(`给「${name}」改名——输入新名字（不用带扩展名 ${ext}）：`, stem)?.trim();
    if (!nn || nn === stem) return;
    const to = nn + ext;
    if (!confirm(`「${name}」→「${to}」？\n文件与索引描述同步改名，她的表情索引立即生效。`)) return;
    try {
      await api('/api/emoji/rename', { method: 'POST', body: { from: name, to } });
      toast(`已改名 → ${to}`);
      loadEmoji().catch(() => {});
    } catch (err) { toast('改名失败：' + err.message); }
    return;
  }
  if (e.target.matches('.emo-del')) {
    const name = e.target.dataset.name;
    if (!confirm(`删除「${name}」？\n移入回收站（.trash），可随时在回收站一键恢复。`)) return;
    try {
      await api('/api/emoji/' + encodeURIComponent(name), { method: 'DELETE' });
      toast('已移入回收站');
      loadEmoji().catch(() => {});
    } catch (err) { toast('删除失败：' + err.message); }
  }
});

// ── 运维页（G8/A12）：进程 / 额度 / 会话清理 / 操作流水 ──
const OPS_ACTION_NAMES = {
  online: '上线', offline: '下线', restart: '重启适配器', prune: '清会话',
  'review.memory': '审记忆', 'review.vocab': '审行话', emoji_upload: '传表情', emoji_delete: '删表情',
};

async function loadOps() {
  // 进程 + 额度（/api/health 一次拿全）
  let h = null;
  try { h = (await api('/api/health')).data.adapter; } catch { /* 离线 */ }
  if (h && h.online) {
    const up = h.uptimeMs ? Math.round(h.uptimeMs / 60000) : 0;
    $('#ops-proc').innerHTML = [
      ['状态', `<span class="send-ok">在线</span>`], ['PID', h.pid], ['运行时长', up >= 60 ? `${Math.floor(up / 60)} 小时 ${up % 60} 分` : `${up} 分钟`],
      ['模式', h.mode], ['WS 连 NapCat', h.patrol?.napcatConnected ? '✓ 已连接' : '✗ 未连接'],
      ['工具面自检', `${h.patrol?.toolsOk === false ? '✗ 熔断中' : '✓ 正常'} · ${h.patrol?.selfCheckModel ? `${h.patrol.selfCheckModel.modelId}/${h.patrol.selfCheckModel.reasoningLevel ?? '默认档'}` : '跟随聊天'}`], ['app-server', h.patrol?.appServerAlive ? '存活' : '未拉起'],
    ].map(([k, v]) => `<div class="side-card-row" style="display:flex;justify-content:space-between;padding:6px 0;font-size:11.5px;border-bottom:1px solid rgba(36,49,56,.5)"><span class="k" style="color:var(--dim)">${k}</span><span style="font-family:var(--mono);font-size:11px;color:#b9c9d1">${v}</span></div>`).join('');
    const w = h.quotas?.wakes, s = h.quotas?.says;
    $('#ops-quota').innerHTML = w && s
      ? [['思考', `${w.dailyWakes}/${w.maxDailyWakes}`], ['说话', `${s.dailyCount}/${s.maxDailyTotal}`], ['私聊', `${w.privateWakes}/${w.privateMaxPerDay}`]]
        .map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11.5px"><span style="color:var(--dim)">${k}</span><span class="mono" style="color:#b9c9d1">${v}</span></div>`).join('')
      : '';
  } else {
    $('#ops-proc').innerHTML = '<div class="na-box"><div class="t">适配器离线</div><div class="d">顶栏开关可上线。</div></div>';
    $('#ops-quota').innerHTML = '';
  }
  // 操作流水
  let ops = null;
  try { ops = (await api('/api/ops')).data.ops; } catch { /* 挂了 */ }
  $('#ops-body').innerHTML = ops && ops.state === 'ready' && ops.items.length
    ? ops.items.map((o) => `<tr>
        <td class="num">${fmtTime(o.ts)}</td>
        <td class="dim">${o.actor === 'console' ? '控制台' : (o.actor === 'cli' ? '终端' : o.actor)}</td>
        <td>${OPS_ACTION_NAMES[o.action] ?? esc(o.action)}</td>
        <td>${o.ok ? '<span class="bdg sent">成功</span>' : `<span class="bdg error">失败${o.stage ? '·' + esc(o.stage) : ''}</span>`}</td>
        <td class="num">${o.ms ? fmtMs(o.ms) : '—'}</td>
        <td class="dim" title="${esc(JSON.stringify(o.detail ?? {}))}">${esc(Object.values(o.detail ?? {}).join(' ').slice(0, 30))}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="dim" style="text-align:center;height:50px">暂无操作记录</td></tr>';
  $('#prune-go').disabled = true;
  $('#prune-out').textContent = '';
}

// ── 数据备份（2026-11-28）：立即备份按钮 + 状态行 ──
async function loadBackupStatus() {
  try {
    const r = await api('/api/backup');
    const d = r.data;
    const fmt = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}K`;
    if (d.latest) {
      const days = d.daysSinceLast;
      const stale = days != null && days >= 3;
      $('#bk-out').innerHTML = `最近快照 ${d.latest.snapshot}（${d.latest.count} 文件 · ${fmt(d.latest.bytes)}）· 保留 ${d.snapshots.length}/${d.keep} 份`
        + (days != null ? ` · ${stale ? `<b style="color:#c25e5e">距上次备份 ${days} 天——该备份了</b>` : `距上次备份 ${days} 天`}` : '');
    } else {
      $('#bk-out').innerHTML = '<b style="color:#c25e5e">还没有快照——点「立即备份」生成第一份</b>';
    }
  } catch (e) {
    $('#bk-out').textContent = '状态读取失败：' + e.message;
  }
}

$('#bk-run').addEventListener('click', async () => {
  const b = $('#bk-run');
  if (b.disabled) return;
  b.disabled = true;
  $('#bk-out').textContent = '打包中…';
  try {
    const r = await api('/api/backup/run', { method: 'POST', timeoutMs: 70_000 });
    const d = r.data;
    const fmt = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}K`;
    toast(`备份完成：${d.files} 文件 ${fmt(d.totalBytes)}`);
    await loadBackupStatus();
  } catch (e) {
    toast('备份失败：' + e.message);
    $('#bk-out').textContent = '失败——' + e.message;
  } finally { b.disabled = false; }
});

$('#ops-refresh').addEventListener('click', () => { loadOps().then(() => toast('已刷新')).catch((e) => toast(e.message)); });
$('#prune-preview').addEventListener('click', async () => {
  try {
    const r = await api('/api/actions/prune', { timeoutMs: 60_000 });
    const d = r.data;
    $('#prune-out').textContent = d.ok ? `将软删 ${d.tasks ?? '?'} 条旧会话条目` : ('预览失败：' + d.error);
    $('#prune-go').disabled = !(d.ok && d.tasks > 0);
  } catch (e) { toast('预览失败：' + e.message); }
});
$('#prune-go').addEventListener('click', async () => {
  if (!confirm('执行清理：软删旧会话条目（删前逐条归档到 sessions.jsonl，删除不可逆但留档可查）。\n确定？')) return;
  try {
    const r = await api('/api/actions/prune', { method: 'POST', body: { confirm: 'PRUNE' }, timeoutMs: 90_000 });
    const d = r.data;
    $('#prune-out').textContent = d.ok ? `完成（输出 ${d.output?.length ?? 0} 行）` : ('失败：' + d.error);
    $('#prune-go').disabled = true;
  } catch (e) { toast('执行失败：' + e.message); }
});
$('#ops-open-logs').addEventListener('click', () => {
  api('/api/actions/open-logs', { method: 'POST', body: {} }).catch((e) => toast(e.message));
});
$('#ops-shutdown').addEventListener('click', async () => {
  const online = $('#modeSwitch').dataset.online === '1';
  const msg = online
    ? '关闭控制台：鱼当前在线，会先自动下线鱼，然后控制台进程退出。\n（外部强杀/崩溃不会触发此联动）\n确定？'
    : '关闭控制台进程？（桌面「鱼缸控制台」图标可随时拉起）\n确定？';
  if (!confirm(msg)) return;
  try {
    const r = await api('/api/actions/shutdown', { method: 'POST', body: { confirm: 'SHUTDOWN' }, timeoutMs: 60_000 });
    toast(r.data.fishOffline ? '鱼已下线，控制台即将退出' : '控制台即将退出');
    $('#ops-proc').innerHTML = '<div class="na-box"><div class="t">控制台正在退出…</div><div class="d">桌面「鱼缸控制台」图标可随时拉起。</div></div>';
  } catch (e) {
    // 连接断开 = 已退出（预期内）
    if (String(e.message).includes('fetch') || String(e.message).includes('Failed')) toast('控制台已退出');
    else toast('关闭失败：' + e.message);
  }
});

// ── 人格卡编辑（G8b：persona.md 主人创作的人格设定——与 core.md 记忆闸门无关，保存即生效）──
const personaState = { hash: null, original: '' };

async function loadPersona() {
  const ta = $('#persona-text');
  try {
    const r = await api('/api/persona');
    const p = r.data.persona;
    if (p.state !== 'ready') {
      ta.value = '';
      ta.disabled = true;
      $('#persona-meta').textContent = 'persona.md 尚未启用（fishpond/persona.md 不存在）';
      $('#persona-save').disabled = true;
      return;
    }
    ta.disabled = false;
    if (ta.value !== p.content && !ta.dataset.dirty) { // 只在非编辑中时覆盖（刷新不打断编辑）
      ta.value = p.content;
      personaState.original = p.content;
      personaState.hash = p.hash;
    }
    $('#persona-meta').textContent = `${p.chars} 字 · ${p.lines} 行 · 基线 ${p.hash}（每次唤醒全文内嵌，太长吃 token）`;
  } catch (e) {
    $('#persona-meta').textContent = '读取失败：' + e.message;
  }
}

$('#persona-text').addEventListener('input', (e) => {
  e.target.dataset.dirty = '1';
  const changed = e.target.value !== personaState.original;
  $('#persona-save').disabled = !changed;
  $('#persona-meta').textContent = changed
    ? `已修改（${e.target.value.length} 字，原 ${personaState.original.length} 字）——保存后鱼下一次唤醒就用新人格`
    : `${personaState.original.length} 字 · 基线 ${personaState.hash}`;
});

$('#persona-reload').addEventListener('click', () => {
  delete $('#persona-text').dataset.dirty;
  $('#persona-text').value = personaState.original;
  $('#persona-save').disabled = true;
  toast('已还原为当前文件内容');
});

$('#persona-save').addEventListener('click', async () => {
  const txt = $('#persona-text').value;
  if (!confirm(`保存人格卡？\n· 立即生效：鱼下一次唤醒就用新人格（无需重启）\n· 旧版本备份到 persona.md.bak\n确定？`)) return;
  try {
    const r = await api('/api/persona', { method: 'POST', body: { content: txt, baseHash: personaState.hash }, timeoutMs: 15000 });
    const p = r.data.persona;
    personaState.original = txt;
    personaState.hash = p.hash;
    delete $('#persona-text').dataset.dirty;
    $('#persona-save').disabled = true;
    $('#persona-meta').textContent = `${p.chars} 字 · 新基线 ${p.hash} · 已生效`;
    toast('人格已保存——下一次唤醒生效');
  } catch (e) {
    toast('保存失败：' + e.message);
    if (String(e.message).includes('外部修改')) loadPersona(); // 基线冲突 → 重拉
  }
});

// 表情硬闸开关（G9b）：一键切换 config.emojiGate.enabled——适配器现读 config，即时生效无需重启
$('#em-gate-btn').addEventListener('click', async () => {
  const btn = $('#em-gate-btn');
  const cur = btn.dataset.on === '1';
  const next = !cur;
  if (!confirm(next
    ? '开启表情硬闸？\n同群最近 5 条发言已带 2 次表情时，本次回复的表情将降级为纯文本（即时生效，无需重启）。'
    : '关闭表情硬闸？\n关闭后她可以按自己的节奏随意发表情（即时生效）。')) return;
  try {
    const gw = Number(document.getElementById('em-gate-window')?.value ?? 5);
    const gm = Number(document.getElementById('em-gate-max')?.value ?? 2);
    const r = await api('/api/emoji/gate', { method: 'POST', body: { enabled: next, window: gw, max: gm } });
    toast(r.data.enabled ? '硬闸已开启（即时生效）' : '硬闸已关闭');
    loadEmoji().catch(() => {});
  } catch (e) { toast('切换失败：' + e.message); }
});

// 硬闸阈值数字自定义（change 即保存，即时生效）
['em-gate-window', 'em-gate-max'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', async (e) => {
    const body = id === 'em-gate-window'
      ? { window: Number(e.target.value), max: Number(document.getElementById('em-gate-max')?.value ?? 2) }
      : { max: Number(e.target.value), window: Number(document.getElementById('em-gate-window')?.value ?? 5) };
    try {
      await api('/api/emoji/gate', { method: 'POST', body });
      toast('阈值已更新（即时生效）');
    } catch (err) { toast('保存失败：' + err.message); loadEmoji().catch(() => {}); }
  });
});

// 回收站模态交互
$('#em-trash-btn').addEventListener('click', () => {
  $('#trash-modal').classList.remove('hidden');
  loadTrash().catch((e) => toast(e.message));
});
$('#trash-modal-x').addEventListener('click', () => $('#trash-modal').classList.add('hidden'));
$('#trash-list').addEventListener('click', async (e) => {
  if (!e.target.matches('button[data-trash]')) return;
  const { trash, name, desc } = e.target.dataset;
  const newDesc = prompt(`恢复「${name}」的选图描述（可改，留空则不写）：`, desc || '') ?? null;
  if (newDesc === null) return; // 取消
  try {
    await api('/api/emoji/trash/restore', { method: 'POST', body: { trashName: trash, desc: newDesc } });
    toast(`已恢复「${name}」到表情库`);
    loadTrash().catch(() => {});
    loadEmoji().catch(() => {});
  } catch (err) { toast('恢复失败：' + err.message); }
});

// ── 自动化任务页（G8e）：学习/日记按钮手动触发 + 积压 + 日记阅读 ──
const amState = { poll: null };

function amStatusBadge(run) {
  if (!run) return '<span class="bdg skip">未运行过</span>';
  if (run.status === 'running') return `<span class="bdg warnb">运行中 ${Math.round(run.elapsedMs / 1000)}s</span>`;
  if (run.status === 'done') return '<span class="bdg sent">上次完成</span>';
  return `<span class="bdg error">上次出错</span>`;
}

async function loadAutomations() {
  const r = await api('/api/tasks/status');
  const d = r.data.tasks;

  // 学习积压卡
  const b = d.backlog;
  $('#am-backlog').innerHTML = b
    ? `<div class="card-head"><h2>学习任务积压${b.cursorOverflow ? ' <span style="color:#e07b7b">⚠ 游标越界</span>' : ''}</h2><span class="hint">游标 vs 消息日志行数（纯文件读，零成本）</span></div>
       <div class="card-body"><div class="stats-row">
         <div class="stat"><div class="k">已学到</div><div class="v" style="color:${b.cursorOverflow ? '#e07b7b' : ''}">${b.cursor}<small>行</small></div></div>
         <div class="stat"><div class="k">日志现有</div><div class="v">${b.chatLines}<small>行</small></div></div>
         <div class="stat"><div class="k">积压未学</div><div class="v" style="color:${b.cursorOverflow ? '#e07b7b' : b.unlearned > 100 ? '#d7ac5c' : '#6cc494'}">${b.unlearned}<small>行</small></div></div>
         <div class="stat"><div class="k">行话库最后产出</div><div class="v" style="font-size:13px">${d.vocabMtime ? esc(d.vocabMtime.replace('T', ' ').slice(0, 16)) : '—'}</div></div>
       </div>${b.cursorOverflow ? '<div style="color:#e07b7b;font-size:12px;padding:6px 14px 12px">游标超过日志实际行数（虚推）——学习被短路拦下，需手动回拨 .learner-cursor</div>' : ''}</div>`
    : '';

  // 日记积压卡（G9 加菜：今日是否已写 / 今日素材 / 连续记录 / 最近 7 天缺口）
  const db2 = d.diaryBacklog;
  $('#am-diary-backlog').innerHTML = db2 ? `<div class="card-head"><h2>日记任务积压</h2><span class="hint">今天的素材够不够写、记录断没断（纯文件读，零成本）</span></div>
       <div class="card-body"><div class="stats-row">
         <div class="stat"><div class="k">今日日记</div><div class="v" style="color:${db2.todayWritten ? '#6cc494' : '#d7ac5c'}">${db2.todayWritten ? '✓ 已写 <small>' + (db2.todaySize / 1024).toFixed(1) + 'KB</small>' : '还没写'}</div></div>
         <div class="stat"><div class="k">今日素材</div><div class="v">${db2.todayMsgs}<small>条群消息</small></div></div>
         <div class="stat"><div class="k">连续记录</div><div class="v">${db2.streak}<small>天</small></div></div>
         <div class="stat"><div class="k">近 7 天缺口</div><div class="v" style="color:${db2.missing.length ? '#d7ac5c' : '#6cc494'}">${db2.missing.length ? db2.missing.map((x) => x.slice(5)).join('、') : '无'}</div></div>
       </div></div>`
    : '';

  // 学习 / 日记状态
  const learn = d.runs.learn, diary = d.runs.diary;
  $('#am-learn-badge').innerHTML = amStatusBadge(learn);
  $('#am-diary-badge').innerHTML = amStatusBadge(diary);
  $('#am-learn-status').innerHTML = runStatusText(learn, 'learn');
  $('#am-diary-status').innerHTML = runStatusText(diary, 'diary');
  $('#am-learn-go').disabled = learn?.status === 'running';
  $('#am-diary-go').disabled = diary?.status === 'running';

  // 卡片小字：当前生效模型（config ?? 默认；配置页「脑子（模型）」组可改）
  const fmtModel = (m) => m ? `${m.modelId} · ${m.options?.reasoningLevel ?? '默认档'}` : '（未配置，走全局默认）';
  const lm = $('#am-learn-model'); if (lm) lm.textContent = `生效模型：${fmtModel(d.models?.learn)} · 配置页「脑子（模型）」可改 · 产出进候选区待审阅转正`;
  const dm = $('#am-diary-model'); if (dm) dm.textContent = `生效模型：${fmtModel(d.models?.diary)} · 配置页「脑子（模型）」可改 · 产物落在下方日记列表`;
}

// 任务书外写入报告（2026-11-28，后端 task-guard.mjs）：任务动了任务书没让它动的文件时，状态行下面亮一行
function strayHtml(s) {
  if (!s || s.checkError) return s?.checkError ? `<div class="send-meta" style="color:#e07b7b">⚠ 越界检查失败：${esc(s.checkError)}</div>` : '';
  // 文件名由模型决定，一律过 esc——不能让任务写出的文件名把标签带进管理面板
  const failed = s.quarantineFailed ?? [];
  const parts = [
    ...failed.map((x) => `${esc(x.rel)}（隔离失败：${esc(x.error)}）`),
    ...(s.modified ?? []).map((x) => `${esc(x)}（被改动，请检查）`),
    ...(s.removed ?? []).map((x) => `${esc(x)}（被删除）`),
    ...(s.added ?? []).filter((x) => !failed.some((f) => f.rel === x)).map((x) => `${esc(x)}（已隔离）`),
  ];
  if (!parts.length) return '';
  return `<div style="font-size:11px;color:#e07b7b;margin-top:4px">⚠ 任务动了任务书之外的文件：${parts.join('、')}${s.concurrent ? '（另一任务同时在跑，可能是它写的）' : ''}</div>`;
}

// 任务会话 ID（2026-11-28 挂账销账）：任务跑完保留 ZCode sessionId——事后要翻原会话排查
// "模型当时到底干了什么"时，复制这串去会话工具里定位（控制台不做打开会话功能，给到 id 即可）
function sessIdHtml(run) {
  return run?.sessionId ? `<div style="font-size:10.5px;color:var(--mute);margin-top:2px">会话 <span style="user-select:all">${esc(String(run.sessionId))}</span></div>` : '';
}

function runStatusText(run, kind) {
  if (!run || run.status === 'error' && !run.error && !run.finishedAt) return '<span style="color:var(--mute)">还没跑过——点下面按钮开始第一次</span>';
  if (run.status === 'running') {
    return `<div><span class="bdg warnb">运行中 ${Math.round(run.elapsedMs / 1000)}s</span></div>
      <div style="font-size:11px;color:var(--mute);margin-top:4px">${kind === 'learn' ? '读积压消息提取行话，可能要几分钟（满推理）' : '写今天的吐槽日记，一两分钟'}——完成后自动刷新</div>`;
  }
  if (run.status === 'done') {
    return `<div><span class="send-ok">✓ 上次完成</span> <span class="send-meta">耗时 ${fmtMs(run.elapsedMs)}${run.finishedAt ? ' · ' + new Date(run.finishedAt).toTimeString().slice(0, 5) : ''}</span></div>${sessIdHtml(run)}${strayHtml(run.stray)}`;
  }
  return `<div><span class="send-bad">✗ 上次出错</span></div><div class="send-meta">${esc(run.error ?? '')}</div><div style="font-size:10.5px;color:var(--mute)">可重试</div>${sessIdHtml(run)}${strayHtml(run.stray)}`;
}

// 触发 + 运行期间 5s 轮询
async function triggerTask(kind) {
  const label = kind === 'learn' ? '学习' : '写日记';
  try {
    const j = await api('/api/tasks/run', { method: 'POST', body: { kind, confirm: 'RUN' } });
    if (j.data?.skipped) { toast(j.data.message); loadAutomations().catch(() => {}); return; }
    toast(label + '任务已启动');
  } catch (e) {
    toast('启动失败：' + e.message);
    return;
  }
  loadAutomations().catch(() => {});
  // 运行期间挂轮询（loadAutomations 内部在 done 后自动停止——running 时 loadAutomations 会重新挂）
  pollEvery('task-run', 5000, async () => {
    const r = (await api('/api/tasks/status')).data.tasks;
    const running = r.runs[kind]?.status === 'running';
    await loadAutomations().catch(() => {});
    if (!running) {
      pollTasks.delete('task-run');
      if (kind === 'diary') loadDiary().catch(() => {}); // 日记完成后刷新列表（新文件落盘要重新拉）
    }
  });
}

$('#am-learn-go').addEventListener('click', () => {
  if (!confirm('立即学习？\n· 按配置页「学习任务模型」运行（有模型成本），读约 400 行积压消息\n· 产出行话候选，稍后去审阅页转正\n确定？')) return;
  triggerTask('learn');
});
$('#am-diary-go').addEventListener('click', () => {
  if (!confirm('写今日日记？\n· 按配置页「日记任务模型」运行，一两分钟\n· 产物出现在下方日记列表\n确定？')) return;
  triggerTask('diary');
});
$('#am-refresh').addEventListener('click', () => { loadAutomations().then(() => toast('已刷新')).catch((e) => toast(e.message)); });

// ── 日记列表与阅读 ──
function renderDiary(md) {
  // 零依赖轻量 md 渲染：先整体转义，再做有限的白名单语法处理
  let h = esc(md);
  h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/^[-*] (.+)$/gm, '<div style="padding-left:16px">· $1</div>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
  return h;
}

async function loadDiary(openName) {
  const r = await api('/api/diary');
  const d = r.data.diary;
  const list = $('#diary-list');
  if (d.state !== 'ready' || !d.items.length) {
    list.innerHTML = '<div class="na-box"><div class="t">还没有日记</div><div class="d">点上方「写今日日记」让她开始记录。</div></div>';
    $('#am-diary-hint').textContent = '';
    return;
  }
  $('#am-diary-hint').textContent = `${d.items.length} 篇 · 点击阅读 · 悬停右侧 × 删除`;
  list.innerHTML = d.items.map((i) => `<div class="mem-item" style="cursor:pointer" data-diary="${esc(i.name)}">
    <div>
      <div class="mi-text">${esc(i.name.replace('.md', ''))} 的日记</div>
      <div class="mi-meta"><span>${(i.size / 1024).toFixed(1)}KB</span><span>${esc(i.mtime.replace('T', ' ').slice(0, 16))}</span></div>
    </div>
    <button class="mi-more" data-diary-del="${esc(i.name)}" title="删除（删前归档留痕）" style="height:auto;padding:2px 0">×</button>
  </div>`).join('');
}

$('#diary-list').addEventListener('click', async (e) => {
  // 删除按钮先于阅读判定（按钮在 mem-item 内部，closest('[data-diary]') 会命中整卡）
  const del = e.target.closest('[data-diary-del]');
  if (del) {
    const name = del.dataset.diaryDel;
    if (!confirm(`删除「${name.replace('.md', '')} 的日记」？\n内容会先归档留痕（fish-adapter/logs/diary-deleted.jsonl），误删可手工写回恢复。`)) return;
    try {
      await api('/api/diary/' + encodeURIComponent(name), { method: 'DELETE' });
      toast('已删除（已归档留痕）');
      loadDiary().catch(() => {});
    } catch (err) { toast('删除失败：' + err.message); }
    return;
  }
  const item = e.target.closest('[data-diary]');
  if (!item) return;
  const name = item.dataset.diary;
  try {
    const r = await fetch('/api/diary/' + encodeURIComponent(name));
    const md = await r.text();
    $('#diary-reader').classList.remove('hidden');
    $('#diary-reader-name').textContent = name;
    $('#diary-reader-body').innerHTML = renderDiary(md);
    $('#diary-reader').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { toast('读取失败：' + err.message); }
});
$('#diary-reader-close').addEventListener('click', () => $('#diary-reader').classList.add('hidden'));

// ── 启动 ──
window.__cfg = { loadConfig, FIELD_DEFS, fieldInput, cfgState, providerOptions, modelOptions }; // 调试钩子（排障用，无敏感）
$('#btn-refresh').addEventListener('click', () => { renderHealth(); renderOverview(); toast('已手动刷新'); });
setInterval(() => { $('#clock').textContent = new Date().toTimeString().slice(0, 8); }, 1000);
route();
pollEvery('health', 3000, renderHealth);
pollEvery('overview', 3000, renderOverview);
