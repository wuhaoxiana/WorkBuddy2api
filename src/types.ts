/**
 * types.ts — WorkBuddy 2API 的类型契约。
 *
 * 抽取说明：源项目是「多提供商网关」，Provider 上曾挂着 trae* / cline* / m365* / gemini* 等
 * 十余家厂商的专用字段。本项目只服务 WorkBuddy / CodeBuddy，故 schema 收敛到该生态实际
 * 消费的字段——保留通用壳（api-key / oauth-device 两种认证、模型列表、Key 列表），
 * 去掉其余厂商的字段与开关。
 */

export interface Model {
  id: string
  enabled: boolean
}

/**
 * 账号池冷却参数（provider.cooldown 可覆盖默认值）。
 * 对齐 workbuddy-wild 的 cooldown.* 配置：余额不足（plan）/ 429（soft）/ 连续错误。
 * 单位均为毫秒；errThreshold 为连续错误触发冷却的阈值（次）。
 */
export interface CooldownConfig {
  /** plan 权益不足长冷却（ms） */
  planMs?: number
  /** 429 短冷却（ms） */
  softMs?: number
  /** 连续错误触发冷却的阈值（次） */
  errThreshold?: number
  /** 连续错误冷却（ms） */
  errMs?: number
}

export interface ApiKeyEntry {
  key: string
  enabled: boolean
  /**
   * 账号名，仅用于面板显示，**不参与任何鉴权**。
   * 多账号型提供商（oauth-device 池）用它给账号起个可读名字。
   */
  label?: string
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  /** 认证方式：api-key（普通 API Key） | oauth-device（OAuth 登录，WorkBuddy 走这个） */
  authType?: 'api-key' | 'oauth-device'
  /**
   * 系统提示词体系（移植 workbuddy2api internal/prompt）：
   *  - 'passthrough'（缺省）：透传客户端原始 system；遇内容拦截误报时自动换
   *    WORKBUDDY_DEGRADED_PROMPT 中性提示词同请求重试一次（见 proxy 内容墙处理）。
   *  - 'custom'：出站时用 promptText 整体替换 system/developer，从源头消除指纹误报。
   *  - 'append'：在开头连续 system/developer 块**之后**插入一条网关 system，
   *    既有消息（含客户端项目规范）逐字不动——两者并用。
   *  未设置按 'passthrough' 处理。
   */
  promptMode?: 'passthrough' | 'custom' | 'append'
  /** custom/append 模式下注入的自有系统提示词文本（两模式均生效）。 */
  promptText?: string
  /** OAuth 认证配置（authType === 'oauth-device' 时生效） */
  oauth?: OAuthDeviceConfig
  apiKeys: ApiKeyEntry[]
  models: Model[]
  enabled: boolean
  /**
   * 账号池冷却参数。不配则用池默认值（12h / 60s / 5 次 / 10m）。
   */
  cooldown?: CooldownConfig
  /**
   * 多账号池首选账号 UID（面板下拉框手工指定）。
   * 填写后转发时优先使用该账号（按 uid 精确匹配），
   * 被冷却/禁用/失败时才回退到池内其他账号。留空 = 自动挑选。
   *
   * 自动挑选是两段式：池内存在「7 天内到期且仍有剩余」的积分时只在其中挑（到期越早越优先），
   * 否则按剩余积分最多者挑选——规则见 credit-expiry.ts。
   */
  preferOauthUid?: string
  /**
   * 思维模式引导注入（provider 级勾选哪些模型启用）。
   * 值为需注入的模型 ID 数组。命中的模型在转发前会被注入一段固定的思维引导
   * system 提示词（见 src/thinking.ts），未勾选的模型原样转发。
   */
  thinkingInject?: string[]
  /**
   * 缓存前缀注入（provider 级勾选哪些模型启用）。
   * 值为需注入的模型 ID 数组。命中的模型在转发前会被注入一段固定的缓存前缀
   * system 提示词（见 src/cache-prefix.ts），利用上游前缀缓存降低 token 成本。
   */
  cachePrefixInject?: string[]
  /**
   * 允许未配置模型透传。开启后请求该提供商的任意 modelId 都直接转发
   * （跳过「模型未配置」校验），适合模型频繁上新的场景。
   */
  allowUnlistedModels?: boolean
  createdAt: string
  updatedAt: string
}

