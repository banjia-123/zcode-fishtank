// 测试引导（2026-11-23 测试隔离）：lib/* 与 wake/* 的 ROOT_DIR 默认指向 fish-adapter/ 自身，日志、审计、
// 计数、去重、peer、wake 留痕全挂在它下面——测试直接 import 就会写进生产文件（11-22 实测：counters.json
// 混入假群号、audit.log 77 行里 74 行是测试数据、adapter.log 与 wake.jsonl 里累计上百行 [test]）。
// 这里在 lib 求值之前把 ROOT_DIR 指到一次性临时目录（util.mjs 认环境变量 FISH_ADAPTER_ROOT）。
// 用法：每个 test-*.mjs 的第一条 import 写 `import { STATE_ROOT } from './test-setup.mjs';`
//   ——ESM 按书写顺序求值，这一条必须排在所有 ./lib/*、./wake/* 之前。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const STATE_ROOT = mkdtempSync(join(tmpdir(), 'fish-state-'));
process.env.FISH_ADAPTER_ROOT = STATE_ROOT;
const tmpDirs = [STATE_ROOT];
// 测试自己 mkdtemp 的目录登记进来，退出时一并删
export function cleanOnExit(dir) { tmpDirs.push(dir); }
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清理 */ } } });
