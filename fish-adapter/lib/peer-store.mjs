// peer 级持久状态存储（S2.6 退避 / S3.1 便签共用）：fish-adapter/state/peers/<peerKey>.json
// 放适配器 state 下而不是 fishpond/ 里——鱼够不到自己的状态文件（红线：状态文件不进鱼缸）
// peerKey = g_<群号> / p_<QQ号>（下划线：Windows 文件名安全；内存 chatKey 是 g:/p: 冒号形态）
// 读失败 = 空状态（便签丢了 = 失忆不报错，S3.5 验收项）；写 = 临时文件 + rename 原子落盘
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { log, ROOT_DIR } from './util.mjs';

const PEERS_DIR = join(ROOT_DIR, 'state', 'peers');

export function chatKeyToPeerKey(chatKey) {
  return String(chatKey).replace(':', '_'); // g:123 → g_123
}

export function readPeer(chatKey) {
  try {
    return JSON.parse(readFileSync(join(PEERS_DIR, chatKeyToPeerKey(chatKey) + '.json'), 'utf8'));
  } catch (e) {
    // 缺失（S3.5 验收项：新 peer 无状态）静默；损坏要留痕——便签/退避状态失忆无声是排查黑洞
    if (e?.code !== 'ENOENT') log('peer', `WARN peer 状态文件损坏按空处理（便签/退避失忆）: ${chatKeyToPeerKey(chatKey)}: ${e.message}`);
    return {};
  }
}

export function updatePeer(chatKey, mutator) {
  const cur = readPeer(chatKey);
  mutator(cur);
  try {
    mkdirSync(PEERS_DIR, { recursive: true });
    const final = join(PEERS_DIR, chatKeyToPeerKey(chatKey) + '.json');
    const tmp = final + '.tmp';
    writeFileSync(tmp, JSON.stringify(cur, null, 1), 'utf8');
    renameSync(tmp, final);
  } catch { /* 落盘失败不阻断（本次判定用内存值，下次再落） */ }
  return cur;
}
