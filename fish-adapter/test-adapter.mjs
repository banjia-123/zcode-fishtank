// D6/专项债补盲：adapter.mjs 主入口集成测试（此前零覆盖——lib/wake 层全测了，装配层裸奔）
// 覆盖：A4 配置形状 fail-fast（坏 config 拒绝启动）/ boot 后 /health /stats 契约 /
//       /outbound/test 鉴权闸。子进程跑真 adapter，无巡逻的最轻装配（不 spawn app-server），
//       WS 指向无人端口（重连日志无碍 boot——顺带锁定了这个容错事实）。
// 跑法：node test-adapter.mjs，退出码 0 = 全过
import { STATE_ROOT } from './test-setup.mjs';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HERE, 'adapter.mjs');
const PORT = 3299; // 专用端口，避开生产 3200 与并行测试

const mkCfg = (over = {}) => ({
  onebot: { selfId: '10000', wsUrl: 'ws://127.0.0.1:39999', httpUrl: 'http://127.0.0.1:39999', accessToken: 't' },
  botName: '测试鱼',
  allow: { groups: ['100'], private: ['1'], allowAllWhenEmpty: false },
  ownerQQ: '1',
  listen: { port: PORT },
  console: { token: 'console-tok' },
  limits: { maxRepliesPerMessage: 2, maxProactivePerGroupPerMinute: 1, maxDailyTotal: 200 },
  ...over,
});

const spawnAdapter = (cfg) => {
  const env = { ...process.env, FISH_ADAPTER_ROOT: STATE_ROOT };
  return spawn(process.execPath, [ADAPTER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
};

// —— AD1 配置形状 fail-fast（A4）：groups 缺失 → 拒绝启动，非零退出 ——
{
  writeFileSync(join(STATE_ROOT, 'config.json'), JSON.stringify({ ...mkCfg(), allow: { private: ['1'], allowAllWhenEmpty: false } }, null, 1));
  const p = spawnAdapter();
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });
  const code = await new Promise((r) => { p.on('exit', (c) => r(c)); setTimeout(() => r('timeout'), 8000); });
  ok(code !== 0 && code !== 'timeout', 'AD1a 坏 config（缺 allow.groups）拒绝启动（非零退出）', `exit=${code}`);
  ok(/必须为数组/.test(err), 'AD1b 报错点名白名单形状（fail-fast 提示）', err.slice(0, 120));
  p.kill();
}

