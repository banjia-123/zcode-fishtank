// 本地路径占位：<工作区> = 部署根目录（本仓库不留真实路径，本地跑前全局替换回来）
// tasks-manual.json 脱敏生成器：实值源 → 占位符仓库副本
// 用法：node sanitize-tasks-manual.mjs <鱼QQ号> <你的QQ号>
//   （QQ 号只经命令行传入；源码零个人值——用户名等本机特征用通配正则覆盖）
// 覆盖形态：单反斜杠 / 双反斜杠（JSON 嵌套转义）/ 正斜杠 的本机路径，QQ 号，用户名数据目录
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
// 本机路径（任意用户名）：正则覆盖 单斜杠/双斜杠/正斜杠 三种形态
// zcode 与 工作区 之间分隔符可选（{0,2}）：实际目录名是连写的 zcode工作区，
// 旧正则 {1,2} 强制要求分隔符 → 反斜杠真实路径 D:\zcode工作区\fishpond 全部漏洗（盲区根因）
s = s.replace(/D:[/\\]{1,2}zcode[/\\]{0,2}工作区[/\\]{1,2}fishpond/g, '<fishpond目录>');
s = s.replace(/D:[/\\]{1,2}zcode[/\\]{0,2}工作区[/\\]{1,2}fish-adapter/g, '<fish-adapter目录>');
s = s.replace(/C:[/\\]{1,2}Users[/\\]{1,2}[^/\\:]+[/\\]{1,2}\.zcode/g, '<zcode数据目录>');
s = s.split('<工作区>/fishpond').join('<fishpond目录>');
s = s.split('<工作区>/fish-adapter').join('<fish-adapter目录>');
s = s.split(fishQQ).join('<鱼QQ号>');
s = s.split(ownerQQ).join('<你的QQ号>');
writeFileSync(join(PKG, 'console', 'tasks-manual.json'), s, 'utf8');
const bad = [fishQQ, ownerQQ, ZC, 'Users'].filter((k) => s.includes(k));
console.log(bad.length ? `残留 ${bad.length} 处` : '脱敏完成，0 残留 ✓');
