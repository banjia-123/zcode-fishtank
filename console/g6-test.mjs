// G6 配置两段式 + 上下线测试（生产 config 已备份为 .g6bak，结束后还原）
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3201';
const CFG = 'D:/zcode工作区/fish-adapter/config.json';
const BAK = CFG + '.g6bak';
const H = { 'Content-Type': 'application/json', 'X-Fish-Console': '1' };
const j = (r) => r.json();
const patch = (body) => fetch(BASE + '/api/config', { method: 'PATCH', headers: H, body: JSON.stringify(body) });

try {
  const cfg = await j(await fetch(BASE + '/api/config'));
  const bv = cfg.data.baseVersion;
  console.log('[K1] token =', cfg.data.config.onebot.accessToken, '| schema =', cfg.data.schemaKeys.length, '字段');

  const t1 = await patch({ patch: { 'patrol.tools': [] }, baseVersion: bv });
  console.log('[K2] 红线字段 patrol.tools →', t1.status, (await j(t1)).code, '(期望 403 E_FORBIDDEN_POLICY)');
  const t2 = await patch({ patch: { 'allow.allowAllWhenEmpty': true }, baseVersion: bv });
  console.log('[K3] 红线字段 allowAllWhenEmpty →', t2.status, (await j(t2)).code, '(期望 403)');
  const t3 = await patch({ patch: { 'patrol.maxDailyWakes': 99999 }, baseVersion: bv });
  console.log('[K4] 超范围值 99999 →', t3.status, '(期望 400)');
  const t4 = await patch({ patch: { 'patrol.maxDailyWakes': 90 }, baseVersion: 'fake-baseline' });
  console.log('[K5] 基线不符 →', t4.status, (await j(t4)).code, '(期望 409 E_CONFLICT)');
  const t5 = await patch({ patch: { 'patrol.maxDailyWakes': 90, 'patrol.silentHours.start': '02:00' }, baseVersion: bv });
  const d5 = await j(t5);
  console.log('[K6] 正常预览 → diff =', JSON.stringify(d5.data.diff.map(x => x.path)), '| warnings =', d5.data.warnings.length, '| token =', d5.data.applyToken.slice(0, 8) + '…');

  const a1 = await fetch(BASE + '/api/config/apply', { method: 'POST', headers: H, body: JSON.stringify({ applyToken: 'bad', patchHash: d5.data.patchHash }) });
  console.log('[K7] 坏 token apply →', a1.status, '(期望 410)');
  const a2 = await fetch(BASE + '/api/config/apply', { method: 'POST', headers: H, body: JSON.stringify({ applyToken: d5.data.applyToken, patchHash: 'mismatch' }) });
  console.log('[K8] patchHash 不符 →', a2.status, (await j(a2)).code, '(期望 409)');
  const a3 = await j(await fetch(BASE + '/api/config/apply', { method: 'POST', headers: H, body: JSON.stringify({ applyToken: d5.data.applyToken, patchHash: d5.data.patchHash }) }));
  console.log('[K9] 正常 apply →', JSON.stringify(a3.data));
  const after = JSON.parse(readFileSync(CFG, 'utf8'));
  console.log('[K10] 落盘验证: maxDailyWakes =', after.patrol.maxDailyWakes, '(期望 90) | silentHours.start =', after.patrol.silentHours.start, '(期望 02:00)');
  const a4 = await fetch(BASE + '/api/config/apply', { method: 'POST', headers: H, body: JSON.stringify({ applyToken: d5.data.applyToken, patchHash: d5.data.patchHash }) });
  console.log('[K11] 重用已耗 token →', a4.status, '(期望 410)');
  const files = readdirSync('D:/zcode工作区/fish-adapter/backups').filter((f) => f.startsWith('config-'));
  console.log('[K12] 备份目录:', files.length, '份');

  // mode：confirm 错 400 + offline 幂等真跑
  const m1 = await fetch(BASE + '/api/actions/mode', { method: 'POST', headers: H, body: JSON.stringify({ target: 'online', confirm: 'wrong' }) });
  console.log('[K13] mode confirm 错 →', m1.status, '(期望 400)');
  const m2 = await j(await fetch(BASE + '/api/actions/mode', { method: 'POST', headers: H, body: JSON.stringify({ target: 'offline', confirm: 'OFFLINE' }) }));
  console.log('[K14] 幂等下线 → ok =', m2.data.ok, '| 输出尾部:', (m2.data.output || []).slice(-2).join(' / ').slice(0, 60));
} finally {
  copyFileSync(BAK, CFG);
  rmSync(BAK);
  const restored = JSON.parse(readFileSync(CFG, 'utf8'));
  console.log('[K15] 生产 config 已还原: maxDailyWakes =', restored.patrol.maxDailyWakes, '| start =', restored.patrol.silentHours.start, '| token 完好 =', restored.onebot.accessToken.length > 30);
}