// —— AD2-AD4 合法 boot + 端点契约 ——
{
  writeFileSync(join(STATE_ROOT, 'config.json'), JSON.stringify(mkCfg(), null, 1));
  const p = spawnAdapter();
  let bootErr = '';
  p.stderr.on('data', (d) => { bootErr += d.toString(); });
  p.stdout.on('data', () => { /* boot 日志流（不关心内容） */ });

  // /health 轮询至就绪（WS 连不上只打日志不挡 boot——顺带锁定该容错）
  const healthy = await (async () => {
    for (let i = 0; i < 33; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) });
        if (r.status === 200 && (await r.text()).trim() === 'ok') return true;
      } catch { /* 未起 */ }
      await sleep(300);
    }
    return false;
  })();
  ok(healthy, 'AD2 合法 config boot 就绪（/health=ok，WS 无人端口不挡 boot）', bootErr.slice(0, 100));

  if (healthy) {
    // /stats 契约：控制台只读端点的结构
    const r3 = await fetch(`http://127.0.0.1:${PORT}/stats`);
    const j3 = await r3.json();
    ok(j3.ok === true && j3.pid > 0 && j3.mode === 'file-bridge' && j3.patrol?.enabled === false, 'AD3 /stats 结构（pid/mode/patrol.enabled）', JSON.stringify(j3).slice(0, 120));
    // 无巡逻链路 → quotas.wakes 为 null（合理降级）；says（出站额度）任何模式都有
    ok(j3.quotas?.says != null && j3.quotas?.wakes === null, 'AD3b /stats 额度快照：says 恒有、wakes 在无巡逻模式降级为 null', JSON.stringify(j3.quotas ?? null).slice(0, 100));

    // /outbound/test 鉴权闸：无 token → 403 E_TOKEN（不进出站链）
    const r4 = await fetch(`http://127.0.0.1:${PORT}/outbound/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j4 = await r4.json().catch(() => ({}));
    ok(r4.status === 403 && j4.code === 'E_TOKEN', 'AD4 /outbound/test 无 token 拒绝（403 E_TOKEN）', `${r4.status} ${JSON.stringify(j4).slice(0, 60)}`);
    // /chat-test 鉴权闸（试聊台）：无 token → 403；无巡逻时带 token → 409 E_NO_PATROL
    const r5 = await fetch(`http://127.0.0.1:${PORT}/chat-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"hi"}' });
    const j5 = await r5.json().catch(() => ({}));
    ok(r5.status === 403 && j5.code === 'E_TOKEN', 'AD5 /chat-test 无 token 拒绝（403 E_TOKEN）', `${r5.status}`);
    const r5b = await fetch(`http://127.0.0.1:${PORT}/chat-test`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-console-token': 'console-tok' }, body: '{"message":"hi"}' });
    const j5b = await r5b.json().catch(() => ({}));
    ok(r5b.status === 409 && j5b.code === 'E_NO_PATROL', 'AD5b 无巡逻（未启用 patrol）→ 409 E_NO_PATROL', `${r5b.status} ${JSON.stringify(j5b).slice(0, 80)}`);
  }
  p.kill();
  await sleep(200);
}

// —— AD6 试聊台正常往返（patrol+fake 实例：3298 端口）+ 正式状态隔离断言 ——
{
  const PORT2 = 3298;
  const cfg6 = {
    ...mkCfg(),
    listen: { port: PORT2 },
    patrol: { enabled: true, cliPath: join(HERE, 'wake', 'fake-app-server.mjs'), batchWindowMs: 100, mustWindowMs: 50, minWakeIntervalMs: 0, maxDailyWakes: 1000, model: { providerId: 'fake', modelId: 'fake-model' }, silentHours: null, wakeTimeoutMs: 30_000 },
  };
  writeFileSync(join(STATE_ROOT, 'config.json'), JSON.stringify(cfg6, null, 1));
  // persona 目录：fake 协议下 buildTestPrompt 读 personaDir（fishpondDir 回退包根 fishpond——测试环境无 → 降级空串不炸）
  const p6 = spawnAdapter();
  await (async () => {
    for (let i = 0; i < 33; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT2}/health`, { signal: AbortSignal.timeout(500) }); if (r.ok) return true; } catch { /* 未起 */ }
      await sleep(300);
    }
    return false;
  })();
  const wakeBefore = existsSync(join(STATE_ROOT, 'logs', 'wake.jsonl')) ? readFileSync(join(STATE_ROOT, 'logs', 'wake.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
  const r6 = await fetch(`http://127.0.0.1:${PORT2}/chat-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-console-token': 'console-tok' },
    body: JSON.stringify({ history: [{ role: 'user', text: '在吗' }], message: 'FAKE:OK' }),
  });
  const j6 = await r6.json().catch(() => ({}));
  ok(r6.status === 200 && j6.ok === true && j6.reply === 'OK' && j6.usage?.inputTokens === 1, 'AD6a 试聊往返：fake 模型回 OK+usage', `${r6.status} ${JSON.stringify(j6).slice(0, 100)}`);
  ok(j6.modelMs != null && j6.modelMs >= 0, 'AD6b 返回 modelMs');
  const wakeAfter = existsSync(join(STATE_ROOT, 'logs', 'wake.jsonl')) ? readFileSync(join(STATE_ROOT, 'logs', 'wake.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
  ok(wakeAfter === wakeBefore, 'AD6c 隔离：试聊不写正式 wake.jsonl（绕过 safe 账本）', `before=${wakeBefore} after=${wakeAfter}`);
  const ctLog = existsSync(join(STATE_ROOT, 'logs', 'chat-test.jsonl')) ? readFileSync(join(STATE_ROOT, 'logs', 'chat-test.jsonl'), 'utf8').trim().split('\n').length : 0;
  ok(ctLog >= 1, 'AD6d 独立留痕 chat-test.jsonl 有记录', `lines=${ctLog}`);
  p6.kill();
  await sleep(200);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
