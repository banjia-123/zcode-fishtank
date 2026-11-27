// 运行日志轮转（S4 收尾补）：append-only 日志超阈值滚成 <名>.1，旧 .1 顺移 .2（共留两份旧档）。
// 原则：轮转的只有"运行日志"；归档类（sessions.jsonl / dropped.jsonl / diary-deleted.jsonl）是留痕本体不轮；
// fishpond/logs/chat.jsonl 绝不动——学习任务的 .learner-cursor 是绝对行号，轮转会错位游标。
// Windows 注意：文件被并发持有时 rename 会失败——try-catch 跳过，下一轮再试（append 每次开闭，几乎不会锁）。
import { statSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log, ROOT_DIR } from './util.mjs';
import { bridgeDirs } from './bridge.mjs';

const ROTATE_BYTES = 2 * 1024 * 1024; // 单文件 2MB 触发

// [文件名, 目录, 可选自定义上限字节]——适配器日志都在 ROOT_DIR/logs；speak.jsonl 在鱼缸领地 fishpond/logs
// wake-trace.jsonl 单条 5~10KB（prompt 全量），默认 2MB 只够半天的量——单列 8MB ≈ 一周热闹量
const LOG_FILES = [
  ['adapter.log', join(ROOT_DIR, 'logs')],
  ['wake.jsonl', join(ROOT_DIR, 'logs')],
  ['audit.log', join(ROOT_DIR, 'logs')],
  ['speak.jsonl', null], // 运行时用 bridgeDirs(cfg).base 解析（鱼缸目录可配置）
  ['wake-trace.jsonl', join(ROOT_DIR, 'logs'), 8 * 1024 * 1024],
];

export function rotateOversizedLogs(cfg) {
  const pondLogs = join(bridgeDirs(cfg).base, 'logs');
  const touched = [];
  for (const [f, dir, cap] of LOG_FILES) {
    const full = join(dir ?? pondLogs, f);
    try {
      if (!existsSync(full) || statSync(full).size <= (cap ?? ROTATE_BYTES)) continue;
      const old = full + '.1';
      if (existsSync(old)) { try { renameSync(old, full + '.2'); } catch { /* .2 被占则放弃本轮 */ } }
      const kb = Math.round(statSync(full).size / 1024);
      renameSync(full, old);
      touched.push(`${f}(${kb}KB)`);
    } catch { /* 并发持有/已消失——下轮再试 */ }
  }
  if (touched.length) log('rotate', `日志轮转：${touched.join('、')} → *.1`);
  return touched.length;
}
