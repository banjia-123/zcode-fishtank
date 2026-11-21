// 本地路径占位：<工作区> = 部署根目录（本仓库不留真实路径，本地跑前全局替换回来）
// probe6：验证 session/send 的 attachments 图片输入——两种形状各测一次，问"图里有什么"
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CFG = JSON.parse(readFileSync('<工作区>/fish-adapter/config.json', 'utf8'));
const WORKSPACE = '<工作区>/fishpond';
const IMG = '<工作区>/fishpond/attachments/inbox/<消息图片文件名>.jpg'; // 本地跑时指向任意一张真实收到的图片附件

const child = spawn(process.execPath, [CFG.patrol.cliPath, 'app-server'], { cwd: WORKSPACE, stdio: ['pipe', 'pipe', 'pipe'] });
let seq = 0; const pending = new Map(); const handlers = new Set(); let buf = '';
function send(f) { try { child.stdin.write(JSON.stringify(f) + '\n'); } catch {} }
function request(method, params, timeoutMs = 20000) {
  const id = 'p' + (++seq);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    send({ id, method, params });
  });
}
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.method != null) {
      if (j.id != null) {
        if (j.method === 'session/requestRuntimePreferences') send({ id: j.id, result: { nativeSearchEnhancementsEnabled: false } });
        else send({ id: j.id, error: { code: -32601, message: 'not supported' } });
      }
      for (const h of handlers) { try { h(j); } catch {} }
    } else {
      const p = pending.get(String(j.id));
      if (p) { pending.delete(String(j.id)); j.error ? p.reject(new Error(JSON.stringify(j.error).slice(0, 200))) : p.resolve(j.result); }
    }
  }
});
const kill = () => { try { child.kill(); } catch {} setTimeout(() => process.exit(0), 300); };
const T0 = Date.now();
const t = () => `[${Math.round((Date.now() - T0) / 1000)}s]`;

async function ask(attachments, label) {
  const created = await request('session/create', { workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE }, mode: 'edit' });
  const sessionId = created?.session?.sessionId ?? created?.sessionId;
  await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
  const answer = await new Promise((resolve, reject) => {
    let text = '';
    const onEvent = (frame) => {
      if (frame.method !== 'session/event') return;
      const p = frame.params?.payload ?? {};
      if (p.kind === 'text_delta' && typeof p.delta === 'string') text += p.delta;
      if (p.error) { cleanupEv(); reject(new Error('turn-failed: ' + String(p.error.message ?? '').slice(0, 120))); }
      else if (p.stopReason != null && p.stopReason !== 'tool-calls') { cleanupEv(); resolve(String(p.content ?? text)); }
    };
    function cleanupEv() { handlers.delete(onEvent); }
    handlers.add(onEvent);
    request('session/send', {
      sessionId,
      content: '描述你看到的这张图片（物品、场景），50 字内。如果你没有收到任何图片或图片是空白的，直接回答"没收到图"。',
      ...(attachments ? { attachments } : {}),
      modelSelection: { providerId: 'bigmodel-standard-api', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } },
      toolDenylist: ['Bash', 'Shell', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'Skill'],
    }, 60000).catch((e) => { cleanupEv(); reject(e); });
  });
  console.log(t(), label, '→', JSON.stringify(String(answer).slice(0, 150)));
  await request('session/close', { sessionId }, 5000).catch(() => {});
}

try {
  await new Promise((r) => setTimeout(r, 1500));
  await ask([{ kind: 'image', localPath: IMG, filename: 'img.jpg', mimeType: 'image/jpeg' }], 'v4 {kind,localPath,mimeType}');
} catch (e) {
  console.log(t(), 'FAIL ❌', e.message);
} finally { kill(); }
