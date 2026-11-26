// 按需复核（2026-11-26）离线用例：imgpool 入池/TTL/上限挤旧/peer 隔离 + poolExtrasFor 触发判定/去重
// 跑法：node test-imgpool.mjs，退出码 0 = 全过
import './test-setup.mjs';
import { recordImg, pickImgs, poolExtrasFor } from './lib/imgpool.mjs';

let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

// I1 入池与取出
recordImg('g:1', 'attachments/inbox/a-1-img1.jpg');
recordImg('g:1', 'attachments/inbox/b-2-img1.jpg');
ok(JSON.stringify(pickImgs('g:1')) === JSON.stringify(['attachments/inbox/a-1-img1.jpg', 'attachments/inbox/b-2-img1.jpg']), 'I1a 两图入池可取');

// I2 上限 2 张、新挤旧
recordImg('g:1', 'attachments/inbox/c-3-img1.jpg');
ok(pickImgs('g:1').length === 2 && pickImgs('g:1')[0] === 'attachments/inbox/b-2-img1.jpg', 'I2a 第 3 张挤掉最老的');

// I3 peer 隔离
recordImg('p:9', 'attachments/inbox/x-9-img1.png');
ok(pickImgs('p:9').length === 1 && pickImgs('g:1').length === 2, 'I3a 各池互不串');

// I4 TTL 过期
recordImg('g:2', 'attachments/inbox/old-img1.jpg', Date.now() - 400_000);
ok(pickImgs('g:2').length === 0, 'I4a 过期图不取');

// I5 图话题触发判定
const mk = (text) => ({ text });
recordImg('g:3', 'attachments/inbox/y-1-img1.jpg');
ok(poolExtrasFor([mk('这图里画的是谁')], 'g:3', new Set()).length === 1, 'I5a 消息含"图"字触发附带');
ok(poolExtrasFor([mk('晚饭吃什么')], 'g:3', new Set()).length === 0, 'I5b 无图话题不带（语义错位防护）');
ok(poolExtrasFor([mk('那个 photo 真好看'), mk('嗯')], 'g:3', new Set()).length === 1, 'I5c 批内任一条命中即触发');
ok(poolExtrasFor([mk('看图')], 'g:none', new Set()).length === 0, 'I5d 池空不附带');

// I6 与批内已有附件去重（同文件名不重附）
ok(poolExtrasFor([mk('看图')], 'g:3', new Set(['y-1-img1.jpg'])).length === 0, 'I6a 批内已有的图不重复附带');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
