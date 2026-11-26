// 图片复核池（2026-11-26 按需复核）：入站图下载成功时入池（per-peer、新挤旧、上限 2 张），
// 唤醒组装附件时若本批是图话题（消息文本含"图/photo/pic"），把池内 TTL 内的旧图重新附带——
// 修复两类失明：①图与话被攒批窗切开（图先发、话后到的那批无图）②首轮消费后无法复核
// （群友纠错"再对一遍"时她看不到已随首批消失的图）。
// 纯内存：重启即清（TTL 仅 5 分钟，可接受）；无消费标记——话题驱动，聊图就带、离题自停。
const pool = new Map(); // chatKey -> [{ rel, ts }]
const PER_PEER_MAX = 2;
const TTL_MS = 300_000;

export function recordImg(chatKey, rel, ts = Date.now()) {
  if (!chatKey || !rel) return;
  const arr = (pool.get(chatKey) ?? []).filter((x) => x.rel !== rel);
  arr.push({ rel, ts });
  while (arr.length > PER_PEER_MAX) arr.shift(); // 新挤旧：复核场景只关心最近的图
  pool.set(chatKey, arr);
}

/** 取该 peer TTL 内的图（顺带清过期）。返回相对路径数组。 */
export function pickImgs(chatKey, { ttlMs = TTL_MS } = {}) {
  const arr = (pool.get(chatKey) ?? []).filter((x) => Date.now() - x.ts <= ttlMs);
  pool.set(chatKey, arr);
  return arr.map((x) => x.rel);
}

/**
 * 图话题判定 + 池图追加名单（纯逻辑，可单测）：
 * 本批消息文本命中图话题粗判（中文聊图必带"图"字；误触发无害——看得到但可无视）时，
 * 返回池内 TTL 内、未在 existingFilenames 里的图（filename 已含 msgid，天然跨批不重）。
 */
export function poolExtrasFor(batch, chatKey, existingFilenames) {
  const isImgTopic = (batch ?? []).some((m) => /图|photo|pic/i.test(String(m.text ?? '')));
  if (!isImgTopic) return [];
  const known = new Set(existingFilenames ?? []);
  return pickImgs(chatKey)
    .map((rel) => rel.split('/').pop())
    .filter((f) => !known.has(f));
}
