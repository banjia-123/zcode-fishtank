# fish-adapter — QQ ⇄ ZCode 桥

当前架构（**秒回巡逻链路**，2026-11-21 起为唯一活跃链路）：

```
QQ群/私聊 ⇄ NapCat(OneBot v11 WS:3001) ⇄ 本适配器 ⇄ ZCode app-server 子进程（零工具唤醒）
```

```
入站  NapCat WS → 白名单(fail-closed) → 去重 → 名字分级(@必回/句中名想接就接)
      → 引用解析 → 图片下载(attachments/ + 图片池) → 攒批(普通 5s / @ 1.5s)
      → inbox 留档（只存档，消息不进信箱）

唤醒  攒批到期 flush → buildPrompt(persona + 规则 + 长期记忆/行话/名册 + 便签 + 表情索引 + 消息段)
      → FIFO 闸门(本地拦截不花钱：静默时段/日限/私聊限额)
      → spawn 常驻 ZCode app-server 子进程, session/send + DENY_ALL 零工具
      → session/event 收回复与 usage → 小时级工具面自检+熔断兜底

出站  [SILENT] → 禁词 → 出站审计(整条丢弃 fail-closed) → 表情硬闸
      → 限额(检查即预占额度) → 拟真打字分段 → NapCat HTTP:3000 发送
```

老链路（信箱轮询 `.inbox/.outbox ⇄ ZCode 会话`）已退役：outbox 轮询代码保留作回滚路径，
`bridge.mode` 为 `"file"` 时仅做 inbox 留档与滚动清理。webhook 模式代码亦保留（`config.zcode`
段），当前不使用——**`patrol.enabled: true` 是主开关，`patrol.cliPath`（ZCode CLI 的 zcode.cjs
路径）为必填键，缺了启动即拒绝**。

## 文件

| 文件 | 作用 |
|---|---|
| `adapter.mjs` | 主入口：HTTP 服务 + patrol 装配 + 健康检查/断流补拉 + 自检 |
| `lib/onebot.mjs` | OneBot v11 WS 客户端（自动重连）+ HTTP action |
| `lib/inbound.mjs` | 入站链路（去重/白名单/管理命令/引用/图片下载） |
| `lib/outbound.mjs` | 出站核心 `processMessage`（审计/限额/拟真打字/表情硬闸） |
| `lib/peer.mjs` / `lib/sticky.mjs` | 攒批窗口（D9 排序/满 30 立即 flush）+ 便签注入 |
| `lib/imgpool.mjs` | 按需复核图片池（图话题轮附带几分钟前的旧图） |
| `wake/app-server.mjs` | ZCode app-server 客户端（DENY_ALL 零工具黑名单，崩溃退避重启） |
| `wake/safe.mjs` | 唤醒闸门（FIFO/静默时段/日限）+ wake.jsonl 留痕 |
| `wake/prompt.mjs` | 唤醒 prompt 组装（persona 占位符现填） |
| `lib/bridge.mjs` | 文件桥（inbox 留档 + 退役的 outbox 轮询回滚路径） |
| `lib/util.mjs` / `lib/rotate.mjs` / `lib/ops-log.mjs` | 日志/审计/轮转/运维流水 |
| `config.json` | 全部配置（**含 token，绝不能放进 fishpond**；example 见 config.example.json） |

## 部署要点

1. **NapCat**：小号登录 → OneBot v11 开 WS `127.0.0.1:3001` + HTTP `127.0.0.1:3000`，设 accessToken
2. **填 config.json**（照 `config.example.json`）：`onebot.accessToken/selfId`、`allow.groups/private`
   （fail-closed，空=全拒）、`ownerQQ`、`botName`、`patrol.enabled: true` + `patrol.cliPath`
   （ZCode 安装目录 `resources/glm/zcode.cjs` 的绝对路径——**必填，缺了拒绝启动**）
3. **启动**：上线脚本 `../napcat/fish-online.ps1`（全家桶：NapCat + watchdog + 适配器 + 控制台），
   或单跑 `node adapter.mjs`；重启用 `node restart-adapter.mjs`
4. **自检**：`curl http://127.0.0.1:3200/health` → `ok`；boot 后首轮工具面自检过检（`adapter.log`）

## 安全设计（fail-closed 清单）

- `allowAllWhenEmpty` 必须为 `false`，启动强制校验；`allow.groups/private` 形状校验（缺/坏拒绝启动）
- 出站敏感信息**整条丢弃**不脱敏；审计记录在 `logs/audit.log`
- 入站正文与引用属性全部转义，防群友伪造 `</group_message>` / `mentioned="true"`
- 唤醒零工具：`DENY_ALL` 钉死全部已知工具（含 MCP 插件全量），名单外工具由小时级自检抓漏
  并熔断（历史上已四抓漏禁——ZCode 升级后瞄一眼自检日志）
- 管理命令（/reset）非 owner 直接丢弃且不回复
