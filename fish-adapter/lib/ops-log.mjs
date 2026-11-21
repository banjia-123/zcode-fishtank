// 操作流水（接口契约 §4）：控制台按钮 = spawn 脚本 + 看退出码，流水由**脚本自己写**——
// 终端手工跑也留痕、只有脚本知道自己是否真成功、控制台崩了不影响记录。
// 格式：一行一个 JSON {ts, actor, action, ok, ms, stage, err, detail}
//   actor：cli（终端手工）/ console（控制台按钮拉起，脚本按来源传参）
//   action：online / offline / restart / prune / review.memory / review.vocab / …
// 轮转：超 5MB 改名 ops.jsonl.1（只留一份）。控制台只 tail 读，不整文件读。
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from './util.mjs';

const OPS_PATH = join(ROOT_DIR, 'state', 'ops.jsonl');
const ROTATE_BYTES = 5 * 1024 * 1024;

export function logOp(action, ok, { actor = 'cli', ms = 0, stage = null, err = null, detail = {} } = {}) {
  try {
    mkdirSync(join(ROOT_DIR, 'state'), { recursive: true });
    try {
      if (statSync(OPS_PATH).size > ROTATE_BYTES) renameSync(OPS_PATH, OPS_PATH + '.1');
    } catch { /* 文件还不存在 */ }
    appendFileSync(OPS_PATH, JSON.stringify({
      ts: Date.now(), actor, action, ok,
      ms: Math.round(ms), stage,
      err: err === null ? null : String(err).slice(0, 200),
      detail,
    }) + '\n', 'utf8');
  } catch { /* 流水失败不阻断业务 */ }
}
