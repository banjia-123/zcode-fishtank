// review 脚本共享件（D5 收敛）：vocab-review 与 memory-review 原先逐字复制的三段同构——
// 非交互 stdout 协议（outJson）、--apply 参数解析（parseApplyPayload）、交互行队列（createLineQueue）。
// B4/C4 两轮审计 bug 恰好都长在这对复制件上（同一对 bug 翻倍摊两个文件）——收敛后只修一处。
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// 非交互输出：writeSync 直写 stdout fd，完成后才 exit——同步终止控制流
// （回调式 exit 有窗口，--list 会掉进 --apply 分支）
export const outJson = (code, obj) => {
  try { writeSync(1, JSON.stringify(obj) + '\n'); } catch { /* stdout 已关闭等罕见场景 */ }
  process.exit(code);
};

// --apply 的 payload 解析：--json-file 路径优先，其次 --json 内联；
// allowedActions 由调用方传（approve/reject/… 两家动作集不同）。校验失败原样抛出。
export function parseApplyPayload(args, allowedActions) {
  const ji = args.indexOf('--json'), jf = args.indexOf('--json-file');
  const raw = jf >= 0 && args[jf + 1] ? readFileSync(resolve(args[jf + 1]), 'utf8')
    : ji >= 0 && args[ji + 1] ? args[ji + 1] : null;
  const payload = JSON.parse(raw);
  if (!payload || !Array.isArray(payload.items)) throw new Error('items 不是数组');
  for (const it of payload.items) {
    if (!it || typeof it.id !== 'string' || !allowedActions.includes(it.action)) {
      throw new Error(`条目字段非法：${JSON.stringify(it ?? null).slice(0, 80)}`);
    }
  }
  return payload;
}

// 交互行队列：readline/promises 的 question 在两次提问间隙会丢掉
// 已到达的行（粘贴多行/管道输入必丢），这里 line 一到就入队，ask 出队；
// stdin 结束（管道耗尽 / Ctrl+Z）时挂起的 ask 立刻失败 → 已审数据均已落盘。
// eofErr() 返回 EOF 错误对象引用（主循环 catch 里 e === q.eofErr() 区分"输入中断"与"写盘失败"）。
export function createLineQueue() {
  const rl = createInterface({ input: process.stdin });
  const lineBuf = [], waiters = [];
  rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else lineBuf.push(l); });
  let eofErr = null;
  const ask = async () => {
    if (eofErr) throw eofErr;
    if (lineBuf.length) return lineBuf.shift();
    return new Promise((res, rej) => {
      waiters.push(res);
      rl.once('close', () => rej(eofErr ?? (eofErr = new Error('输入流已结束（EOF）'))));
    });
  };
  return { rl, ask, eofErr: () => eofErr };
}
