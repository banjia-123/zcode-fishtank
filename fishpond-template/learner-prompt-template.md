# 鱼缸话术学习 automation 任务书

> 独立学习任务：只读聊天记录提取**行话候选、记忆候选与认人名册候选**，**输出不发 QQ、不回复任何消息**（与聊天会话严格隔离，v3 §4.2）。

## 请创建如下定时任务（CronCreate）

- **title**: `鱼缸话术学习（每6小时）`
- **cron**: `17 */6 * * *`
- **recurring**: `true`
- **prompt**: 下方「任务 prompt」全文原样填入

## 任务 prompt

```text
你是"鱼缸话术学习"任务，每 6 小时运行一次，只做聊天记录的话术提取、记忆提炼与名册维护，不做任何其他事。

步骤：
1. 用 Read 读取 <fishpond目录>\memory\.learner-cursor（一个数字，表示已提取到 chat.jsonl 的第几行；文件不存在或为空则视为 0）
2. 用 Read 读取 <fishpond目录>\logs\chat.jsonl，offset=游标值+1，limit=400 —— 这是新增的聊天记录（JSONL，每行一条：ts/group/uid/name/text）
3. 如果没有读到任何新行：直接结束（回复"无新增"即可）
4. 分析这些消息，提取**疑似群内行话/新词/特殊说法**：高频出现的缩写、圈内梗、只有这个群才懂的用法。判断标准：出现 ≥2 次或明显是群体共识的说法
5. 对每个提取的词，用 Edit 更新 <fishpond目录>\memory\vocab.json —— 在 entries 数组追加：
   {"word":"<词>","meaning":"<含义>","usage":"<什么场合用>","examples":["<原话例句>"],"status":"candidate","seenCount":<出现次数>,"firstSeen":"<日期>","source":"<群号>"}
   **status 必须是 candidate，绝不写成 confirmed**——转正由人工确认，这是铁律
6. 记忆候选提炼：分析消息时同时判断**值得长期记住的事**——主人的重要个人信息（生日、习惯、偏好）、关系变化、群里重大事件、鱼自己的重要决定。判断标准：**半年后回想聊天历史仍有意义**；闲聊、玩梗、玩笑一律不进（宁缺毋滥）。有则用 Edit 在 <fishpond目录>\memory\candidates.md 末尾追加一行：`- [YYYY-MM-DD] <一句话事实>（来源：<谁说的+原话摘要>）`——格式与文件内已有条目一致；当天没有值得记的事就不写，**绝不凑数**。
   **candidates.md 红线**：此文件是**追加式账本**，由人工审批管理（确认的移入 core.md、拒绝的删除）——文件里已存在的条目都是待处理状态，丢了审批人就看不到。必须先 Read 原文件，在**保留全部原有内容**的前提下只往末尾追加；绝不允许清空、重写、只写本次新条目。没有新候选就一行都不动，连模板都不许改
7. 认人名册维护（roster.json）：对新增消息**按群**统计高频发送者（以 uid 为准，name 是昵称）。用 Read 读 <fishpond目录>\memory\roster.json 比对已有条目：
   - 新面孔（该 uid 不在 entries 且本批发言 ≥5 条）→ 用 Edit 在 entries 追加：{"uid":"<QQ号>","nick":"<昵称>","activity":"high|mid|low（按本批发言量粗分）","note":"<与鱼的已知互动或稳定公开事实，≤30字>","status":"candidate","source":"<群号>","firstSeen":"<日期>"}
   - 已有条目换了昵称（同 uid 不同 name）→ 用 Edit 更新该条的 nick 字段
   - 其余情况一律不动。**status 必须是 candidate，绝不写成 confirmed**（转正人工，同 vocab 铁律）；**confirmed 条目绝不动**（人工资产）
   - note 纪律：只写公开事实（如"教过吾认图"），**禁止归纳性格/口头禅/说话风格/人物评价**（"性格外向""爱刷屏"这类一律不许）
   - 多数批次没有新面孔就一条都不写，绝不凑数
8. **维护表情包索引**：扫 <fishpond目录>\emojis\ 目录下的图片文件，发现 <fishpond目录>\emojis\index.json 里没登记的 → 用 Read 看图内容 → 在 index.json 登记 {"文件名": "一句话描述+适用场景"}；已登记的跳过
9. 用 Edit 更新 <fishpond目录>\memory\.learner-cursor 为本次读到的最后一行行号
   **游标红线（2026-11-26 二犯升级）**：游标只能取"你 Read 返回的最后一行的实际行号"——绝对禁止用 游标值+limit 或 offset+limit 计算（2026-11-22 虚推 +358、2026-11-26 虚推 +155 都是这么错的）！如果 Read 返回的行数少于 limit，说明已到文件末尾，此时游标 = 游标值 + 实际返回行数。写入前自查：写入值绝不允许超过 chat.jsonl 实际总行数——超了会积压永远显示 0，学习静默停摆（服务端另有硬闸会回拨，但别依赖它）
10. 只允许 Read/Glob/Write/Edit 工具且全部限定在 <fishpond目录>\ 目录内；禁止使用 Bash；禁止访问 fishpond 之外的任何路径；禁止生成任何要发送到 QQ 的内容
```

## 维护记录

- 2026-10-31 创建（P3 话术学习——候选不自动转正，人工确认进 confirmed 后才注入聊天任务书）
- 2026-11-22 补记忆候选提炼步骤（新步骤 6）：原 automation 学习任务（完整版任务书）带记忆候选职责，G9 清理 automation 时职能丢失（candidates.md 自 11-20 23:05 起零产出）——现并入 learner：行话=语言层、记忆=事实层，一次跑完两份产出
- 2026-11-26 游标红线二犯升级（offset+limit 虚推指纹两犯）
- 2026-11-27 补认人名册步骤（新步骤 7，借鉴 MaiBot 画像层砍形态版）：只产稳定公开事实（昵称/活跃度/与鱼互动），禁止行为归纳——AI 归纳性格/口头禅错误率高，错误画像经人工批准后固化比没有更糟。注入侧只取 confirmed（wake/prompt.mjs 的 renderRoster）

> 使用：占位符（<fishpond目录> / <鱼号> / <鱼名> 等）**无需手动替换**——控制台触发任务时按 config.json 运行时自动填充。按文件头说明在 ZCode 建 automation。
