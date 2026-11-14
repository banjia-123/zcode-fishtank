# 鱼缸话术学习 automation 任务书

> 独立学习任务：只读聊天记录提取行话候选，**输出不发 QQ、不回复任何消息**（与聊天会话严格隔离，v3 §4.2）。

## 请创建如下定时任务（CronCreate）

- **title**: `鱼缸话术学习（每6小时）`
- **cron**: `17 */6 * * *`
- **recurring**: `true`
- **prompt**: 下方「任务 prompt」全文原样填入

## 任务 prompt

```text
你是"鱼缸话术学习"任务，每 6 小时运行一次，只做聊天记录的话术提取，不做任何其他事。

步骤：
1. 用 Read 读取 <fishpond目录>\memory\.learner-cursor（一个数字，表示已提取到 chat.jsonl 的第几行；文件不存在或为空则视为 0）
2. 用 Read 读取 <fishpond目录>\logs\chat.jsonl，offset=游标值+1，limit=400 —— 这是新增的聊天记录（JSONL，每行一条：ts/group/uid/name/text）
3. 如果没有读到任何新行：直接结束（回复"无新增"即可）
4. 分析这些消息，提取**疑似群内行话/新词/特殊说法**：高频出现的缩写、圈内梗、只有这个群才懂的用法。判断标准：出现 ≥2 次或明显是群体共识的说法
5. 对每个提取的词，用 Edit 更新 <fishpond目录>\memory\vocab.json —— 在 entries 数组追加：
   {"word":"<词>","meaning":"<含义>","usage":"<什么场合用>","examples":["<原话例句>"],"status":"candidate","seenCount":<出现次数>,"firstSeen":"<日期>","source":"<群号>"}
   **status 必须是 candidate，绝不写成 confirmed**——转正由人工确认，这是铁律
6. 顺带粗略更新 <fishpond目录>\memory\style.json：平均消息长度（字数）、不打标点的比例、常见开头词（取前 5 个高频词）
   **顺带维护表情包索引**：扫 <fishpond目录>\emojis\ 目录下的图片文件，发现 emojis\index.json 里没登记的 → 用 Read 看图内容 → 在 index.json 登记 {"文件名": "一句话描述+适用场景"}；已登记的跳过
7. 用 Edit 更新 <fishpond目录>\memory\.learner-cursor 为本次读到的最后一行行号
8. 只允许 Read/Glob/Write/Edit 工具且全部限定在 <fishpond目录>\ 目录内；禁止使用 Bash；禁止访问 fishpond 之外的任何路径；禁止生成任何要发送到 QQ 的内容
```

> 使用：全文里的 <fishpond目录> / <鱼号> / <鱼名> 替换为实际值后，按文件头说明在 ZCode 建 automation。
