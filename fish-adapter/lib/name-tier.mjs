// 名字触发三档（S2.6）：把原来 text.includes(botName) 的一刀切拆成——
//   tier 1 必回：名字前后都是边界（消息开头/结尾/标点/空白）→ 置 mustReply，走短窗
//   tier 2 可沉默：名字命中但在句中（前后贴着别的字）→ 只软唤醒，模型可回 [SILENT]
//   tier 0 不算：命中屏蔽短语（伊丽莎白圈/伊莎贝拉…）→ 不触发名字逻辑
// 规则：长名在前排序 → 天然「最长优先」，一条消息只返回一次（「伊莎」撞「伊丽莎白」不会算两次）
// 附带 tier2 自动退避（防群里聊英国王室把鱼刷醒）：连续 3 次沉默 → 30 分钟内 tier2 静音
import { readPeer, updatePeer } from './peer-store.mjs';

const BOUND = new Set([...' \t\n\r，。！？、；：“”‘’（）《》【】〈》, .!?;:()[]{}~—…·/|\\@#*']);
const isBound = (ch) => ch === undefined || BOUND.has(ch);

// 敬称后缀（实测盲区：「臣一片赤胆忠心啊伊丽莎白大人」被判 tier2 装死）——
// 名字后紧跟敬称直到句尾（或敬称后接标点）= 句尾直呼，视同 tier1。
// 王室类（女王/陛下/殿下）故意不收：「伊丽莎白女王/二世」是屏蔽短语场景，别给王室话题开门
const HONORIFIC = ['大人', '酱', '姐', '桑', '老师', '同学', '小姐', '先生'];

// 屏蔽固定搭配：用等长占位符替换，避免替换后字符位置错位导致边界误判
function maskPhrases(text, phrases) {
  let s = text;
  for (const p of phrases) {
    if (p) s = s.split(p).join('□'.repeat(Array.from(p).length));
  }
  return s;
}

export function detectNameTier(text, names = [], phrases = []) {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => Array.from(b).length - Array.from(a).length); // 长名在前
  const masked = maskPhrases(String(text ?? ''), phrases);
  const chars = Array.from(masked);
  for (const name of sorted) {
    const nc = Array.from(name);
    for (let i = 0; i + nc.length <= chars.length; i++) {
      if (nc.every((c, k) => chars[i + k] === c)) {
        // tier1：名字紧贴消息开头或结尾（「问一下伊丽莎白」= 句尾喊她，S2.16 验收标准），
        // 或前后都是标点/空白（「@伊丽莎白 在吗」「哈哈，伊丽莎白，你说」）；
        // 或名字+敬称后缀收尾（「伊丽莎白大人」「伊莎酱~」——中文里这也是直呼）
        const atStart = i === 0;
        const atEnd = i + nc.length === chars.length;
        const rest = chars.slice(i + nc.length).join('');
        const honorificEnd = HONORIFIC.some((h) => rest === h
          || (rest.startsWith(h) && isBound(chars[i + nc.length + Array.from(h).length])));
        if (atStart || atEnd || honorificEnd || (isBound(chars[i - 1]) && isBound(chars[i + nc.length]))) {
          return { tier: 1, name };
        }
      }
    }
  }
  for (const name of sorted) {
    if (masked.includes(name)) return { tier: 2, name };
  }
  return { tier: 0, name: null };
}

// —— tier2 自动退避（状态在 state/peers/<peerKey>.json 的 nameSoft 字段）——
// 调用时机（S2-E 接线）：wake 返回后按「批内含 tier2」结算——
//   模型 [SILENT] → noteNameOutcome(chatKey, true)；有实际回复 → noteNameOutcome(chatKey, false)
// tier1（@/边界命中）永不受退避影响——真 @ 她永远必回，这里没有 tier1 的入口
export function isNameMuted(chatKey) {
  const ns = readPeer(chatKey).nameSoft;
  return Boolean(ns && Number(ns.mutedUntil) > Date.now());
}

export function noteNameOutcome(chatKey, silent) {
  updatePeer(chatKey, (p) => {
    const ns = p.nameSoft ?? (p.nameSoft = { streakSilent: 0, mutedUntil: 0 });
    if (silent) {
      ns.streakSilent = Number(ns.streakSilent || 0) + 1;
      if (ns.streakSilent >= 3) {
        ns.mutedUntil = Date.now() + 30 * 60 * 1000; // 静音 30 分钟
        ns.streakSilent = 0;
      }
    } else {
      ns.streakSilent = 0; // 有实际回复，计数归零
    }
  });
}
