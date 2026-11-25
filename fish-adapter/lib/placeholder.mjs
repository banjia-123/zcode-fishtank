// 提示词占位符（2026-11-25，借鉴 dsh-sansan-qq 的运行时填充思想）：模板只写占位符，
// 真实值组装 prompt 时才注入——部署区模板天然干净（与仓库形态统一），sanitize 从
// 转换防线降级为提交前检查器；新用户施工也不必手改模板，config 填对即生效。
// 词汇表沿用既有约定：sanitize-tasks-manual.mjs 的占位符 + fishpond-template 模板同款 <中文词> 形态。
// 纯函数零依赖：适配器（wake/prompt.mjs）与控制台（server.mjs 跨包 import）共用。
export const PLACEHOLDER_KEYS = [
  '<fishpond目录>', '<fish-adapter目录>', '<zcode数据目录>',
  '<鱼QQ号>', '<鱼号>', '<你的QQ号>', '<鱼名>', '<群号>',
];
// <鱼号> 与 <鱼QQ号> 同义：fishpond-template 模板用前者、tasks-manual 用后者——两个都认

// 占位符 → 实值。values: { '<鱼QQ号>': '123', ... }（调用方从 config 构造，缺项跳过不替换）
export function fillPlaceholders(text, values) {
  let s = String(text ?? '');
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v != null && String(v) !== '') s = s.split(k).join(String(v));
  }
  return s;
}

// 实值 → 占位符（反向，归档入口净化用：apiTaskRemove 从 sqlite 归档的 prompt 可能带真实值）。
// 长值先换（防前缀包含关系），与 sanitize 脚本同策略；值缺失的键跳过。
export function toPlaceholders(text, values) {
  let s = String(text ?? '');
  const entries = Object.entries(values ?? {})
    .filter(([, v]) => v != null && String(v) !== '')
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [k, v] of entries) s = s.split(String(v)).join(k);
  return s;
}
