import type { OAuthDeviceConfig, Provider } from './types'

export const SITE_CONFIG = {
  title: 'WorkBuddy 2API',
  subtitle: 'WorkBuddy / CodeBuddy 账号池网关',
  description: 'WorkBuddy API 代理网关 — 多账号池 + 签到生态，统一 /v1 接口',
  author: 'WorkBuddy2api',
  authorUrl: 'https://github.com/IamNewHands/ai-gateway',
  favicon: 'https://pan.811520.xyz/icon/ai.webp',
  faCdn: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
}

export const SESSION_TTL = 7 * 24 * 60 * 60

export const PROXY_KEY_PREFIX = 'sk_wb_'

// Key 降权后自动恢复的冷却时间 (毫秒)
export const KEY_HEALTH_COOLDOWN_MS = 5 * 60 * 1000

// 连续失败多少次后降权
export const KEY_HEALTH_MAX_FAILURES = 5

export const KV_KEYS = {
  PROVIDERS: 'providers',
  PROXY_KEYS: 'proxy:keys',
  SESSION_PREFIX: 'admin:session:',
  KEY_HEALTH_PREFIX: 'key:health:',
  /** 单 token（非池）OAuth 状态：oauth:token:<providerId> */
  OAUTH_TOKEN_PREFIX: 'oauth:token:',
  /** 进行中的登录流程（浏览器登录 state / 设备码）：oauth:device:<providerId> */
  OAUTH_DEVICE_PREFIX: 'oauth:device:',
  CHECKIN_RESULT_PREFIX: 'checkin:result:',
  LOGIN_RATE: 'login:rate:',
  THINKING_PROMPT: 'thinking:prompt',
  CACHE_PREFIX: 'cache:prefix',
  PERF_SETTINGS: 'perf:settings',
  RESPONSES_PREFIX: 'proxy:responses:',
  /** Responses 别名（previous_response_id）元数据：分支不可变 + call_id 一次性消费记录 */
  RESPONSES_ALIAS_PREFIX: 'proxy:resp-alias:',
  /** Responses 别名所属会话的 call_id 消费表（防重复执行有副作用工具） */
  RESPONSES_CONSUMED_PREFIX: 'proxy:resp-consumed:',
} as const

// access_token 过期前多少毫秒触发惰性刷新（默认提前 60 秒）
export const OAUTH_TOKEN_REFRESH_MARGIN_MS = 60 * 1000

// 签到结果在 KV 中的保留时间（2 天，足够展示当日状态）
export const CHECKIN_RESULT_TTL_SEC = 2 * 24 * 60 * 60

// 有效期选项（秒）
export const EXPIRY_OPTIONS: Record<string, number | null> = {
  '30d': 30 * 24 * 60 * 60,
  '90d': 90 * 24 * 60 * 60,
  '180d': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  forever: null,
}

/**
 * WorkBuddy 官方端点预设（CN 域 + Global 域）。
 *
 * 由管理后台「一键填充」与管理 API 共用，避免两处各写一份端点清单。
 * 账号属于哪个域由 access_token 的 JWT `iss` 决定（见 oauth.ts detectTokenRealm），
 * 与这里填的「登录域」是两件事：登录域只决定**去哪拿 token**。
 */
export const WORKBUDDY_OAUTH_PRESET: OAuthDeviceConfig = {
  flowType: 'browser',
  deviceCodeUrl: 'https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI',
  deviceTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token',
  refreshTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
  clientId: '',
  tokenHeader: 'Authorization',
  tokenHeaderPrefix: 'Bearer ',
  extraHeaders: {
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
  },
  modelsUrl: 'https://copilot.tencent.com/console/enterprises/personal/models',
  globalBaseUrl: 'https://www.workbuddy.ai/v2',
  globalModelsUrl: 'https://www.workbuddy.ai/console/enterprises/personal/models',
  globalOrigin: 'https://www.workbuddy.ai',
  globalDeviceCodeUrl: 'https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI',
  globalDeviceTokenUrl: 'https://www.workbuddy.ai/v2/plugin/auth/token',
  globalRefreshTokenUrl: 'https://www.workbuddy.ai/v2/plugin/auth/token/refresh',
  loginRealm: 'cn',
}

/**
 * 首次部署的默认提供商：一个空的 WorkBuddy 账号池。
 * 打开管理后台点「添加账号」即可开始登录，无需手填端点。
 */
export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    baseUrl: 'https://copilot.tencent.com/v2',
    apiType: 'openai',
    authType: 'oauth-device',
    oauth: WORKBUDDY_OAUTH_PRESET,
    apiKeys: [],
    models: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]
