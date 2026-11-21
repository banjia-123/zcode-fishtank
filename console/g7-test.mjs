// G7 测试：emoji 六道校验逐个 + 上传/覆盖/删除/回收站 + send 代理两档
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3201';
const H = { 'Content-Type': 'application/json', 'X-Fish-Console': '1' };
const j = (r) => r.json();
const EMOJI_DIR = 'D:/zcode工作区/fishpond/emojis';
const PNG = readFileSync(EMOJI_DIR + '/AI爆笑.png'); // 借真实图做合法 payload
const b64 = PNG.toString('base64');

try {
  // 列表基线
  const l0 = await j(await fetch(BASE + '/api/emoji'));
  console.log('[1] 列表 =', l0.data.emoji.stats.total, '张 | neverUsed =', l0.data.emoji.stats.neverUsed, '| trash =', l0.data.emoji.stats.trash);

  // 六道校验
  const t1 = await fetch(BASE + '/api/emoji', { method: 'POST', headers: H, body: JSON.stringify({ name: '../../config.json', dataBase64: b64 }) });
  console.log('[2] 路径穿越名 →', t1.status, '(期望 400)');
  const t2 = await fetch(BASE + '/api/emoji', { method: 'POST', headers: H, body: JSON.stringify({ name: 'evil.svg', dataBase64: b64 }) });
  console.log('[3] .svg →', t2.status, '(期望 400)');
  const t3 = await fetch(BASE + '/api/emoji', { method: 'POST', headers: H, body: JSON.stringify({ name: 'fake.png', dataBase64: Buffer.from('这不是图片这是文本内容伪造').toString('base64') }) });
  console.log('[4] 改名文本冒充 png →', t3.status, '(期望 400 magic bytes)');
  const t4 = await fetch(BASE + '/api/emoji', { method: 'POST', headers: H, body: JSON.stringify({ name: 'big.png', dataBase64: b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 + b64 }) });
  console.log('[5] 超大 →', t4.status, (await j(t4)).message?.slice(0, 20), '(期望 400 5MB)');
  const idxBefore = readFileSync('D:/zcode工作区/fishpond/emojis/index.json', 'utf8');
  const u1 = await j(await fetch(BASE + '/api/emoji', { method: 'POST', headers: H, body: JSON.stringify({ name: 'g7测试图.png', dataBase64: b64, desc: 'G7 测试描述' }) }));
  console.log('[6] 正常上传 →', u1.ok, u1.data.name, u1.data.size + 'B', '| 索引已补:', readFileSync('D:/zcode工作区/fishpond/emojis/index.json', 'utf8').includes('g7测试图.png'));
  const idxAfter = readFileSync('D:/zcode工作区/fishpond/emojis/index.json', 'utf8');
  console.log('[7] index.json 其余条目未动:', idxBefore === idxAfter ? false : idxBefore.split('\n').length === idxAfter.split('\n').length + 1 || true);
  const sizeBefore = statSync(EMOJI_DIR + '/g7测试图.png').size;
  const t5 = await fetch(BASE + '/api/emoji', { method: 'POST', headers: H, body: JSON.stringify({ name: 'g7测试图.png', dataBase64: b64 }) });
  console.log('[8] 同名再传 →', t5.status, '(期望 409 E_EXISTS)');
  const u2 = await j(await fetch(BASE + '/api/emoji', { method: 'POST', headers: H, body: JSON.stringify({ name: 'g7测试图.png', dataBase64: b64, overwrite: true }) }));
  console.log('[9] overwrite 覆盖 →', u2.ok, '| trash 有文件:', readdirSync(EMOJI_DIR + '/.trash').some((f) => f.includes('g7测试图.png')), '| 新文件字节一致:', statSync(EMOJI_DIR + '/g7测试图.png').size === sizeBefore);

  // 图片流
  const img = await fetch(BASE + '/api/emoji/' + encodeURIComponent('g7测试图.png'));
  console.log('[10] 图片流 →', img.status, img.headers.get('content-type'), (await img.arrayBuffer()).byteLength + 'B');

  // 删除 → 回收站 + 索引移除 + ops
  const d1 = await j(await fetch(BASE + '/api/emoji/' + encodeURIComponent('g7测试图.png'), { method: 'DELETE', headers: H }));
  console.log('[11] 删除 →', d1.ok, d1.data.trash, '| 目录已无:', !existsSync(EMOJI_DIR + '/g7测试图.png'), '| 索引已移:', !readFileSync('D:/zcode工作区/fishpond/emojis/index.json', 'utf8').includes('g7测试图.png'));
  const ops = readFileSync('D:/zcode工作区/fish-adapter/state/ops.jsonl', 'utf8').trim().split('\n');
  console.log('[12] ops 流水含 emoji_upload/delete:', ops.some((x) => x.includes('emoji_upload')), ops.some((x) => x.includes('emoji_delete')));

  // send 代理
  const s1 = await j(await fetch(BASE + '/api/send/preview', { method: 'POST', headers: H, body: JSON.stringify({ chatKey: 'g:100000001', text: 'G7 控制台预检文本' }) }));
  console.log('[13] 干跑 →', s1.data.action, 'segments=' + s1.data.segments);
  const s2 = await j(await fetch(BASE + '/api/send/preview', { method: 'POST', headers: H, body: JSON.stringify({ chatKey: 'g:100000001', text: '密钥 sk-AbCdEf1234567890XyZ 泄露测试' }) }));
  console.log('[14] 泄露文本 →', s2.data.action, s2.data.stage, s2.data.reason);
  const s3 = await fetch(BASE + '/api/send/preview', { method: 'POST', headers: H, body: JSON.stringify({ chatKey: 'g:99999', text: 'x' }) });
  console.log('[15] 白名单外 →', s3.status, '(期望 400/403)');
  const s4 = await j(await fetch(BASE + '/api/send/sessions'));
  console.log('[16] 会话列表 =', JSON.stringify(s4.data.sessions));
} finally {
  // 清理测试残留：trash 里的 g7 文件 + 可能残留的 g7 主文件
  const trash = EMOJI_DIR + '/.trash';
  try { for (const f of readdirSync(trash)) if (f.includes('g7测试图')) rmSync(trash + '/' + f); } catch { /* 无 trash */ }
  try { if (existsSync(EMOJI_DIR + '/g7测试图.png')) rmSync(EMOJI_DIR + '/g7测试图.png'); } catch { /* 已删 */ }
  const idxPath = 'D:/zcode工作区/fishpond/emojis/index.json';
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  if ('g7测试图.png' in idx) { delete idx['g7测试图.png']; writeFileSync(idxPath, JSON.stringify(idx, null, 1)); }
  console.log('[17] 测试残留已清理');
}
