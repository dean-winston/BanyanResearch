# BanyanResearch · 榕树

支持本地运行与 Cloudflare Serverless 部署的个人研究助手，将外部技术文章、自己的博客和 GitHub 项目联系起来，在网页中解释“为什么这条信息与你有关”。首版覆盖 AI、游戏开发和服务端。

## 启动

需要 Node.js 22 或更新版本，以及已安装、完成登录的 Codex CLI。应用通过独立的 `codex exec` 任务分析资料，不复用当前聊天会话。调用方式参考 [Codex 非交互模式官方文档](https://learn.chatgpt.com/docs/non-interactive-mode)。

```bash
npm install
codex login
npm start
```

打开 <http://127.0.0.1:4173/#inbox>。使用已有 Codex 登录，不需要设置 `OPENAI_API_KEY`。检测到 CLI 不代表登录仍然有效；实际分析失败原因显示在「更新与任务」。

```bash
npm test
```

资料默认保存在 `.data/knowledge.json`，不提交到 Git。备份或迁移时应保留整个数据目录。本地入口适用于单人使用；云端入口另有密码登录。

## 首次使用

### AI 阅读口味（从个人日报任务导入）

「为你推荐」现在按“本轮阅读结论 → 最值得先读 → 少量补充 → 值得深挖的问题 → 折叠历史记录”组织。精选按最近一次采集／重新整理任务归属选取，不再拿昨天的结果冒充本轮；停用来源、旧分析未入选和已经处理的内容不占当前精选。任务失败、部分完成、尚未分析与无合格入选分别说明，来源覆盖只统计本轮实际检查记录。

新分析保存技术增量、证据性质、局限与一个可选的阅读延伸问题。没有证据时明确说缺失，不以分数替代可信度；旧数据缺字段显示待核对，不虚构结论。重新整理历史仅基于已有摘要，需原文细节时仍应打开原文。阅读延伸不会自动加入活跃研究问题。

反馈支持可选原因：内容太浅、重复、缺少技术证据、主题不感兴趣、不信任来源。原因和原有反馈一起保存并供后续分析参考；撤销反馈会清空原因。停用来源的历史文章和反馈继续保留在折叠历史区域。

默认导入“AI 论文与工程日报”的 45 个来源，按个人研究／工程作者、新闻／技术通讯、官方研究／工程区分来源性质。来源与关注范围保存在 `data/reading-preferences.json`，筛选规则在 `lib/reading.js`。导入只补充缺失来源与分类，不覆盖已有网址、订阅、备注或启停设置，也不改动原来的 Codex 定时任务。

推荐优先论文、模型原理、一手技术方法和工程证据，特别是 Agent/Harness 的上下文、外置状态、验证、评测与恢复；个人博客／项目关联是加分项，不再是入选前提。过滤融资八卦、宣传口号与无技术增量热点。采集预算交错分配到个人作者、官方与新闻，避免单类来源占满。

首页展示最近入库日最多 5 条精选，按技术阅读优先级排序，并合并模型判断为同一事件的条目；少于 3 条时不补凑。原有完整推荐列表与反馈继续保留，事件合并仅影响精选展示。重新匹配会使用新规则，旧推荐不会直接当作新口味精选。

本地与云端都会尝试打开候选原文，正文仅用于本轮分析、不持久保存。原文分析最多读取 10,000 字符的文本片段，页面不可读时明确标注仅基于摘要；不声称阅读全文或听完播客。未知发布日期保留未知，未来日期排除。

这次改造并不把网页采集器变成浏览器搜索 Agent：动态页面、访问受限来源及外站延伸链接仍可能漏采。现有采集窗口、每源候选数与每轮分析预算仍生效，尚未实现日报任务中“自上次成功检查以来”的无遗漏增量游标、经典补读或严格每日 9 点交付。部署后需运行更新或重新匹配，才会生成新口味推荐；仅修改代码不代表完成线上发布或来源可访问性验证。

1. 在「研究问题」添加正在探索的问题。博客和项目分析也会提取候选问题，确认并改为“正在研究”后才作为活跃研究问题参与匹配。
2. 在「信息源管理」检查来源清单（含 45 个 AI 阅读偏好来源），编辑备注、订阅地址，启用或停用来源。
3. 点击「立即更新」同步博客、采集外部信息并形成推荐；在「更新与任务」查看进度及错误。
4. 在「我的研究」手动同步 GitHub 项目。首次分析按每轮预算处理；再次同步或单独点击“分析项目”可继续处理。
5. 为推荐标记“有用、不相关、已了解、稍后看”。后续分析会参考已有反馈；不保证每次反馈立刻改变全部历史推荐。

## 已实现范围与默认值

| 能力 | 当前行为 |
| --- | --- |
| 外部采集 | 只处理已启用来源；支持 RSS / Atom 和网页发现，保留采集成功、无近期内容、失败等状态 |
| 采集范围 | 每个来源默认选取 3 篇候选（可设 1–20），近期窗口默认 30 天（可设 1–365）；每轮最多分析 15 篇，可在后台调整为 1–100 篇 |
| 外部文章入库 | URL、标题、来源、主题、短摘要、结构化问题 / 方法 / 结论、推荐理由和关联依据；不保存外部正文或原文摘录 |
| 博客同步 | 从 `dean-winston/dean-winston.github.io` 同步符合文章元数据规则的 Markdown 全文，以文件版本识别新增或修改 |
| 项目清单 | 枚举 `dean-winston` 的全部公开仓库；Fork 保留清单，不归为个人工程观点；不持续监听仓库变更 |
| 项目分析 | 非 Fork 仓库每轮默认分析 5 个，可调整为 1–20 个；读取当前版本的部分文档和代码证据，保存观点卡、推断标识、提交版本和证据链接 |
| 推荐 | 将外部信息关联到活跃研究问题、博客或项目；支持有技术价值的探索内容、手动重新匹配及反馈 |
| 定时任务 | 默认启用每日更新；仅在本地服务持续运行时执行，可关闭；项目分析始终手动触发 |
| 任务追踪 | 显示进度、部分成功及失败原因；服务重启后的未完成任务标记中断，可手动重新执行 |

每日更新不是精确时刻的云端调度。后台按距上次每日任务的时间检查是否到期；电脑关机或服务停止期间不会执行。采集窗口和分析预算意味着首次更新不保证覆盖全部历史内容。

「知识库」统一展示自动同步资料与手动笔记，支持搜索和文件夹导入。自动派生记录保留来源链接，并在详情中隐藏删除操作。「智能分析」通过同一 Codex CLI 执行层回答资料问题。手动导入属于用户主动保存的资料，与自动外部文章的存储边界分开；文件夹导入最多 300 个文件、8 层目录、每文件 100 KB，修改后需要重新导入。

## 信息源管理

访问 <http://127.0.0.1:4173/#sources>，可搜索、筛选、新增、编辑备注和订阅地址，以及启停。启用不代表采集成功，请查看每个来源的最近采集状态。

- 初始清单：`data/sources.seed.json`，参考 [awesome-ml-blogs](https://github.com/antoinebrl/awesome-ml-blogs)、[awesome-engineering](https://github.com/upgundecha/awesome-engineering)、[Awesome-Gamedev](https://github.com/FronkonGames/Awesome-Gamedev)，并补充官方站点；中文备注由本项目编写。
- 最初的网站检查日期为 2026-10-06；实际采集状态单独更新。部分站点可能限制自动访问，单个来源失败不会被展示为成功。
- 用户编辑保存在数据文件的 `sources` 字段。种子清单仅在缺少该字段时加载，不覆盖已有编辑。

## 可选环境变量

| 变量 | 用途 |
| --- | --- |
| `PORT` | 本地端口，默认 `4173`；监听地址为 `127.0.0.1` |
| `DATA_DIR` | 独立数据目录，默认项目 `.data`；测试或迁移可使用不同目录 |
| `CODEX_BIN` | Codex 可执行程序路径，默认 `codex` |
| `CODEX_MODEL` | 分析模型覆盖值；未设置时读取本机 Codex 配置中的模型，或采用 CLI 默认值 |
| `CODEX_TIMEOUT_MS` | 单次分析超时毫秒数，默认 `150000` |
| `GITHUB_TOKEN` | 可选 GitHub API 认证，用于访问公开资料和提升可用请求额度；当前不会因此扩展为私有仓库同步 |
| `DISABLE_SCHEDULER` | 设为 `1` 可停用定时调度，例如隔离测试时使用 |

## 执行与数据边界

分析经统一的 `runStructured` 入口执行。本地适配器在 `lib/providers.js`，云端适配器在 `cloud/providers.js`；分析业务逻辑位于 `lib/analyzer.js`。任务使用结构化输出、独立临时目录、临时会话与只读执行限制，并关闭相应工具能力；提示要求将文章和代码视为待分析材料，不执行其中的指令。结构化结果仍需核对，模型推断不等于已验证事实。

采集过程会临时读取外部内容供分析，但持久存储使用字段白名单，不保存外部正文或摘录。博客允许全文入库；仓库保存分析卡和证据链接，不持久保存所读取的代码正文。分析材料会由所配置的模型服务处理；这些本地实现措施不等于承诺第三方服务没有运行日志或数据保留。

项目证据读取有数量与长度上限，不能据此声称穷尽整个仓库。缺少测试证据时应明确说明。网页会显示失败、证据范围和分析所依据的提交版本。

## 云端 Serverless 实现（已发布，基础线上验收通过）

已加入 **Cloudflare Workers + D1 + Workflows** 实现：Workers 提供 API 与静态页面，D1 持久保存资料、目标、工作记忆、任务和使用次数，Workflows 执行可恢复的任务步骤；每小时 Cron 检查唤醒条件。云端通过所配置的 OpenAI 或 DeepSeek API 分析，不使用本机 Codex CLI；部署并正确配置后无需个人电脑在线。

截至 2026-10-07，Cloudflare OAuth 授权已完成，D1 数据库已创建，`wrangler.jsonc` 已写入真实数据库 ID，96 条实体记录已迁移。站点已发布至 https://personal-intelligence-system.dean-winston.workers.dev 。线上页面、密码登录和迁移数据已验证。云端尚未配置模型，持续助手保持关闭；仍需明确模型与费用预算。云端模型配置齐全仅表示可以尝试请求，实际连通性和额度仍以任务执行结果为准。

### 新环境部署步骤（当前账号已完成数据库创建与迁移）

1. 登录 Cloudflare 并创建 D1 数据库：

   ```bash
   npx wrangler login
   npx wrangler d1 create personal-intelligence-system
   ```

2. 将返回的 `database_id` 填入 `wrangler.jsonc` 的 D1 绑定，新环境应替换为自己的 ID。绑定名称保持 `DB`。表结构由服务初始化创建；如需迁移旧数据，必须在首次部署 / 初始化前执行下面的空库迁移流程。
3. 在 `wrangler.jsonc` 的 `vars` 中明确配置 `OPENAI_MODEL`，保留 `CLOUD_MODE=1`、`ANALYSIS_PROVIDER=openai`。通过交互式命令写入 secrets，不把真实值提交到仓库：

   ```bash
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   ```

   `ADMIN_PASSWORD` 是网页访问密码；`SESSION_SECRET` 应为独立的高强度随机值，用于签名登录 Cookie。可选 `npx wrangler secret put GITHUB_TOKEN` 提供 GitHub 认证。需要重新登录时可更换会话密钥。
4. 验证并部署：

   ```bash
   npm test
   npm run cloud:check
   npm run cloud:deploy
   ```

   `cloud:check` 是构建 / dry-run 检查，不会证明远程 D1、Workflows、模型或网站已经部署成功。`cloud:deploy` 才会发布 Worker 及绑定配置。
5. 打开实际部署输出的网址，用访问密码登录，先运行少量任务验证，再决定开启持续助手。浏览器使用同源 HttpOnly Cookie，不将访问密码放入 localStorage。云端无法读取个人电脑文件夹，界面禁用本地目录导入；可手动添加知识。

本地模拟云端可用 `npm run cloud:dev`，所需 secrets 可放在仅本机使用的 `.dev.vars` 文件中；不要提交该文件或其内容。

### 持续助手

持续助手默认为关闭。后台保存各角色的目标、工作记忆、上次行动 / 原因、下一次唤醒时间和事件历史；每轮先决定动作，再执行允许的任务，最后记录结果。研究助手可采集、重新关联或等待；写作助手可同步博客或等待；工程助手始终只允许手动分析，不监听仓库。

默认唤醒间隔 24 小时，每日最多 3 次决策、6 次行动。次数由两个自动助手共享，按 UTC 日期重置；后台允许调整。唤醒间隔是最小间隔，助手可选择稍晚再运行；云端 Cron 每小时检查，不保证精确到分钟。开启总开关之后，各角色仍有自己的启用状态。

**次数上限不是金额预算。** 一次行动可能包含多次文章 / 博客模型分析，另有决策本身的模型调用，以及 Workers、D1、Workflows 用量。当前没有按美元或人民币计费的硬停止机制，需先确认模型、可接受费用和供应商侧费用控制，再开启持续运行。原有每日任务在云端默认关闭（`ENABLE_LEGACY_DAILY=false`），避免与持续助手重复；有意启用旧调度时应明确这一选择。

需求与评估标准见 [AC 项目定义](docs/AC-项目定义草案.md)。

### 本地资料迁移到新 D1

当前账号已迁移 96 条实体记录，不应重复执行导入。以下仅用于另一个新建空库，且须在首次 Worker 初始化前执行：

```bash
node scripts/export-cloud.js
npx wrangler d1 execute personal-intelligence-system --remote --file=.data/cloud-import.sql
```

导出脚本仅生成本地私有 SQL，不执行远程操作，支持 `DATA_DIR`，拒绝覆盖已有导出。SQL 包含个人数据，位于 Git 忽略的 `.data`；不要公开。导入命令会写远程数据库，仅在已授权目标数据库时执行。已初始化的数据库会被拒绝导入；失败后应使用新的空库，不向部分导入的库重复执行。

导出保留业务数据和助手记忆，但暂停每日任务与全部助手，清除运行租约、登录尝试及旧决策，将未完成任务标记中断。这样导入不会立即触发模型费用；待远程模型和预算确认后再开启。

### 持续采集的 Cloudflare 计划

现有 21 个来源的采集步骤需要网络访问、解析及状态写入。建议持续采集采用 Workers Paid：Free 的每步 CPU 时间仅 10 ms，外部子请求限制为每次调用 50 次，当前整批采集可能超限；网络等待不计 CPU 时间，但解析仍计入。此建议依据当前实现及 [Cloudflare Workflows 官方限制](https://developers.cloudflare.com/workflows/reference/limits/)，不代表已完成付费计划升级。是否升级由用户决定。

### 当前验证记录

2026-10-07：55 项自动测试通过，本地 Cloudflare 集成脚本通过。集成覆盖登录、D1、同源请求保护、未配置模型时拒绝任务，以及关闭助手情况下的 Workflows 生命周期；不等于远程模型调用或完整采集已经验收。

复现集成时，仅在隔离的 `wrangler dev` 环境配置测试密码 `ADMIN_PASSWORD=local-integration-only`、测试 `SESSION_SECRET`，不配置真实模型密钥，保持助手关闭。启动 `npm run cloud:dev` 后，在另一终端运行：

```bash
node scripts/cloud-smoke.js
```

默认测试端口 8787，可用 `CLOUD_TEST_PORT` 调整。这个公开测试密码仅用于本地集成，不得作为线上访问密码。

### 当前发布记录

- 站点：<https://personal-intelligence-system.dean-winston.workers.dev>
- Worker 版本：`2c4bb949-49c5-4ac5-8614-2aa592f505fe`。
- Workflow：`personal-intelligence-work`；Cron：`0 * * * *`（每小时）。
- D1 数据已迁移；云端模型未配置，持续助手和旧每日任务均关闭。Cron 已注册不代表自动分析已启用。
- 管理员密码仅保存在本机 `.data/cloud-admin-password.txt`，文件权限为 `0600`，不在本文展示。
- `node scripts/verify-cloud.js` 已验证线上 HTML 200、未登录 API 401、正确密码登录成功、各资料集合数量与本地一致，以及持续助手关闭。

线上 Workflow `deployment-smoke-disabled` 已完成，`acquire`、`plan-writing`、`plan-research`、`release` 均成功。该验证保持助手关闭，没有调用模型；证明远程工作流与持久存储链路可运行，不代表文章采集与模型分析的端到端验收。云端 API 模型配置、费用选择及真实分析任务仍待完成。


## 接入 DeepSeek（当前云端配置）

当前部署已选择 `ANALYSIS_PROVIDER=deepseek`、`DEEPSEEK_MODEL=deepseek-flash`。
在 Cloudflare 的 Workers & Pages → personal-intelligence-system → Settings → Variables and Secrets 中添加 **Secret** `DEEPSEEK_API_KEY`，填入自己的 DeepSeek 官方 API Key，然后保存部署。不要放入普通文本变量、Git 或聊天。
也可执行 `npx wrangler secret put DEEPSEEK_API_KEY` 交互输入。

适配器请求 `https://api.deepseek.com/responses`，使用 JSON Schema、禁用工具、限制输出和超时、不自动重试付费请求。配置完整仅代表可以尝试调用；当前通过的是模拟接口测试，真实密钥连通性和分析质量待验证。持续 Agent 不会因为添加密钥自动开启。
参考 [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)。切换回 OpenAI 时需同时修改 `ANALYSIS_PROVIDER` 并配置对应的 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。仓库中的 wrangler 配置是后续部署的配置来源，后台修改模型后也应同步到这里。


### DeepSeek 线上连通性验证

2026-10-07：`DEEPSEEK_API_KEY` 已作为云端 Secret 配置。通过线上 `/api/ask` 用一条196字符的已有摘要完成真实 DeepSeek Flash 分析，HTTP200，返回回答与1条来源。修复 Workers 对请求 redirect 模式的兼容问题，使用 manual 并拒绝重定向；模型错误显示经过清理的提示。模型接口测试10项通过。持续 Agent 保持关闭，尚未验证完整批量采集。用户已修改网页管理员密码，早期本机密码文件不再代表当前登录密码。


## 后台可视化采集规则

「更新与任务」可编辑每来源候选篇数（1–20）、近期范围（1–365天）、每轮文章和项目上限。「持续助手」可编辑自动检查间隔（1–168小时），以及原有总开关、角色开关、唤醒间隔和每日次数上限。设置存入数据库，保存后用于后续任务，不立即触发模型调用。
Cloudflare 的基础时钟保持每小时一次，数据库中的检查间隔控制哪些时钟事件实际检查助手；无需在网页中配置 Cloudflare 管理密钥。最短检查粒度为1小时。修改检查间隔会重置检查计时，从下次整点检查生效；修改唤醒间隔保留已安排的下次唤醒时间，后续计划使用新值。手动唤醒跳过检查间隔，但仍遵守助手自己的下次唤醒时间。
云端隐藏旧每日调度开关，自动运行统一使用「持续助手」。修改采集窗口不会清理已有资料，日期未知文章仍可能保留；超出分析篇数的候选暂不持久排队。

### 2026-10-07 云端采集兼容性修复

DNS 和网页请求统一使用 Workers 支持的 `redirect: 'manual'`，显式检查响应及重定向目标。仅拆分 Workflow 步骤不会重置联网额度，因此新增私有 Service Binding `TASKS` / `IntelligenceTasks`，把信息源发现和文章分析放到独立 Worker RPC 调用中。云端串行更新来源状态以避免 D1 乐观锁争用；本地保留原并发度。

发现阶段仅把标题、链接、来源、日期等元数据写入 Workflow 检查点；分析时在 RPC 内重新读取临时摘要，正文不跨越检查点。保留每来源候选数、近期范围、去重、轮询选取以及每轮分析总预算。博客同步失败会记录警告并继续每日任务的外部采集。

线上任务 `e5e68251-8c8f-4330-8e53-5d4532a0cb22` 检查21个来源，DeepSeek Flash 新增9篇文章；未再出现 redirect 或 subrequest 错误。6个来源返回403/405，任务如实标记部分成功。GitHub博客同步另一次请求返回403，尚不能视为全来源同步成功。65项自动测试通过。此修复没有启用暂停的助手角色，也没有升级 Cloudflare 套餐。

### 官方订阅优先（2026-10-07）

已在种子列表、本地数据库及线上后台配置以下官方订阅：

- OpenAI：`https://openai.com/news/rss.xml`
- InfoQ AI：`https://feed.infoq.com/ai-ml-data-eng/`
- Netflix：`https://netflixtechblog.com/feed`
- Unreal Engine：`https://www.unrealengine.com/rss?lang=en-US`（综合订阅，包含新闻、访谈及技术博客）
- Game Developer：`https://www.gamedeveloper.com/rss.xml`（官方页面公布，但访问仍可能返回403）

Unreal 官方 Atom 响应会在完整 XML 后附加浏览器脚本：解析器只丢弃根元素后的完整 script 元素，随后仍严格校验 XML；不执行脚本，不允许 DTD 或外部实体。新增回归测试覆盖该兼容情况及畸形 XML 拒绝，66项测试通过。AWS Builders Library 暂未找到可用官方订阅/API，保留原来源并在后台备注现状，未以其他 AWS 博客冒充它。

线上验证结果：任务 `4d855bb9-e936-4748-9eca-369ac0b6969a` 通过 OpenAI 和 InfoQ 官方订阅新增6篇文章，任务部分成功。进一步无模型调用的单源检查确认：Netflix 官方订阅云端返回429，Medium官方入口同样跳转至该订阅；Unreal官方订阅跳转登录页后403；Game Developer官方RSS403。不要将“找到官方订阅”标记为“云端可用”。已把这些区别写入来源备注，并保留订阅错误及网页回退错误。新增经过登录校验的 `POST /api/sources/:id/check` 云端检查接口，仅发现元数据并更新来源检查状态，不调用模型或保存正文。来源地址在检查过程中被修改时，不回写旧地址的检查状态。

## GitHub 版本维护与 Cloudflare 自动发布

推荐使用 Cloudflare Workers Builds：GitHub `main` 更新 → Cloudflare 拉取代码 → `npm run cloud:build`（测试与构建检查）→ `npm run cloud:deploy`。测试失败会阻止发布；数据库及已有 Cloudflare Secrets 保留。

在现有 Worker `personal-intelligence-system` 的 Settings → Builds → Connect 中连接 GitHub：

- 仓库：`dean-winston/BanyanResearch`；仅授权这个仓库。
- 生产分支：`main`；根目录：`/`。
- Build command：`npm run cloud:build`。
- Deploy command：`npm run cloud:deploy`。
- Node.js：22（仓库提供 `.node-version`）。关闭非生产分支自动部署，避免修改生产资源。
- 使用 Cloudflare 自动生成的构建部署令牌；模型密钥、后台密码及会话密钥继续保留在现有 Worker 的 Secrets 中。

首次连接需要在网页完成 Cloudflare GitHub App 的仓库授权。以 Cloudflare 构建记录实际成功为启用完成；仅提交配置文件不会完成 GitHub App 的授权。

2026-10-07 曾尝试 GitHub Actions，账号返回“recent account payments have failed or your spending limit needs to be increased”，任务未启动。`.github/workflows/cloudflare.yml` 保留为手动备用，自动触发已关闭，避免持续失败或和 Cloudflare Builds 重复发布。若以后使用该备用流程，须先恢复 GitHub Actions 额度，再配置 GitHub Secret `CLOUDFLARE_API_TOKEN`（当前账号 Workers Scripts Edit、D1 Read、Account Settings Read）及 Variable `CLOUDFLARE_ACCOUNT_ID`。

需要回退时，在 GitHub revert 相应提交并合入 `main`，由 Cloudflare 重新发布。代码回退不会回退数据库内容。

## dots 云端研究工作台

Cloudflare 部署包含 Streamable HTTP MCP：`https://personal-intelligence-system.dean-winston.workers.dev/mcp`。

### 连接

1. 在 ChatGPT → Plugins → Add custom MCP server，填入上面的 URL。
2. 选择 OAuth，动态客户端注册（DCR），public client / `none`；无需粘贴管理员密码或模型 Key 到聊天。
3. 在弹出的榕树授权页面使用已有访问密码登录，确认读取研究资料和写回研究结果的权限。只支持 ChatGPT 官方回调地址。
4. 在榕树 → 持续助手 → dots 研究助手，选择 dots 执行方式，设置采集开关、间隔及每日篇数上限。
5. 在同一面板复制任务说明给 dots。先验证一次领取、原文阅读、写回推荐和简报，再在 dots 内确认每日执行时间及定时任务。

系统默认保留现有分析方式，部署不会自动扩大数据访问或创建 dots 定时任务。启用 dots 模式后，Cloudflare 按设置采集元数据、同步自己的博客全文；内置持续 Agent 暂停自动决策，外部文章及博客不再自动调用模型分析。手动项目分析和智能问答仍使用现有模型。

### 协议与边界

- `/mcp` 使用官方 MCP SDK 的无状态 Streamable HTTP / JSON 响应。
- OAuth 授权码 + PKCE S256，绑定 client、redirect URI、resource 和 scope。授权码仅使用一次，访问令牌一小时，刷新令牌30天并轮换。凭据仅存 SHA-256 摘要，授权记录保存在 D1，不出现在 `/api/state` 或 MCP 结果里。
- `research:read`：读取背景、预览候选、搜索/读取知识；`research:write`：领取和提交研究、更新问题、记录反馈。MCP 不提供管理员设置、删除数据或读取模型凭据的工具。
- 后台“断开所有 dots 授权”撤销连接，重新连接需要重新授权；榕树数据库仍是研究记录的事实来源。
- 每批使用唯一 `requestId`，同次重试复用。领取两小时有效，过期后用新 ID 重新领取。领取尝试均消耗当日篇数额度，避免失败无限重跑；额度于 UTC 00:00（北京时间08:00）重置。
- 提交包含整批文章，每篇只提交一次判断；重复提交返回原收据。可零推荐。推荐须至少70分且声明已读取原文；这是 Agent 的声明，不等于服务器独立验证原文。
- 外部内容只保存原文地址、元数据和受长度限制的生成分析；不会保存抓取的外部全文。自己的博客可以保存全文。
- 网页和工具返回的资料均视为不可信输入。工具写入参数有严格 schema、引用存在性验证和每日推荐额度检查。
- 采集开关只控制榕树，不能代替 dots 的任务调度。dots 额度和第三方 API 用量各按其服务计费，篇数上限不等于金额上限。

验收：`npm test`（含 OAuth / MCP 真实协议请求、权限、重放、队列租约、配额、幂等及无模型采集测试），`npm run cloud:check`。
