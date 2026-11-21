// S2-C 离线测试：名字三档（name-tier.mjs）+ tier2 退避 + peer-store
// 跑法：node test-name-tier.mjs（退避用例写 state/peers/g_990x.json，测试后清理）
import { detectNameTier, isNameMuted, noteNameOutcome } from './lib/name-tier.mjs';
import { readPeer, chatKeyToPeerKey } from './lib/peer-store.mjs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from './lib/util.mjs';

let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

const NAMES = ['伊丽莎白', '伊莎'];
const PHRASES = ['伊丽莎白圈', '伊丽莎白瓜', '伊丽莎白二世', '伊丽莎白女王', '伊丽莎白·泰勒', '伊莎贝拉', '伊莎贝尔', '伊莎多拉'];
const dt = (t) => detectNameTier(t, NAMES, PHRASES);

// —— S2.16 验收清单 · 名字档位 ——
ok(dt('伊莎，你觉得呢').tier === 1, '「伊莎，你觉得呢」→ tier1（开头+标点边界）');
ok(dt('问一下伊丽莎白').tier === 1, '「问一下伊丽莎白」→ tier1（句尾边界）');
ok(dt('伊丽莎白！').tier === 1, '「伊丽莎白！」→ tier1（句尾感叹号边界）');
ok(dt('@伊丽莎白 在吗').tier === 1, '「@伊丽莎白 在吗」→ tier1（@ 后空白边界）');
ok(dt('伊丽莎白圈好可爱').tier === 0, '「伊丽莎白圈好可爱」→ tier0（屏蔽短语）');
ok(dt('伊莎贝拉那部电影我看过').tier === 0, '「伊莎贝拉那部电影我看过」→ tier0（屏蔽短语）');
ok(dt('伊丽莎白二世去世了吗').tier === 0, '「伊丽莎白二世去世了吗」→ tier0（屏蔽短语）');
ok(dt('昨天伊丽莎白那事你记得吗').tier === 2, '「昨天伊丽莎白那事你记得吗」→ tier2（句中，前后贴字）');
ok(dt('这个伊莎真的好用').tier === 2, '「这个伊莎真的好用」→ tier2（句中）');

// 最长优先：一条消息同时含「伊丽莎白」和「伊莎」→ 只返回一次、命中长名（不能连回两条）
{
  const r = dt('伊丽莎白和伊莎都是她');
  ok(r.tier === 1 && r.name === '伊丽莎白', '同时命中长短名 → tier1 且取长名「伊丽莎白」', JSON.stringify(r));
}
{
  const r = dt('伊莎叫伊丽莎白全名');
  ok(r.tier === 1, '含边界命中的短名也算 tier1（一次）', JSON.stringify(r));
}

// 敬称后缀（实测盲区修复）：名字+大人/酱等收尾 = 句尾直呼
ok(dt('臣一片赤胆忠心啊伊丽莎白大人').tier === 1, '「…啊伊丽莎白大人」→ tier1（敬称收尾=直呼）');
ok(dt('伊丽莎白大人！').tier === 1, '「伊丽莎白大人！」→ tier1（敬称+标点）');
ok(dt('伊莎酱~').tier === 1, '「伊莎酱~」→ tier1（酱+波浪号）');
ok(dt('我问伊丽莎白大人们').tier === 2, '「我问伊丽莎白大人们」→ tier2（敬称后还有字，不是收尾）');
ok(dt('昨天伊丽莎白大人那事你记得吗').tier === 2, '「昨天伊丽莎白大人那事…」→ tier2（句中提及，敬称不救）');
ok(dt('伊丽莎白女王去世了吗').tier === 0, '「伊丽莎白女王…」仍 tier0（屏蔽短语优先于敬称）');

// 屏蔽短语被替换成等长占位符，不会把后面的正常名字误伤
ok(dt('伊丽莎白圈旁边站着伊丽莎白').tier === 1, '屏蔽短语与真名字并存 → 真名字仍 tier1（位置不错位）');

// 空表/空文本边界
ok(detectNameTier('', NAMES, PHRASES).tier === 0, '空文本 → tier0');
ok(detectNameTier('随便聊', [], []).tier === 0, '名字表为空 → tier0');
ok(detectNameTier(null, NAMES, PHRASES).tier === 0, 'null 文本不炸 → tier0');

// —— tier2 自动退避（状态机）——
const TK = 'g:990'; // 测试专用 chatKey，测完删文件
try {
  ok(!isNameMuted(TK), '初始未静音');
  noteNameOutcome(TK, true);
  noteNameOutcome(TK, true);
  ok(!isNameMuted(TK), '连续 2 次沉默 → 还未静音（要 3 次）');
  noteNameOutcome(TK, true);
  ok(isNameMuted(TK), '连续 3 次沉默 → 已静音 30 分钟');
  const ns = readPeer(TK).nameSoft;
  ok(Number(ns.mutedUntil) > Date.now() && Number(ns.mutedUntil) <= Date.now() + 30 * 60 * 1000 + 1000, 'mutedUntil 在未来 30 分钟内');
  ok(Number(ns.streakSilent) === 0, '触发静音后计数清零');
  noteNameOutcome(TK, false);
  ok(isNameMuted(TK), '静音期内有实际回复 → 仍静音（mutedUntil 不提前解除，只清计数）');
} finally {
  try { rmSync(join(ROOT_DIR, 'state', 'peers', chatKeyToPeerKey(TK) + '.json')); } catch { /* 已不存在 */ }
  try { rmSync(join(ROOT_DIR, 'state', 'peers', chatKeyToPeerKey(TK) + '.json.tmp')); } catch { /* 已不存在 */ }
}

// peer-store 基础
ok(chatKeyToPeerKey('g:123') === 'g_123' && chatKeyToPeerKey('p:456') === 'p_456', 'peerKey 转换 g:/p: → 下划线');
ok(JSON.stringify(readPeer('g:never-exists-xyz')) === '{}', '不存在的 peer → 空对象不报错');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
