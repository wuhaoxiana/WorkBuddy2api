# WorkBuddy 2API

把 **WorkBuddy / CodeBuddy** 变成一个标准的 OpenAI / Anthropic 兼容 API —— 跑在 Cloudflare Workers 上，带多账号池、自动签到和一套网页控制台。

> **这个仓库是从 [IamNewHands/ai-gateway](https://github.com/IamNewHands/ai-gateway) 中「只抽取 WorkBuddy 部分」得到的独立项目。**
> 源仓库是个多提供商网关（WorkBuddy / Qoder / Cline / Gemini / CNB / M365 / TRAE / zCode / Kuku / DeepSeek / OpenCode 等十余家）。
> 本项目保留 WorkBuddy 全链路的代码与行为（含全部注释与踩坑记录），剥离其它提供商与通用附加能力，得到一个只需部署一次、只服务 WorkBuddy 的网关。
> 抽取范围与逐项差异见 [与源项目的差异](#与源项目的差异)。

---

## 特性

### 账号侧

- **OAuth 浏览器登录** —— 生成登录链接 → 浏览器登录 → 自动入库，无需手抄 token
- **多账号池** —— 一个 provider 装 N 个账号，按 uid 去重，重复登录只更新凭证
- **智能挑号** —— 优先消耗「7 天内到期」的积分（到期越早越先），否则按剩余积分加权随机；同一账号 100ms 内不重复挑中（防惊群）
- **故障轮转** —— 429 / 余额不足 / 连续错误分级冷却，冷却到期自动恢复；会话级吊销才停用
- **单号在途上限** —— 默认 3 并发，global 域可单独下调，避免高并发把账号打爆
- **CN / Global 双域** —— 按 Token 的 JWT `iss` 自动路由推理与刷新端点
- **会话粘性** —— 同一会话的多轮请求打到同一账号，上游后台按对话轮聚合

### 协议侧

- **三种入口** —— `/v1/chat/completions`、`/v1/messages`（Anthropic）、`/v1/responses`（OpenAI Responses），内部统一转成 Chat Completions 再转发
- **流式全链路** —— SSE 清洗、心跳保活、空流兜底、退化推理熔断、工具调用增量修复
- **思维链兼容** —— DeepSeek 系模型的 `reasoning_content` 注入与历史回填
- **指纹与风控** —— 三段式 UA、会话头族、内容拦截降级重试、WAF/业务信封分流
- **Base URL 容错** —— 客户端把地址填成裸域名也能用（自动 308 补 `/v1`）

### 生态侧

- **每日签到** —— Cron 自动签到（10:05 / 22:05），回读额度与权益包
- **连登奖励** —— 奖励兑换 + 连登抽奖（CN / Global 都执行）
- **夜猫子任务** —— 独立的 23:30 Cron（官方只在 CST 23:00–08:00 计数）
- **盲盒 / 猫猫旅行 / 活跃上报** —— 能量消耗与日常维护，控制台可一键触发
- **国际版补充** —— trial 加油包领取、注册激活自愈（否则 chat 必 429）
- **成长任务脚本** —— `scripts/workbuddy/` 下三个零依赖 Python 脚本（任务中心、开学季活动）

---

## 模块职责

```
src/
├── index.ts                 # Hono 路由 + Cron 分发 + X-Request-Id 追踪        310 行
├── config.ts                # KV 键、端点预设、WorkBuddy OAuth 模板
├── types.ts                 # 类型契约（Provider / OAuth / CheckinResult…）
│
├── proxy.ts                 # 转发核心：挑号 → 出站改写 → SSE 清洗 → 协议转换    4028 行
├── workbuddy-upstream.ts    # 出站请求构造：指纹、头族、内容墙、reasoning、错误分类  1817 行
├── workbuddy-sse.ts         # SSE 帧状态机：工具调用索引、心跳、熔断、错误帧        1038 行
├── workbuddy-billing.ts     # 计费与生态：签到、权益包、连登、盲盒、旅行、trial     2191 行
├── workbuddy-models.ts      # 模型目录动态探测（/v3/config + 企业端点并集）         339 行
├── workbuddy-session-ids.ts # 会话/消息 ID 派生与请求头注入                        474 行
├── workbuddy-sticky.ts      # 会话 → 账号粘性绑定                                 261 行
├── workbuddy-inflight.ts    # 单账号在途计数（并发闸门）                          136 行
│
├── oauth.ts                 # 浏览器登录 / 设备码 / Token 续期 / 池化保活            777 行
├── oauth-pool.ts            # 账号池：挑号权重、冷却、模型级限流、成本台账           1168 行
├── checkin.ts               # 签到编排：逐账号结果、池化、概览聚合                  1108 行
├── credit-expiry.ts         # 「7 天内到期优先」的唯一判定实现
├── formats.ts               # OpenAI / Anthropic / Responses 三格式互转            2124 行
│
├── admin.ts                 # 管理 API（provider / 池 / 模型 / 日志 / 设置）        1502 行
├── pages.ts                 # 管理后台页面（单文件，无前端构建）                    1146 行
├── auth.ts                  # 会话鉴权、Cloudflare Access、转发 Key、管理 Token
├── storage.ts               # KV 读写 + 10s 内存缓存 + 登录限速
├── request-body.ts          # 有界请求体读取（防超大 body 打爆 isolate）
├── perf.ts / thinking.ts / cache-prefix.ts   # 超时分级 / 思维引导 / 缓存前缀注入
└── analytics/               # Analytics Engine 用量统计（未绑定则自动降级为空）
```

设计取向：**WorkBuddy 的领域逻辑单独成文件、不掺 UI 与路由**（`workbuddy-*.ts` 共 6 千余行，几乎不依赖其它模块），
这样挑号、SSE、计费这些最容易出错的逻辑可以被单元测试直接钉住（见 [测试](#测试)）。

---

## 快速开始

### 1. 本地开发

```bash
git clone <你的仓库地址> workbuddy-2api
cd workbuddy-2api
npm install

# 管理员账号（本地开发用 .dev.vars，线上用 Dashboard 变量）
echo ADMIN_USERNAME=admin >> .dev.vars
echo ADMIN_PASSWORD='换成你的密码' >> .dev.vars

npm run dev      # http://127.0.0.1:8787
```

> 首次请求会自动写入一个空的 WorkBuddy 提供商和一个「测试 Key」（`sk_wb_…`）。
> 打开 `/admin` 登录后即可添加账号。

### 2. 创建 KV

```bash
npx wrangler kv namespace create KV
# 把返回的 id 填进 wrangler.toml 的 [[kv_namespaces]]
```

### 3. 部署

```bash
npx wrangler deploy
```

或用 GitHub Actions（推荐，仓库已带 `.github/workflows/deploy.yml`）：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `CF_API_TOKEN` | Cloudflare API Token，权限 **Workers Scripts: Edit** |
| Secret | `CF_ACCOUNT_ID` | Cloudflare Account ID |

推送到 `main` 即自动执行「安装 → 类型检查 → 测试 → 部署」。

> 建议给 Worker 绑定自定义域名：Cloudflare 的 `*.workers.dev` 在部分网络下不稳定，
> 且 SSE 长连接对链路质量敏感。

### 4. 加账号

1. 打开 `https://你的域名/admin`，用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录
2. 「账号池」→ 右上角 **添加账号** → **生成登录链接**
3. 在浏览器打开链接，用 WorkBuddy 账号登录
4. 面板自动轮询到登录成功，账号入池（昵称与积分以 JWT / 签到回读为准）

国际版账号：在「设置 → 登录域」选 **全球版** 再点登录，端点会切到 `www.workbuddy.ai`。

---

## 客户端接入

| 项 | 值 |
| --- | --- |
| Base URL | `https://你的域名/v1` |
| API Key | 控制台「接入」页新建，形如 `sk_wb_…` |
| 模型 ID | `提供商ID/模型ID`，如 `workbuddy/claude-sonnet-4` |

```bash
# OpenAI Chat Completions
curl https://你的域名/v1/chat/completions \
  -H 'Authorization: Bearer sk_wb_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"model":"workbuddy/claude-sonnet-4","messages":[{"role":"user","content":"你好"}],"stream":true}'

# Anthropic Messages
curl https://你的域名/v1/messages \
  -H 'Authorization: Bearer sk_wb_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"model":"workbuddy/claude-sonnet-4","max_tokens":256,"messages":[{"role":"user","content":"你好"}]}'

# OpenAI Responses
curl https://你的域名/v1/responses \
  -H 'Authorization: Bearer sk_wb_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"model":"workbuddy/claude-sonnet-4","input":"你好"}'

# 模型列表
curl https://你的域名/v1/models -H 'Authorization: Bearer sk_wb_xxx'
```

**模型 ID 前缀可以省略**：只写 `claude-sonnet-4` 时会自动匹配唯一拥有该模型的提供商。

三种格式的字段映射与已知有损点见 [`docs/FORMATS.md`](docs/FORMATS.md)。

---

## 控制台

| 页 | 内容 |
| --- | --- |
| **概览** | 账号数 / 今日签到进度 / 可用积分 / 模型数；7 天内到期积分提醒；一键日常、立即签到、活跃上报、猫猫旅行 |
| **账号池** | 逐个账号的昵称、uid、状态（可用 / 冷却剩余时长 / 已禁用）、积分、成功错误计数、Token 到期；设为首选、暂停、删除、拉取模型、添加账号 |
| **模型** | 模型列表；启用开关、思维注入开关、缓存前缀开关；手动添加 / 删除；从上游目录一键同步 |
| **接入** | API Base URL、兼容协议说明、转发 Key 的新建 / 停用 / 删除 |
| **日志** | 按类型筛选、关键词搜索、保留天数与开关、清空 |
| **设置** | 提供商名称/地址/登录域、OAuth 端点（含 Global 域）、系统提示词模式、思维引导与缓存前缀、超时分级 |

页面是单文件服务端渲染 + 前端拉 `/admin/api/*`，**没有前端构建步骤**，改完直接部署。

---

## 账号池机制

**挑号**（`oauth-pool.ts` `pickOauthAccount`）

1. 过滤不可用：冷却中、已禁用、余额耗尽、该模型被限流、在途已满
2. 若存在「7 天内到期且仍有剩余」的账号 → 只在这些里挑，到期越早越优先（避免整包额度作废）
3. 否则按 `积分比例 × 10 + 闲置补偿 + 成功率 × 3` 加权，取 Top5 后在同权重内加权随机
4. 首选账号（`preferOauthUid`）指定时压过以上规则，除非它不可用

**冷却**（`resolveOauthCooldown`，可按 provider 覆盖）

| 场景 | 默认 | 行为 |
| --- | --- | --- |
| 429 短限流 | 60s | 优先采信上游 `Retry-After` |
| 余额不足 / plan 不足 | 12h | 长冷却，换号 |
| 模型级限流（如 6004） | 报文给的重置时刻 | 只冷却该模型，账号继续服务其它模型 |
| 连续错误 | 5 次 → 10min | 达阈值冷却 |
| 会话级吊销（如 12153） | 累计判定 | 连续失败才停用，需人工重新登录 |

**域路由**：`detectTokenRealm(token)` 按 JWT `iss` 判断 —— 含 `workbuddy.ai` → Global 域（`www.workbuddy.ai`），含 `codebuddy.cn` → 国内域（`copilot.tencent.com`）。Global token 打到国内域会被 APISIX 直接 401，所以推理、刷新、模型目录三处都按域选端点，并在 401 时自动换域重试一次。

---

## 定时任务

`wrangler.toml` 里三条 cron（UTC，括号为北京时间）：

| 表达式 | 时间 | 任务 |
| --- | --- | --- |
| `0 */2 * * *` | 每 2 小时 | 刷新账号池 Token：临期（10 分钟内）或闲置（20 天）才打上游，禁用号跳过 |
| `5 2,14 * * *` | 每日 10:05 / 22:05 | 全量签到（含连登奖励、盲盒、旅行、trial 领取） |
| `30 15 * * *` | 每日 23:30 | 夜猫子任务（官方仅在 CST 23:00–08:00 窗口计数，故必须单独一条） |

> Token 刷新采用**两阶段提交**：先刷出「uid → 新 token」补丁，再重新读池按 uid 打补丁，把
> 「持有快照期间整体覆盖」造成的丢失更新窗口从数十秒压到一次 KV get→put。

---

## 对外管理 API

配置 `MANAGEMENT_TOKEN` 后可用（供手机脚本、快捷指令等外部调用；未配置则返回 503）：

```bash
# 查看提供商（Key 自动脱敏）
curl https://你的域名/api/manage/providers -H 'Authorization: Bearer <MANAGEMENT_TOKEN>'

# 新增/合并提供商（只增不删）
curl -X POST https://你的域名/api/manage/providers/upsert \
  -H 'Authorization: Bearer <MANAGEMENT_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"id":"workbuddy","models":["claude-sonnet-4"]}'

# 触发签到：全量 / 单个
curl -X POST https://你的域名/api/manage/checkin -H 'Authorization: Bearer <MANAGEMENT_TOKEN>'
curl -X POST https://你的域名/api/manage/checkin/workbuddy -H 'Authorization: Bearer <MANAGEMENT_TOKEN>'
```

账号池凭证导出（含 token，**仅在管理后台会话下可用**）：

```
GET /admin/api/oauth/:id/pool/export?uid=<可选>&download=1
```

导出格式与 `scripts/workbuddy/` 的凭证读取格式兼容，可直接给脚本用。

---

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | ✅ | 控制台登录；未配置时登录接口返回 500 |
| `MANAGEMENT_TOKEN` | ➖ | 对外管理 API 的 Bearer Token |
| `USAGE_ANALYTICS_DATASET` | ➖ | Analytics Engine 数据集名（默认已写在 `wrangler.toml`） |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` | ➖ | 仅用量统计看板查询需要 |
| `WORKBUDDY_MAX_REASONING_CHARS` | ➖ | 单次流式推理字符上限，默认 65536，`0` = 不限 |
| `CF_ACCESS_ENABLED` / `CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN` | ➖ | 给 `/admin/*` 再套一层 Cloudflare Access（不影响 `/v1/*`） |

KV 绑定：`KV`（必须）。Analytics Engine 绑定：`USAGE_ANALYTICS`（可选）。

---

## 测试

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

当前 **718 个用例全部通过**，覆盖：

- `workbuddy-upstream` / `workbuddy-sse`：内容墙、错误分类、reasoning 降级、SSE 帧状态机、工具调用索引
- `workbuddy-billing`：签到幂等、连登奖励、盲盒、trial、权益包
- `workbuddy-session-ids` / `workbuddy-sticky` / `workbuddy-inflight`：会话头族、粘性绑定、并发闸门
- `workbuddy-pooled-e2e`：**端到端**跑 `handleProxy` → `forwardProxy` → 池化核心，验证挑号、冷却、重试额度、空流兜底
- `admin-test-model-workbuddy`：走完整 HTTP 路由验证「测试模型」对 CN/Global 两种 token 的行为
- `formats` / `analytics/attribution`：三格式转换保真度、用量归属

---

## 与源项目的差异

### 完整保留

| 模块 | 说明 |
| --- | --- |
| `workbuddy-upstream.ts` `workbuddy-sse.ts` `workbuddy-billing.ts` `workbuddy-models.ts` `workbuddy-session-ids.ts` `workbuddy-sticky.ts` `workbuddy-inflight.ts` | **逐字保留**，仅删除与非 WorkBuddy 提供商共用的少数分支 |
| `oauth-pool.ts` | 逐字保留（源项目里它本身就是 WorkBuddy 池） |
| `formats.ts` | 逐字保留（三格式互转与提供商无关） |
| `proxy.ts` 的 WorkBuddy 路径 | 挑号池化核心、SSE 聚合、出站改写、空流兜底、重试与 backoff **逐字保留** |
| `checkin.ts` 的 WorkBuddy 签到链 | 签到、额度回读、连登、夜猫子、盲盒、旅行、活跃、trial、global 激活 |
| `scripts/workbuddy/` | 三个零依赖 Python 脚本 + 原始说明 |

### 剥离

| 被移除 | 原因 |
| --- | --- |
| Qoder / Cline / Gemini / CNB / M365 / TRAE / zCode / Kuku / DeepSeek / OpenCode | 其它提供商及其专用分支、端点、UI |
| MCP 聚合网关、uni-model 联合模型 | 与 WorkBuddy 无关的通用附加能力 |
| WebSocket 桥接、图片生成、Vision Bridge | 上面那些提供商在用 |
| M365 Durable Object 绑定 | 只服务 M365 ChatHub 会话 |
| `Provider` 上的厂商专用字段 | 收敛类型契约（见 `types.ts` 顶部注释） |

### 改写

| 文件 | 改动 |
| --- | --- |
| `index.ts` | 路由只留 WorkBuddy 相关；Cron 从 6 条精简为 3 条 |
| `config.ts` | 默认提供商改为一个预填端点的空 WorkBuddy 池；转发 Key 前缀 `sk_cf_` → `sk_wb_` |
| `oauth.ts` | 只保留 browser / device 两条流程与 browser 池保活刷新（1761 → 777 行） |
| `admin.ts` | 只保留 provider CRUD、账号池、模型目录、日志、设置（3555 → 1502 行） |
| `checkin.ts` | 只保留 WorkBuddy 签到生态（1719 → 1108 行） |
| `pages.ts` | **重写**为 WorkBuddy 专用控制台（原文件是 6000 行多厂商共用模板） |

---

## 免责声明

- 本项目仅用于**个人学习与自建自用**。WorkBuddy / CodeBuddy 是其权利人提供的商业服务，请遵守其服务条款与当地法律法规。
- 账号凭证保存在你自己的 Cloudflare KV 中；`/admin/api/oauth/:id/pool/export` 会导出明文 token，请勿公开分享。
- 请勿用于任何商业转售、批量注册或规避风控的场景。因使用本项目产生的任何后果由使用者自行承担。

## 致谢

- 上游项目：[yutian81/ai-gateway](https://github.com/yutian81/ai-gateway)、[IamNewHands/ai-gateway](https://github.com/IamNewHands/ai-gateway)
- 借鉴实现：cpa-plugin/workbuddy、workbuddy2api、workbuddy-wild（挑号权重、冷却口径、指纹细节的来源，均在代码注释中标注）

## License

Apache-2.0（沿用上游项目 `LICENSE` 文件）。详见 [LICENSE](LICENSE)。