/** OAuth 认证配置（authType === 'oauth-device' 时生效） */
export interface OAuthDeviceConfig {
  /**
   * 登录流程类型：
   * - browser（WorkBuddy 主路径）：POST deviceCodeUrl 拿到登录链接（authUrl），
   *   用户打开网页登录后轮询拿 token
   * - device：标准设备码（RFC 8628）— 申请 device_code，用户在浏览器输入 user_code
   */
  flowType?: 'device' | 'browser'
  /**
   * 设备码申请端点 / 浏览器登录发起端点：
   * - browser 模式：POST, JSON body {}，返回 {code,msg,data:{state, authUrl}}
   * - device 模式：POST, x-www-form-urlencoded, 需 client_id，返回 device_code/user_code
   */
  deviceCodeUrl: string
  /**
   * 轮询端点：
   * - browser 模式：GET，追加 ?state=xxx 轮询，返回 {code,msg,data:{accessToken,refreshToken,expiresIn,domain}}
   * - device 模式：POST, x-www-form-urlencoded, 提交 device_code
   */
  deviceTokenUrl: string
  /** token 刷新端点：browser 模式为 POST + header X-Refresh-Token */
  refreshTokenUrl: string
  /** OAuth 应用 client_id（browser 模式可留空） */
  clientId: string
  /** 申请的 scope（可选） */
  scope?: string
  /** 轮询间隔（秒），默认 5 */
  pollInterval?: number
  /** access_token 注入到上游请求的哪个头，默认 x-api-key；WorkBuddy 用 Authorization */
  tokenHeader?: string
  /** token 注入时的值前缀，例如 "Bearer " */
  tokenHeaderPrefix?: string
  /** 转发时额外注入的固定请求头 */
  extraHeaders?: Record<string, string>
  /**
   * 模型列表发现端点（绝对 URL，GET）。
   * 留空则回退到 `${baseUrl}/models`（OpenAI 标准）。
   * WorkBuddy 需填写，例如：
   * https://copilot.tencent.com/console/enterprises/personal/models
   */
  modelsUrl?: string
  /**
   * Global 域（海外账户，JWT iss 含 workbuddy.ai）的备选端点。
   * WorkBuddy 的 Global token 必须走 www.workbuddy.ai，否则
   * copilot.tencent.com 的 APISIX 会返回 401。留空则不区分域。
   */
  globalBaseUrl?: string
  globalModelsUrl?: string
  globalOrigin?: string
  /**
   * Global 域 OAuth 登录端点（browser 模式专用）。
   * 与 deviceCodeUrl/deviceTokenUrl/refreshTokenUrl 同协议，只是换到 www.workbuddy.ai 域。
   * 留空则对应操作只能走 CN 端点。
   */
  globalDeviceCodeUrl?: string
  globalDeviceTokenUrl?: string
  globalRefreshTokenUrl?: string
  /**
   * 发起浏览器登录时使用的域（browser 模式）。
   * 'cn'（默认）走 copilot.tencent.com 端点；'global' 走 www.workbuddy.ai 端点。
   * 仅影响登录流程；登录成功后 token 的 CN/Global 域仍按 JWT iss 自动路由。
   */
  loginRealm?: 'cn' | 'global'
  /**
   * WorkBuddy reasoning_effort 能力表（可选，移植 workbuddy2api supportedEfforts 降级）。
   * key = 模型 ID；value = 该模型支持的 reasoning_effort 档位（如 ["low","medium","high"]，
   * 合法档位：off/minimal/low/medium/high/xhigh/max）。
   * 声明后：客户端请求档位若模型不支持，自动降级为 ≤请求档位的最高支持档。
   * 未声明该模型的保持「删除 reasoning_effort」的既有行为（零回归）。
   */
  effortPolicy?: Record<string, string[]>
  /**
   * WorkBuddy 设备风控 Token（X-Device-Token 头，对齐 workbuddy2api device_token）。
   * 可选。配置后请求上游注入 X-Device-Token，模拟桌面端 Turing Shield SDK 生成的设备指纹。
   */
  deviceToken?: string
  /**
   * 单账号最大在途请求数（对齐 workbuddy2api `pool.max_in_flight`，源默认 3）。
   * 未配置 = 默认 3；<= 0 视为不限（仍计数供观测）。
   * 用途：避免高并发把单个账号打爆（放大 429/5xx → 触发冷却）。
   * 注意 Workers 多 isolate 下为 isolate 内近似，详见 workbuddy-inflight.ts。
   */
  maxInFlight?: number
  /**
   * global 域单账号在途上限（对齐 workbuddy2api `pool.max_in_flight_global`）。
   * 未配置/<=0 → 回落 maxInFlight；>0 时 global 号按此档、cn 号仍按 maxInFlight。
   * 用途：global 域 WAF 风控更紧，单独压低其单号并发。
   */
  maxInFlightGlobal?: number
}

