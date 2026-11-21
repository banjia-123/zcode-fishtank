// tasks-manual.json 脱敏生成器 v2：实值源 → 占位符仓库副本
// 形态全覆盖：单反斜杠 / 双反斜杠（JSON 嵌套转义）/ 正斜杠 的路径，QQ 号，本机用户名数据目录
import { readFileSync, writeFileSync } from 'node:fs';

let s = readFileSync('D:/zcode工作区/console/tasks-manual.json', 'utf8');
const BS = '\\';
const POND_B = 'D:' + BS + BS + 'zcode工作区' + BS + BS + 'fishpond';   // D:\\zcode工作区\\fishpond（双）
const POND_S = 'D:' + BS + 'zcode工作区' + BS + 'fishpond';             // D:\zcode工作区\fishpond（单）
const ADPT_B = 'D:' + BS + BS + 'zcode工作区' + BS + BS + 'fish-adapter';
const ADPT_S = 'D:' + BS + 'zcode工作区' + BS + 'fish-adapter';
for (const p of [POND_B, POND_S]) s = s.split(p).join('<fishpond目录>');
for (const p of [ADPT_B, ADPT_S]) s = s.split(p).join('<fish-adapter目录>');
s = s.split('D:/zcode工作区/fishpond').join('<fishpond目录>');
s = s.split('D:/zcode工作区/fish-adapter').join('<fish-adapter目录>');
s = s.split('C:/Users/Administrator/.zcode').join('<zcode数据目录>');
s = s.split('C:\\Users\\Administrator\\.zcode').join('<zcode数据目录>');
s = s.split('<鱼QQ号>').join('<鱼QQ号>');
s = s.split('<你的QQ号>').join('<你的QQ号>');
writeFileSync('D:/zcode工作区/zcode-fishtank/console/tasks-manual.json', s, 'utf8');
const bad = ['<鱼QQ号>', '<你的QQ号>', 'zcode工作区', 'Administrator'].filter((k) => s.includes(k));
console.log(bad.length ? `残留 ${bad.length} 处` : '脱敏完成，0 残留 ✓');
