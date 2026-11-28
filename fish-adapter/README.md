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

出站  [SILENT] → 禁词 → 出站审计(整条丢弃 fail-closed) → 表情硬闸+同图冷却(600s)
      → 限额(检查即预占额度) → 引用概率化(@不挂/多人批必挂/慢回复必挂/闲聊20%) → 拟真打字分段 → NapCat HTTP:3000 发送
```

老链路（信箱轮询 `.inbox/.outbox ⇄ ZCode 会话`）已退役：outbox 轮询代码保留作回滚路径，
inbox 仅做留档与滚动清理。webhook 链路（POST ZCode `/api/bots/webhook` 入站 + `/zcode`
出站回调）已于 2026-11-28 整条切除——**`patrol.enabled: true` 是主开关，`patrol.cliPath`
（ZCode CLI 的 zcode.cjs 路径）为必填键，缺了启动即拒绝**。

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

## 开发与测试纪律（环境坑清单）

> 本包的运行形态是"**仓库副本开发，部署区运行**"——两份目录，纪律如下。这些是实战踩出来的坑，
> 不看直接动手大概率会撞。

1. **双目录纪律**：`zcode-fishtank/`（仓库）只做开发与 git；真实运行的是工作区下的
   `fish-adapter/`、`console/`、`fishpond/`（部署区）。改代码的固定流程：
   **仓库副本改 → `cp` 绝对路径同步部署区 → 重启 → 验证 → commit**。
   ① cp 一律用绝对路径（相对路径在 PowerShell 下会被吃掉一层）；② 严禁直接改部署区
   （下次同步会被仓库副本覆盖丢失）。
2. **全套测试必须在部署区跑**：`test-wake.mjs` / `test-adapter.mjs` 在仓库副本会因
   spawn 环境差异（cliPath/mock 路径解析）失败——不是代码问题，是测试对运行目录的假设。
   验证以 `部署区/fish-adapter` 下 `node test-*.mjs` 全绿为准。
3. **测试隔离**：测试经 `test-setup.mjs` 把 `FISH_ADAPTER_ROOT` 指向一次性临时目录；
   测试端口专用 3298/3299（避开生产 3200/3201 与 NapCat 3000/3001）。
4. **Windows/PowerShell 坑**（写 .ps1 或 inline 时）：
   - 无 BOM UTF-8 文件按 ANSI 读——`.ps1` 里的中文注释会炸字符串终止符，**脚本一律纯 ASCII**
   - 复杂脚本写成 `.ps1` 文件执行，不要 inline（bash `$_`/反引号会被两层壳吃掉）
   - 中文路径的 `Start-Process` 乱码——用 `node -e` spawn 代替
5. **Git Bash 坑**：`/tmp` 是 MSYS 路径，node 读到的是 `D:\tmp`——临时文件放工作区或走管道；
   `cmd | tail` 后 `$?` 是 tail 的退出码，要真实退出码就分开跑。
6. **热读缓存**：config/persona/名册等热文件全部 mtime 缓存（mtimeNs+size 双键）——改完
   文件即刻生效无需重启，但同毫秒内二次覆写同一文件在测试里要注意（现键已根治撞车）。

## 备份与恢复（2026-11-28）

**人工节奏快照**（2026-11-28 裁决：无自动任务计划；`backup.mjs --uninstall` 已移除注册，想恢复自动随时 `--install`）到 `工作区/fishpond-backup/backup-YYYY-MM-DD/`，保留 14 份；控制台运维页可手动「立即备份」。

- **备份内容**（白名单式，`--list` 可自查）：`fishpond/memory/**`（记忆/行话/名册/游标/队列/全部 .bak）、`persona.md`、`diary/**`、`emojis/**`、`.learner-prompt.md`/`.diary-prompt.md`、`fishpond/logs/**`（chat.jsonl 聊天史 / speak.jsonl 冷却+统计源）、`fishpond/state/**`（便签）、`fish-adapter/logs/` 留痕本体（wake.jsonl/audit.log/sessions.jsonl/diary-deleted.jsonl/chat-test.jsonl）+ 每份快照带 `manifest.json`（文件清单/字节数）
- **明确不备**：`config.json` 与 `fish-adapter/backups/`（含 NapCat token 与各厂商 key——密钥不落第二处，盘坏后重配 token 约 5 分钟）；attachments/.inbox/.outbox（短缓存）；adapter.log/wake-trace.jsonl（可丢大日志）
- **忘记防线**：控制台运维页状态行显示"距上次备份 N 天"（≥3 天警示色）——人工模式的唯一安全网是看到它；`备份.cmd` 双击兜底。
- **恢复（灾难手册）**：
  1. 重装 ZCode/NapCat/适配器（仓库克隆 + config.example.json 重填 token）
  2. 从快照按原相对路径覆盖回：`fishpond/**` → `fishpond/`，`fish-adapter/logs/**` → `fish-adapter/logs/`
  3. ⚠️ **`.learner-cursor`/`.diary-cursor` 必须与 `chat.jsonl` 成对恢复**——游标是 chat.jsonl 的绝对行号，单恢复一边会漂移：游标新于聊天史=永远追不上学习积压；游标旧于聊天史=重复提炼旧消息
- **局限（诚实声明）**：C:/D: 是同一块物理盘——本备份防误删/防分区损坏，**不防整盘死**。`backup.mjs --run --dest <外置盘目录>` 预留了第二目的地参数，插外置盘加一行任务计划即可升级为异地容灾。

## 安全设计（fail-closed 清单）

- `allowAllWhenEmpty` 必须为 `false`，启动强制校验；`allow.groups/private` 形状校验（缺/坏拒绝启动）
- 出站敏感信息**整条丢弃**不脱敏；审计记录在 `logs/audit.log`
- 入站正文与引用属性全部转义，防群友伪造 `</group_message>` / `mentioned="true"`
- 唤醒零工具：`DENY_ALL` 钉死全部已知工具（含 MCP 插件全量），名单外工具由小时级自检抓漏
  并熔断（历史上已四抓漏禁——ZCode 升级后瞄一眼自检日志）
- 管理命令（/reset）非 owner 直接丢弃且不回复
