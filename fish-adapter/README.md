# fish-adapter — QQ ⇄ ZCode 桥（P0）

架构（**file 桥模式**，ZCode 3.17.1 的 webhook 入站传输层未实装，见施工总安排 P0-5 判定）：

```
QQ群/私聊 ⇄ NapCat(OneBot v11) ⇄ 本适配器 ⇄ fishpond\.inbox / .outbox ⇄ ZCode 会话(automations)
```

```
入站  NapCat WS:3001 → 自身过滤 → 白名单(fail-closed) → 去重(5min)
      → 管理命令拦截(/reset 仅 owner) → 引用解析(get_msg) → @判断
      → 边界标记包裹 → 写 .inbox\<ts>-<msgid>.json

出站  轮询 .outbox(1s) → [SILENT] → 禁词 → 审计(整条丢弃)
      → 限额(2条/消息, 1条/群/分, 200/日) → 删 outbox+联动删 inbox
      → NapCat HTTP:3000 发送（失败重试≤3次）

webhook 模式（POST :3200/zcode → 验签 → 出站链路）代码保留，
config.bridge.mode 改回 "webhook" 即可用（等 ZCode 实装入站后）。
```

## 文件

| 文件 | 作用 |
|---|---|
| `adapter.mjs` | 主入口：HTTP 服务 + 装配（file 桥 / webhook 双模式） |
| `lib/onebot.mjs` | OneBot v11 WS 客户端（自动重连）+ HTTP action |
| `lib/inbound.mjs` | 入站链路（含去重、白名单、管理命令；终点按 mode 分流） |
| `lib/outbound.mjs` | 出站核心 `processMessage`（HTTP 与文件桥共用） |
| `lib/bridge.mjs` | 文件桥：inbox 写入 + outbox 轮询 + inbox 联动清理 |
| `lib/util.mjs` | 日志（`logs/adapter.log`）、审计（`logs/audit.log`）、文本化、转义 |
| `config.json` | 全部配置（**含 token，绝不能放进 fishpond**） |
| `start.cmd` | 启动脚本 |

## 部署步骤（对应施工总安排 P0-1 ~ P0-6）

1. **NapCat**：小号登录 → OneBot v11 开 WS `127.0.0.1:3001` + HTTP `127.0.0.1:3000`，设 accessToken
2. **填 config.json**：
   - `onebot.accessToken` / `onebot.selfId`（`GET :3000/get_login_info` 的 `user_id`）
   - `allow.groups` / `allow.private`：白名单群号/私聊 QQ
   - `ownerQQ`：主号（管理命令唯一使用者）
   - `botName`：鱼的名字（P2 定；为空则不做名字匹配）
   - `zcode.secret` 已生成：`e78209bd2b14c7b70cd0b48afbd0adae4055bbe620c565ed`（ZCode 侧填同一个）
3. **ZCode bot**（设置 → 机器人 → 新建，provider=webhook）：
   - `webhookUrl` = `http://127.0.0.1:3200/zcode`
   - secret 同上；`allowedWorkspaces` = `["fishpond"]`（**绝不能留空，空 = 全放行**）
   - `permissionMode` 显式 `guarded`
   - 记下生成的 `botId` 填回 config
4. **回查 ZCode 入站端口**：配置 bot 后 `netstat -ano | findstr ZCode`（或逐个试 127.0.0.1 监听端口），把 `<ZCode入站端口>` 换成实际端口：
   `zcode.callbackUrl` = `http://127.0.0.1:<端口>/api/bots/webhook`
5. **启动**：双击 `start.cmd`（占位符没填完会拒绝启动——这是设计行为）

## 自检与联调

- `curl http://127.0.0.1:3200/health` → `ok`
- 按施工总安排 §2 P0-6 跑规格 §7.1 验收（7 条：群收发、私聊收发、引用、去重、非白名单无反应、[SILENT] 不出群）
- 出站报文字段若对不上（`missing-chat-id` / `missing-user-id` 频繁出现）：看 `logs/adapter.log`，对照 ZCode 实际出站报文调整 `outbound.mjs` 的字段解析

## 安全设计（fail-closed 清单）

- `allowAllWhenEmpty` 必须为 `false`，启动时强制校验，空白名单 = 全拒
- 配置占位符未填完拒绝启动；`ownerQQ` 未填则管理命令全部拒绝
- 出站敏感信息**整条丢弃**不脱敏；审计记录在 `logs/audit.log`
- 入站正文与引用属性全部转义，防群友伪造 `</group_message>` / `mentioned="true"`
- 管理命令不经过模型；非 owner 直接丢弃且不回复
