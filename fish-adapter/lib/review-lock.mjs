// 审阅并发锁（接口契约 §2.1）：同一时刻只允许一个 --apply 写 candidates/core/vocab。
// state/review.lock 用 openSync(..., 'wx') 原子创建；进程正常退出时删锁。
// 崩溃残留的陈旧锁（>60s 未更新）视为死锁自动接管——--apply 都是秒级完成，60s 足够宽。
import { openSync, closeSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'state', 'review.lock');
const STALE_MS = 60_000;

function tryCreate() {
  const fd = openSync(LOCK_PATH, 'wx');
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
}

// 成功返回 null，被占返回人话错误（调用方 exit 2）
export function acquireLock() {
  try { mkdirSync(dirname(LOCK_PATH), { recursive: true }); } catch { /* 已存在 */ }
  try {
    tryCreate();
    return null;
  } catch (e) {
    if (e.code !== 'EEXIST') return `无法创建锁：${e.message}`;
    try {
      if (Date.now() - statSync(LOCK_PATH).mtimeMs > STALE_MS) {
        rmSync(LOCK_PATH); // 上个进程崩溃留下的死锁，接管
        tryCreate();
        return null;
      }
    } catch { /* 锁状态读不了，按被占处理 */ }
    return '另一个审校正在进行（state/review.lock 被持有）';
  }
}

export function releaseLock() {
  try { rmSync(LOCK_PATH); } catch { /* 已不存在 */ }
}