/** KV 中保存的 OAuth token 状态 */
export interface OAuthTokenState {
  access_token: string
  refresh_token?: string
  /** 过期时间（epoch ms） */
  expires_at: number
  updated_at: number
  /** browser 模式：发起登录时上游返回的 Set-Cookie，后续请求需复用 */
  cookies?: string
  /** WorkBuddy 账号 uid */
  uid?: string
  /** WorkBuddy 租户/企业 ID */
  enterprise_id?: string
  /** WorkBuddy 域（copilot.tencent.com / workbuddy.cn / workbuddy.ai） */
  domain?: string
  /** WorkBuddy 设备风控 Token（X-Device-Token 头，对齐 workbuddy2api device_token） */
  device_token?: string
  /** 账号所属域（cn 默认 / global），决定推理与刷新端点 */
  realm?: 'cn' | 'global'
}

/** 进行中的浏览器/设备码登录流程状态 */
export interface DeviceFlowState {
  /** device 模式：device_code；browser 模式：state */
  device_code: string
  /** device 模式：用户码；browser 模式：空 */
  user_code: string
  /** device 模式：验证链接；browser 模式：登录页 authUrl */
  verification_uri: string
  interval: number
  expires_at: number
  /** 流程类型，用于轮询时分发 */
  flowType?: 'device' | 'browser'
  /**
   * browser 模式：发起登录时上游返回的 Set-Cookie。
   * cpa-plugin 强调 must reuse the same cookie jar，否则 token 无效导致 401。
   */
  cookies?: string
  /** 本次登录使用的域（发起时按 cfg.loginRealm 固化，轮询时复用） */
  loginRealm?: 'cn' | 'global'
}

export interface ProxyKey {
  id: string
  key: string
  name: string
  enabled: boolean
  createdAt: string
  expiresAt?: string | null
  /** 允许的模型列表（含提供商前缀，如 "workbuddy/xxx"）。空或不存在 = 全部允许 */
  allowedModels?: string[]
}

export interface Session {
  username: string
  expiresAt: number
}

