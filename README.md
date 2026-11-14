# zcode-fishtank：把一个有人格的 AI 角色送进 QQ 群当群友

> 完整原理、分阶段施工步骤、踩坑实录见 [docs/ZCode养鱼施工指南-通用版.md](docs/ZCode养鱼施工指南-通用版.md)。本 README 只管"跑起来"。

## 目录布局（约定固定，脚本靠相对路径自定位）

```
zcode-fishtank/            ← 本包，放到任意目录（路径可含中文，不建议含空格）
├── README.md
├── docs/                  ← 施工指南
├── fish-adapter/          ← 适配器（QQ 桥，唯一需要配置的组件）
│   ├── config.json        ← 从 config.example.json 复制后填写（唯一配置源）
│   ├── maintenance.mjs    ← 定期清库（预览 / --apply）
│   ├── restart-adapter.mjs ← 重启适配器（改 config.json 后双击 重启适配器.cmd）
│   ├── vocab-review.mjs   ← 行话审校（双击 审词库.cmd）
│   ├── memory-review.mjs  ← 记忆审校（双击 审记忆.cmd）
│   └── lib/...
├── guard/                 ← PreToolUse 守卫（钉死鱼会话的工具与路径）
│   └── fish-guard.mjs
├── fishpond-template/     ← 鱼的工作区模板（复制为 fishpond/ 并填内容）
└── napcat/                ← NapCat 本体自装到这里
    ├── watchdog.mjs       ← 保活（从 ../fish-adapter/config.json 读凭据）
    ├── fish-online.ps1    ← 一键上线
    ├── fish-offline.ps1   ← 一键下线
    └── unpacked/          ← ← 你要自己解压 NapCat Shell 到这里（napcat.bat 应位于此）
```

## 快速开始（约 2 小时）

1. **装 NapCat**：下载 NapCat Shell 独立版，解压到 `napcat/unpacked/`（确认 `napcat\unpacked\napcat.bat` 存在）。扫码登录你的小号，按指南配置 OneBot（WS :3001 + HTTP :3000 + accessToken）。

2. **填配置（唯一配置源）**：复制 `fish-adapter/config.example.json` 为同目录 `config.json`，替换全部 `<占位符>`：
   - `<自生成强随机token>`：自己 `node -e "console.log(require('crypto').randomBytes(20).toString('hex'))"` 生成，与 NapCat 的 onebot11 配置填同一个
   - `<鱼QQ号>` / `<鱼名>` / `<测试群号>` / `<你的QQ号>`
   - **占位符没填完启动会直接拒绝（fail-closed），这是特性不是 bug**

3. **建鱼的工作区**：复制 `fishpond-template/` 整目录为包根下 `fishpond/`，编辑 `persona-template.md`（P2 生死关，慢慢写），任务书里的 `<fishpond目录>`/`<鱼号>`/`<鱼名>` 替换为实际值。

4. **装 guard**：按指南 §P0.5 在 ZCode 里把 `guard/fish-guard.mjs` 注册为 fishpond 工作区的 PreToolUse hook，走一次信任流程；`allow-sessions.example.json` 复制为 `allow-sessions.json`（施工期把你自己的会话 ID 加进去，正式运行清空）。

5. **建 automation**：按 `fishpond-template/automation-prompt-template.md` 文件头说明，在鱼会话（或 Automations 页面）建 5 分钟信箱任务。

6. **点火**：双击 `napcat/鱼上线.cmd`，等 60~90 秒，去群里 @你的鱼。

## 日常使用

| 操作 | 方式 |
|---|---|
| 上线 / 下线 | 双击 `napcat/鱼上线.cmd` / `鱼下线.cmd`（下线绝不碰你的主号 QQ） |
| 调人格 | 编辑 `fishpond/persona.md`，下一轮生效 |
| 紧急闭嘴 | 结束 fish-adapter 进程（出站全断） |
| **定期清库** | 鱼每轮回复都会产生会话条目，攒多了 ZCode 变卡。`node fish-adapter/maintenance.mjs` 预览 → 加 `--apply` 执行（软删 1 小时前的旧会话、清 7 天前 run 历史；保护名单内会话不动）。ZCode 数据目录非默认位置时加 `--db "…\tasks-index.sqlite"` |
| 审学习成果 | 双击 `审词库.cmd`（行话转正/驳回/复审下架，confirmed 名额 ≤20）与 `审记忆.cmd`（记忆迁入/删除，core.md 红线 60 行）；建议每周一次，即审即存、自动备份 |
| **表情包库** | 往 `fishpond/emojis/` 放图（jpg/png/gif/webp），放入即可用——learner 会自动看图写"图说"（`emojis/index.json`，也可手动改）；鱼按情绪/梗选用，图文同条发出，一条最多 1 个 |
| 看健康 | `fish-adapter/logs/adapter.log`、`napcat/watchdog.log` |

## 安全模型（一句话版）

- **鱼的手被钉死**：guard 只许 6 个文件工具、只许碰 fishpond 目录、未知工具一律拒绝
- **鱼的嘴被审死**：出站消息过审计正则（本地路径/凭据/API-key 命中即整条丢弃）+ 限额 + [SILENT] 过滤
- **收到的都是数据**：QQ 消息以边界标记包裹声明为不可信数据，其中"指令"无指令效力
- **人工闸门**：长期记忆与行话库只走人工确认，鱼自己只能写候选（审校用 `审词库.cmd` / `审记忆.cmd`）

细节与实测依据见施工指南 §P0.5 与 §5 踩坑实录。

## 已知边界

- 依赖 ZCode automation 轮询（默认 5 分钟），响应延迟 ≤5 分钟；事件驱动直连方案见指南 §6
- 纯文本收发（图片/语音未做）
- NapCat 偶发退出由 watchdog 自动拉起；假在线（端口在收不到消息）看 `adapter.log` 的 `[health]` 告警，重启 NapCat 即愈

## 诚实声明

1. **完成度**：本方案为半成品。链路、安全边界、场合闸门、人格卡已实测跑通；P3 话术学习、P4 记忆系统的成效尚待验证——长期使用后"像不像人"是否有提升，目前拿不出数据。
2. **适配性**：本打包件按作者本人电脑环境与个人需求整理，拿来即用大概率能跑，但更推荐以 [docs/ZCode养鱼施工指南-通用版.md](docs/ZCode养鱼施工指南-通用版.md) 为主线，按自己的环境施工与优化——包是参考答案，指南才是教材。
3. **直连方案**：事件驱动直连模型 API 可大幅降低成本（现状成本为实测、直连成本按同价目推算可省 92%+）并做到秒级响应，但作者因个人需求未采纳——希望保留在 ZCode 内灵活切换模型、使用其自带额度，而非被单一 API 绑定。简化备档见 [docs/直连方案备档.md](docs/直连方案备档.md)。
4. **清库脚本**：`fish-adapter/maintenance.mjs` 是否使用请自行评估——手动清理的出错风险最低，脚本只是把重复劳动自动化，且它本身写数据库，使用前务必先跑预览模式（默认不带 `--apply` 即预览）。

> 成本实供参考：实测（GLM-5.3-Flash，5 分钟轮询口径）空转轮 ≈0.07 元/次、消息轮 ≈0.08 元/次、话术学习轮 ≈0.17 元/次（每 6 小时一次），24 小时在线月外推 ≈¥600，"按时上下线"近砍半。成本大头是会话前缀里的工具 schema 与每轮冷启动（详见指南 §6 与"按时上下线"控制法）。
