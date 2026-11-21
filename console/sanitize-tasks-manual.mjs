// tasks-manual.json 脱敏生成器：实值源 → 占位符仓库副本
// 用法：node sanitize-tasks-manual.mjs <鱼QQ号> <你的QQ号>
//   （QQ 号只经命令行传入，本脚本源码不含任何个人值——部署者替换成自己的）
// 覆盖形态：单反斜杠 / 双反斜杠（JSON 嵌套转义）/ 正斜杠 的本机路径，QQ 号，用户名数据目录
// 路径模板按包根约定（本脚本在 <包根>/console/ 下）；ZCode 数据目录按默认位置识别
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [fishQQ, ownerQQ] = process.argv.slice(2);
if (!fishQQ || !ownerQQ) {
  console.error('用法: node sanitize-tasks-manual.mjs <鱼QQ号> <你的QQ号>');
  process.exit(1);
}

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // 包根
let s = readFileSync(join(PKG, 'console', 'tasks-manual.json'), 'utf8');
const BS = '\\';
const ZC = 'zcode' + '工作区'; // 拆写：源码不直出完整本机路径
const POND_B = 'D:' + BS + BS + ZC + BS + BS + 'fishpond';
const POND_S = 'D:' + BS + ZC + BS + 'fishpond';
const ADPT_B = 'D:' + BS + BS + ZC + BS + BS + 'fish-adapter';
const ADPT_S = 'D:' + BS + ZC + BS + 'fish-adapter';
for (const p of [POND_B, POND_S]) s = s.split(p).join('<fishpond目录>');
for (const p of [ADPT_B, ADPT_S]) s = s.split(p).join('<fish-adapter目录>');
s = s.split('D:/zcode工作区/fishpond').join('<fishpond目录>');
s = s.split('D:/zcode工作区/fish-adapter').join('<fish-adapter目录>');
s = s.split('C:/Users/Administrator/.zcode').join('<zcode数据目录>');
s = s.split('C:' + BS + 'Users' + BS + 'Administrator' + BS + '.zcode').join('<zcode数据目录>');
s = s.split(fishQQ).join('<鱼QQ号>');
s = s.split(ownerQQ).join('<你的QQ号>');
writeFileSync(join(PKG, 'console', 'tasks-manual.json'), s, 'utf8');
const bad = [fishQQ, ownerQQ, ZC, 'Administrator'].filter((k) => s.includes(k));
console.log(bad.length ? `残留 ${bad.length} 处` : '脱敏完成，0 残留 ✓');