export interface ProxyRequestBody {
  model?: string
  /**
   * 消息数组。content 可能是字符串，也可能是包含 text/image_url 等类型块的数组，
   * 故放宽为宽松记录类型。
   */
  messages?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface TestModelRequest {
  modelId: string
}

export interface CreateProviderRequest {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  authType?: 'api-key' | 'oauth-device'
  oauth?: OAuthDeviceConfig
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
  cooldown?: CooldownConfig
  allowUnlistedModels?: boolean
  promptMode?: 'passthrough' | 'custom' | 'append'
  promptText?: string
  thinkingInject?: string[]
  cachePrefixInject?: string[]
}

export interface UpdateProviderRequest {
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  authType?: 'api-key' | 'oauth-device'
  oauth?: OAuthDeviceConfig
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
  /** 传 null 可恢复各池默认冷却参数 */
  cooldown?: CooldownConfig | null
  allowUnlistedModels?: boolean
  /** 传空数组可清空注入选择 */
  thinkingInject?: string[] | null
  cachePrefixInject?: string[] | null
  /** 系统提示词体系：'passthrough'（传 null 恢复默认）| 'custom' | 'append' */
  promptMode?: 'passthrough' | 'custom' | 'append' | null
  /** custom/append 模式下注入的自有系统提示词（传 ''/null 清空） */
  promptText?: string | null
}

/**
 * 对外管理 API 的 upsert 请求体。
 * - id 必填：存在则合并，不存在则创建。
 * - 不含 oauth：OAuth 走管理后台 UI，脚本不碰。
 * - apiKeys/models 既支持字符串（追加为 enabled:true），也支持完整对象。
 * - 合并语义：keys/models 只增不删，key 字符串去重。
 */
export interface UpsertProviderRequest {
  id: string
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  authType?: 'api-key' | 'oauth-device'
  apiKeys?: Array<ApiKeyEntry | string>
  models?: Array<Model | string>
  enabled?: boolean
  cooldown?: CooldownConfig
  allowUnlistedModels?: boolean
  thinkingInject?: string[]
  cachePrefixInject?: string[]
  promptMode?: 'passthrough' | 'custom' | 'append'
  promptText?: string
}

/**
 * WorkBuddy/CodeBuddy 每日签到结果。
 * 存于 KV（CHECKIN_RESULT_PREFIX + providerId），管理后台面板展示。
 */
export interface CheckinResult {
  providerId: string
  name: string
  /** 池账号 uid（多账号池逐账号签到结果才有，供面板按 uid 与账号池对齐） */
  uid?: string
  /** 账号领域：cn 可签到，global 跳过 */
  realm: 'cn' | 'global' | 'unknown'
  success: boolean
  /** ok | already | skipped_global | skipped_no_token | fail */
  reason: string
  message: string
  todayCheckedIn: boolean
  streakDays?: number
  totalCredits?: number
  dailyCredit?: number
  /** 本次签到获得积分（仅签到成功当天有值，already 当天无） */
  checkinCredit?: number
  /** 上次签到时间（epoch ms） */
  lastCheckinAt?: number
  updatedAt: number
  // ===== 额度信息（来自 get-user-resource，仅 CN 有效） =====
  /** 可用余额 */
  totalRemain?: number
  /** 已用 */
  totalUsed?: number
  /** 额度池（总容量） */
  totalSize?: number
  /** 包数量 */
  packCount?: number
  /** 套餐类型：free / paid 等 */
  paymentType?: string
  /** 账号昵称（JWT 解出，解不出则留空） */
  nickname?: string
  /** 权益包明细（每个包的名称 + 到期时间），来自 get-user-resource Accounts[] */
  packages?: PackageInfo[]
  /** 对话活跃上报结果 */
  activityReport?: { success: boolean; message: string }
  /** 猫猫旅行状态与收益 */
  catTravel?: { state: string; reward?: number; message: string; buddyName?: string }
  /**
   * 连登奖励兑换 + 连登抽奖结果（移植 workbuddy2api 91418c5）。
   * CN 与 global 都执行（workbuddy.ai 的 growth 域与 CN 同构可用）。
   */
  growthReward?: {
    acted: boolean
    tier?: string
    credit?: number
    chances?: number
    prize?: string
    prizeCredit?: number
    message: string
  }
  /**
   * 夜猫子 black_cat 任务结果（仅 CN；global 无该任务体系）。
   * 官方规则「每天 1 次 × 累计 3 天」，仅在 CST 23:00–08:00 窗口内计数；
   * 非窗口期 state='skipped' 且不发任何上游请求。
   */
  nightCat?: { state: string; message: string }
  /**
   * 盲盒结果（CN 与 global 都执行）：能量（energy）的唯一消耗出口。
   * 能量不足时 acted=false 且不发写请求（正常态，非失败）。
   */
  blindBox?: {
    acted: boolean
    opened: number
    items: Array<{ name: string; rarity: string }>
    message: string
  }
  /**
   * 国际版一次性 trial 加油包领取结果（仅 global 账号）。
   * global 无签到/任务中心，trial 是其唯一天然积分增益动作。
   */
  trialClaim?: { success: boolean; already: boolean; message: string }
  /**
   * 国际版注册激活自愈结果（仅 global 账号）：补齐 register + 注册地区完善。
   * 上游对「未完成注册激活」的试用账号，chat 请求会返回 429 code 14017，换号/重试均无效，
   * 必须先激活（workbuddy2api activate_region / complete_flow）。
   */
  globalActivation?: { ok: boolean; message: string }
  /**
   * 多账号池：本 provider 下每个池账号的独立签到结果（池提供商才有）。
   * 面板可按账号逐条展示；汇总字段（success/credits 等）为池整体快照。
   */
  accounts?: CheckinResult[]
}

/** 单个权益包信息（来自 get-user-resource 的 Accounts[] 元素） */
export interface PackageInfo {
  /** 包名，如 "CodeBuddy个人体验版" */
  name: string
  /** 到期时间（原始字符串）。空串表示未设置过期时间（通常为长期/按周期滚动） */
  expireAt: string
  /** 本周期结束时间（月度额度周期），如 "2026-08-31 23:59:59" */
  cycleEndTime?: string
  /** 该包已用额度（优先本周期 CycleCapacityUsed，回退整包 CapacityUsed） */
  used?: number
  /** 该包总额度（优先本周期 CycleCapacitySize，回退整包 CapacitySize） */
  size?: number
  /** 额度单位，如 credits */
  unit?: string
}

export interface CreateProxyKeyRequest {
  name?: string
  /** 预设有效期：'30d' | '90d' | '180d' | '1y' | 'forever' */
  expiresIn?: string
  /** 自定义天数（优先级高于 expiresIn） */
  expiresInDays?: number
  /** 自定义小时数（优先级低于 expiresInDays） */
  expiresInHours?: number
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

export interface Env {
  /** Workers KV：provider 配置、转发 Key、账号池、Token、签到结果、日志 */
  KV: KVNamespace
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
  /** 对外管理 API 的认证 Token；未配置时 /api/manage/* 返回 503 */
  MANAGEMENT_TOKEN?: string
  /**
   * Cloudflare Access 加固开关（可选，仅作用于 /admin/*）。
   * 设 'true' 才启用；否则一律放行（不影响客户端 /v1/*，也不影响任何其它路径）。
   * 启用后需要同时配置 CF_ACCESS_AUD 与 CF_ACCESS_TEAM_DOMAIN，
   * 管理后台会额外要求携带有效 Cf-Access-Jwt（头优先，回退 CF_Authorization Cookie）。
   */
  CF_ACCESS_ENABLED?: string
  CF_ACCESS_AUD?: string
  CF_ACCESS_TEAM_DOMAIN?: string
  /** Analytics Engine 数据集（可选，未绑定则用量统计自动降级为空） */
  USAGE_ANALYTICS?: AnalyticsEngineDatasetBinding
  USAGE_ANALYTICS_DATASET?: string
  /** Analytics Engine SQL API 凭据（可选，仅用量统计看板需要） */
  CF_ACCOUNT_ID?: string
  CF_API_TOKEN?: string
  /** WorkBuddy 单次流式推理最大 reasoning 字符上限（默认 65536，设 0 表示不限字数硬上限，仅依靠行重复率死循环熔断） */
  WORKBUDDY_MAX_REASONING_CHARS?: string
}

export interface AnalyticsEngineDatasetBinding {
  writeDataPoint(point: {
    indexes?: string[]
    blobs?: string[]
    doubles?: number[]
  }): void
}

export interface AppVariables {
  username?: string
  proxyKey?: ProxyKey
  proxyKeyHash?: string
  /** Cloudflare Access 校验通过后写入的登录用户邮箱（仅配置 CF_ACCESS_AUD 时存在） */
  cvAccessEmail?: string
  /**
   * forwardProxy 实际解析出的上游身份，供 analytics 归属使用。
   *
   * 背景：analytics context 在 handleProxy 里、**调用 forwardProxy 之前**创建，
   * 那时 provider 尚未解析，导致写入 Analytics Engine 的 providerId/providerName/
   * providerType/upstreamModel 全是空串——管理端「渠道」维度把流量归进一个空标签桶。
   * forwardProxy 解析出 provider 后写这里，handleProxy 取回合并进 context。
   */
  analyticsUpstream?: {
    providerId: string
    providerName: string
    providerType: string
    upstreamModel: string
  }
  /**
   * /v1/messages 与 /v1/responses 入口解析出的请求元信息，供外层包装补记 analytics。
   * 这两个入口此前完全不写用量，管理端统计里看不到走 Anthropic / Responses 协议的流量。
   */
  analyticsRequest?: {
    route: string
    model: string
    streamMode: 'sync' | 'stream'
  }
}

export type AppEnv = {
  Bindings: Env
  Variables: AppVariables
}
