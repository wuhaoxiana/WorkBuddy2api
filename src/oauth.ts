/**
 * oauth.ts — WorkBuddy / CodeBuddy OAuth 登录与 Token 续期。
 *
 * 只保留 WorkBuddy 用到的两条流程（原本还托管 Qoder / Gemini / M365，已在抽取时剥离）：
 *
 *  1. **browser（WorkBuddy 主路径）**
 *     POST {deviceCodeUrl} body={}  → {code:0, data:{state, authUrl}}
 *     用户在浏览器打开 authUrl 完成登录
 *     GET  {deviceTokenUrl}?state=xxx  → {code:0, data:{accessToken, refreshToken, expiresIn, domain}}
 *     刷新 POST {refreshTokenUrl} header X-Refresh-Token
 *     登录成功后按 JWT uid upsert 进账号池（oauth:pool:<providerId>）。
 *
 *  2. **device（RFC 8628 标准设备码）**
 *     作为通用兜底：若把 authType 改成 oauth-device 且 flowType 留空/填 'device'，
 *     走申请 device_code → 用户输 user_code → 轮询换 token 的标准流程。
 *
 * CN / Global 双域：账号属于哪个域由 access_token 的 JWT `iss` 判断
 * （含 workbuddy.ai = global，含 codebuddy.cn = cn）。Global 账号的推理、刷新必须
 * 走 www.workbuddy.ai，否则 copilot.tencent.com 的 APISIX 会返回 401。
 */
import { KV_KEYS, OAUTH_TOKEN_REFRESH_MARGIN_MS } from './config'
import type { Env, OAuthDeviceConfig, OAuthTokenState, DeviceFlowState } from './types'

// ===== KV 读写 =====

const deviceKey = (providerId: string) => KV_KEYS.OAUTH_DEVICE_PREFIX + providerId
const tokenKey = (providerId: string) => KV_KEYS.OAUTH_TOKEN_PREFIX + providerId

/** WorkBuddy 多账号池 KV 前缀（oauth-pool.ts 复用，避免循环依赖）。 */
export const OAUTH_POOL_KV_PREFIX = 'oauth:pool:'

/** 从 JWT payload 提取 uid（不验签；非 JWT 或无法解析返回空串）。 */
export function decodeJwtUid(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return ''
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const payload = JSON.parse(atob(b64)) as Record<string, any>
    if (!payload || typeof payload !== 'object') return ''
    for (const k of ['uid', 'user_id', 'userId', 'sub', 'UserID']) {
      const v = payload[k]
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
    }
    return ''
  } catch {
    return ''
  }
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.KV.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function readOauthToken(env: Env, providerId: string): Promise<OAuthTokenState | null> {
  return readJson<OAuthTokenState>(env, tokenKey(providerId))
}

async function writeOauthToken(env: Env, providerId: string, state: OAuthTokenState): Promise<void> {
  // 有 refresh_token 时 TTL 放宽到 30 天——access_token 2h 过期不能连带删除
  // 刷新凭据，否则离线续期功能失效；只有无 refresh_token（一次性 token）才随
  // access 过期清理，KV 到期自动回收避免残留。
  const ttlSeconds = state.refresh_token
    ? 86400 * 30
    : Math.min(Math.max(Math.ceil((state.expires_at - Date.now()) / 1000), 60), 86400 * 30)
  await env.KV.put(tokenKey(providerId), JSON.stringify(state), { expirationTtl: ttlSeconds })
}

export async function deleteOauthToken(env: Env, providerId: string): Promise<void> {
  await env.KV.delete(tokenKey(providerId))
}

/**
 * 构造转发到上游时使用的认证头：注入 tokenHeader + prefix + extraHeaders + cookies。
 * 供 proxy 转发、模型列表拉取、模型连通性测试复用，保证三者一致。
 * opts.origin 可覆盖 Origin/Referer（用于 Global 域路由）。
 */
export function buildOauthHeaders(
  cfg: OAuthDeviceConfig,
  token: string,
  opts?: { contentType?: string; origin?: string; apiType?: string; cookies?: string }
): Record<string, string> {
  const tokenHeader = cfg.tokenHeader || 'x-api-key'
  const prefix = cfg.tokenHeaderPrefix || ''
  // 自动补全：如果 prefix 非空且不以空格结尾，补一个空格（常见错误：Bearer 漏了空格）
  const safePrefix = prefix && !prefix.endsWith(' ') ? prefix + ' ' : prefix
  const headers: Record<string, string> = {
    'Content-Type': opts?.contentType ?? 'application/json',
    Accept: 'application/json',
    [tokenHeader]: safePrefix + token,
    ...(cfg.extraHeaders || {}),
  }
  if (opts?.origin) {
    headers['Origin'] = opts.origin
    headers['Referer'] = opts.origin + '/'
  }
  if (opts?.cookies) {
    headers['Cookie'] = opts.cookies
  }
  if (opts?.apiType === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  return headers
}

/**
 * 解析 access_token (JWT) 的 iss 判断账户领域。
 * WorkBuddy: Global (iss 含 workbuddy.ai) 必须走 www.workbuddy.ai，
 *            否则 copilot.tencent.com 的 APISIX 会返回 401；
 *            CN (iss 含 codebuddy.cn) 走 copilot.tencent.com。
 * 非 JWT 或无法解析时返回 null，调用方按 CN 默认处理。
 */
export function detectTokenRealm(token: string): 'global' | 'cn' | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const payload = JSON.parse(atob(b64)) as { iss?: string }
    const iss = String(payload?.iss || '').toLowerCase()
    if (iss.includes('workbuddy.ai')) return 'global'
    if (iss.includes('codebuddy.cn')) return 'cn'
    return null
  } catch {
    return null
  }
}

/** 是否为 Global 域 token（便捷封装） */
export function isGlobalToken(token: string): boolean {
  return detectTokenRealm(token) === 'global'
}

// ===== OAuth 流程入口（根据 flowType 分发） =====

export interface DeviceFlowResult {
  success: boolean
  message: string
  device?: DeviceFlowState
}

/**
 * 发起 OAuth 登录流程。根据 cfg.flowType 分发到浏览器登录或标准设备码模式。
 */
export async function startOauthDeviceFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
  if (cfg.flowType === 'browser') {
    return startOauthBrowserFlow(env, providerId, cfg)
  }
  return startOauthDeviceCodeFlow(env, providerId, cfg)
}

export type PollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'error'; message: string }

/**
 * 轮询 OAuth 授权结果。根据 KV 中存储的 flowType 分发。
 */
export async function pollOauthDeviceFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<PollResult> {
  const device = await readJson<DeviceFlowState>(env, deviceKey(providerId))
  if (!device) return { status: 'error', message: '没有进行中的登录流程，请重新发起' }

  // KV 中有 flowType 就按它走；没有则按 cfg 走（兼容旧数据）
  const flowType = device.flowType || cfg.flowType || 'device'
  if (flowType === 'browser') {
    return pollOauthBrowserFlow(env, providerId, cfg, device)
  }
  return pollOauthDeviceCodeFlow(env, providerId, cfg, device)
}

// ===== 设备码流程（RFC 8628） =====

async function startOauthDeviceCodeFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
  try {
    const params = new URLSearchParams({ client_id: cfg.clientId })
    if (cfg.scope) params.set('scope', cfg.scope)

    const res = await fetch(cfg.deviceCodeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { success: false, message: `申请设备码失败 HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }

    const data = (await res.json()) as {
      device_code: string
      user_code: string
      verification_uri?: string
      interval?: number
      expires_in?: number
    }

    if (!data.device_code || !data.user_code) {
      return { success: false, message: '设备码接口返回格式异常' }
    }

    const device: DeviceFlowState = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri || cfg.deviceCodeUrl,
      interval: data.interval || 5,
      expires_at: Date.now() + (data.expires_in || 600) * 1000,
      flowType: 'device',
    }
    await env.KV.put(deviceKey(providerId), JSON.stringify(device), { expirationTtl: 900 })
    return { success: true, message: '设备码已生成', device }
  } catch (err) {
    return { success: false, message: `申请设备码异常: ${(err as Error).message || '未知错误'}` }
  }
}

async function pollOauthDeviceCodeFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig, device: DeviceFlowState): Promise<PollResult> {
  if (Date.now() > device.expires_at) {
    await env.KV.delete(deviceKey(providerId))
    return { status: 'failed', message: '设备码已过期，请重新发起' }
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: cfg.clientId,
    })
    const res = await fetch(cfg.deviceTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (res.ok) {
      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
      if (!data.access_token) return { status: 'error', message: '轮询接口返回异常：缺少 access_token' }
      const expiresInSec = data.expires_in || 3600
      const tokenState: OAuthTokenState = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + expiresInSec * 1000,
        updated_at: Date.now(),
      }
      await writeOauthToken(env, providerId, tokenState)
      await browserPoolUpsert(env, providerId, tokenState)
      await env.KV.delete(deviceKey(providerId))
      return { status: 'success', message: 'OAuth 连接成功' }
    }

    const errorData = (await res.json().catch(() => ({ error: 'unknown' }))) as { error?: string; error_description?: string }
    switch (errorData.error) {
      case 'authorization_pending':
        return { status: 'pending', message: '等待用户授权…' }
      case 'slow_down':
        return { status: 'pending', message: '轮询过快，请稍候重试' }
      case 'expired_token':
        await env.KV.delete(deviceKey(providerId))
        return { status: 'failed', message: '设备码已过期，请重新发起' }
      case 'access_denied':
        await env.KV.delete(deviceKey(providerId))
        return { status: 'failed', message: '用户拒绝了授权' }
      default:
        return { status: 'error', message: `轮询异常: ${errorData.error_description || errorData.error || res.status}` }
    }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}

// ===== 浏览器登录流程（WorkBuddy/CodeBuddy 自定义 OAuth） =====
//
// 流程参考 cpa-plugin/workbuddy：
//   1. POST {deviceCodeUrl} body={}  → {code:0, data:{state, authUrl}}
//   2. 用户在浏览器打开 authUrl 完成登录
//   3. GET  {deviceTokenUrl}?state=xxx  → {code:0, data:{accessToken, refreshToken, expiresIn, domain}}
//   4. 刷新 POST {refreshTokenUrl} header X-Refresh-Token  → 同上

/** 构造 browser 模式的公共请求头；realm='global' 时用 globalOrigin 覆盖 Origin/Referer */
function browserCommonHeaders(cfg: OAuthDeviceConfig, realm?: 'cn' | 'global'): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    ...cfg.extraHeaders,
  }
  if (realm === 'global' && cfg.globalOrigin) {
    headers['Origin'] = cfg.globalOrigin
    headers['Referer'] = cfg.globalOrigin + '/'
  }
  return headers
}

/** browser 模式：解析本次登录使用的域（device 优先，其次 cfg，默认 cn） */
function browserRealm(cfg: OAuthDeviceConfig, device?: DeviceFlowState): 'cn' | 'global' {
  return (device?.loginRealm || cfg.loginRealm) === 'global' ? 'global' : 'cn'
}

/** browser 模式：按域解析发起/轮询/刷新端点；Global 端点缺失时返回空串（由调用方报错，不再静默回退国内端点） */
function browserCodeUrl(cfg: OAuthDeviceConfig, realm: 'cn' | 'global'): string {
  return realm === 'global' ? cfg.globalDeviceCodeUrl || '' : cfg.deviceCodeUrl
}
function browserTokenUrl(cfg: OAuthDeviceConfig, realm: 'cn' | 'global'): string {
  return realm === 'global' ? cfg.globalDeviceTokenUrl || '' : cfg.deviceTokenUrl
}
function browserRefreshUrl(cfg: OAuthDeviceConfig, realm: 'cn' | 'global'): string {
  return realm === 'global' ? cfg.globalRefreshTokenUrl || '' : cfg.refreshTokenUrl
}

/** CodeBuddy/WorkBuddy 的响应信封：{code, msg, data} */
interface CodeBuddyEnvelope<T = unknown> {
  code: number
  msg: string
  data?: T
}

interface CodeBuddyTokenData {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  domain?: string
}

interface CodeBuddyAuthStateData {
  state: string
  authUrl: string
}

async function startOauthBrowserFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<DeviceFlowResult> {
  try {
    // 发起登录前先确定域：WorkBuddy 国际版账号必须走 www.workbuddy.ai 端点
    const realm = browserRealm(cfg)
    const codeUrl = browserCodeUrl(cfg, realm)
    if (!codeUrl) {
      return { success: false, message: '登录域为国际版但未配置 Global 域发起端点（globalDeviceCodeUrl），请在 OAuth 配置中补全或改回国内版' }
    }
    const res = await fetch(codeUrl, {
      method: 'POST',
      headers: browserCommonHeaders(cfg, realm),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { success: false, message: `发起登录失败 HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }

    const env_resp = (await res.json()) as CodeBuddyEnvelope<CodeBuddyAuthStateData>
    if (env_resp.code !== 0 || !env_resp.data?.state || !env_resp.data?.authUrl) {
      return { success: false, message: `登录发起返回异常: code=${env_resp.code} msg=${env_resp.msg}` }
    }

    // cpa-plugin 核心要求：保存 Set-Cookie，轮询时必须复用同一个 cookie jar
    const setCookie = res.headers.get('Set-Cookie') || ''
    const allSetCookies: string[] = []
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') allSetCookies.push(value)
    })
    // 只记录数量，绝不打印 Cookie 原文（上游 Cookie 属账号会话凭据）
    console.log(`[oauth-start] provider=${providerId} Set-Cookie count: ${allSetCookies.length}`)
    const { state, authUrl } = env_resp.data
    const device: DeviceFlowState = {
      device_code: state, // browser 模式下 device_code 字段存 state
      user_code: '', // browser 模式无用户码
      verification_uri: authUrl, // 存登录页 URL
      interval: cfg.pollInterval || 5,
      expires_at: Date.now() + 5 * 60 * 1000, // 5 分钟超时（参考插件 loginTTL）
      flowType: 'browser',
      cookies: setCookie || undefined,
      loginRealm: realm,
    }
    await env.KV.put(deviceKey(providerId), JSON.stringify(device), { expirationTtl: 900 })
    return { success: true, message: '登录链接已生成', device }
  } catch (err) {
    return { success: false, message: `发起登录异常: ${(err as Error).message || '未知错误'}` }
  }
}

async function pollOauthBrowserFlow(env: Env, providerId: string, cfg: OAuthDeviceConfig, device: DeviceFlowState): Promise<PollResult> {
  if (Date.now() > device.expires_at) {
    await env.KV.delete(deviceKey(providerId))
    return { status: 'failed', message: '登录已超时（5 分钟），请重新发起' }
  }

  const state = device.device_code // browser 模式下存的是 state
  try {
    // 轮询必须与发起登录同域（device.loginRealm 固化），否则 state 在另一域无效
    const realm = browserRealm(cfg, device)
    const tokenUrl = browserTokenUrl(cfg, realm)
    if (!tokenUrl) {
      return { status: 'error', message: '登录域为国际版但未配置 Global 域轮询端点（globalDeviceTokenUrl），请在 OAuth 配置中补全或改回国内版' }
    }
    const sep = tokenUrl.includes('?') ? '&' : '?'
    const pollUrl = `${tokenUrl}${sep}state=${encodeURIComponent(state)}`
    const pollHeaders: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...cfg.extraHeaders,
    }
    // Global 域用 workbuddy.ai Origin/Referer 覆盖（extraHeaders 里是 codebuddy.cn）
    if (realm === 'global' && cfg.globalOrigin) {
      pollHeaders['Origin'] = cfg.globalOrigin
      pollHeaders['Referer'] = cfg.globalOrigin + '/'
    }
    // cpa-plugin 核心要求：轮询必须复用同一个 cookie jar，否则 token 无效导致 401
    if (device.cookies) {
      pollHeaders['Cookie'] = device.cookies
    }
    const res = await fetch(pollUrl, {
      method: 'GET',
      headers: pollHeaders,
      signal: AbortSignal.timeout(15000),
    })

    // 4xx 或业务码非 0 = 还在等待用户登录
    if (!res.ok) {
      return { status: 'pending', message: '等待用户在浏览器完成登录…' }
    }

    const env_resp = (await res.json().catch(() => null)) as CodeBuddyEnvelope<CodeBuddyTokenData> | null
    if (!env_resp || env_resp.code !== 0 || !env_resp.data?.accessToken) {
      return { status: 'pending', message: '等待用户在浏览器完成登录…' }
    }

    const tok = env_resp.data
    const now = Date.now()
    const expiresInSec = tok.expiresIn || 7200
    const expiresInMs = expiresInSec * 1000
    // 同 refreshBrowserTokenState：超 10 年量级的 expiresIn 视为脏值，回落 7200s 默认，
    // 避免 expires_at 被推到荒谬未来导致永不刷新。
    const safeExpiresMs = expiresInMs > 0 && expiresInMs < OAUTH_EXPIRES_IN_MAX_MS ? expiresInMs : 7200 * 1000
    // 保存 cookies 到 token 状态，后续模型拉取和 API 转发需要复用
    const newCookies = res.headers.get('Set-Cookie') || device.cookies || undefined
    // 只记录是否有 Cookie（长度），绝不打印原文
    console.log(`[oauth-poll] provider=${providerId} set-cookie from poll response: ${newCookies ? `yes (${newCookies.length} chars)` : '(none)'}`)
    console.log(`[oauth-poll] provider=${providerId} device.cookies from login: ${device.cookies ? `yes (${device.cookies.length} chars)` : '(none)'}`)
    const tokenState: OAuthTokenState = {
      access_token: tok.accessToken,
      refresh_token: tok.refreshToken,
      expires_at: now + safeExpiresMs,
      updated_at: now,
      cookies: newCookies,
    }
    await writeOauthToken(env, providerId, tokenState)
    // WorkBuddy 多账号池：每次成功登录把一个账号 upsert 进池（按 JWT uid 去重），
    // 池内多个账号按剩余积分自动挑选、错误冷却轮换。
    await browserPoolUpsert(env, providerId, tokenState)
    await env.KV.delete(deviceKey(providerId))
    return { status: 'success', message: 'OAuth 连接成功' }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}

/** 池内账号的最小结构（与 src/oauth-pool.ts 的 OAuthPoolAccount 保持字段兼容）。 */
interface BrowserPoolAccount {
  uid: string
  nickname?: string
  token: OAuthTokenState
  enabled: boolean
  state: { credits: number; disabled: boolean; reason?: string; until: number; errCount: number }
  updatedAt: number
}

/** 把一次成功登录的 browser token upsert 进 WorkBuddy 账号池（按 uid）。 */
async function browserPoolUpsert(env: Env, providerId: string, token: OAuthTokenState): Promise<void> {
  const uid = decodeJwtUid(token.access_token)
  if (!uid) return // 非 JWT（无法确定账号身份）不进池
  try {
    const key = OAUTH_POOL_KV_PREFIX + providerId
    const raw = await env.KV.get(key)
    let pool: BrowserPoolAccount[] = []
    try {
      pool = raw ? JSON.parse(raw) : []
    } catch {
      pool = []
    }
    if (!Array.isArray(pool)) pool = []
    const existing = pool.find((a) => a.uid === uid)
    if (existing) {
      existing.token = token
      existing.enabled = true
      existing.updatedAt = Date.now()
    } else {
      pool.push({
        uid,
        token,
        enabled: true,
        state: { credits: 0, disabled: false, until: 0, errCount: 0 },
        updatedAt: Date.now(),
      })
    }
    await env.KV.put(key, JSON.stringify(pool))
  } catch (e) {
    console.warn(`[oauth-pool] upsert failed: ${(e as Error).message}`)
  }
}

// ===== Token 刷新 =====

// 同一 provider 并发刷新去重。多个请求同时 401 → 同时 refresh 时，
// 会各自读到旧 state、并发打上游，上游 rotate refresh_token 后后写覆盖先写。
// 在 isolate 内存中合并同一 provider 的刷新任务，只打一次上游。
const refreshInflight = new Map<string, Promise<boolean>>()

/**
 * 使用 refresh_token 刷新 access_token。根据 flowType 分发。
 */
export function refreshOauthToken(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const existing = refreshInflight.get(providerId)
  if (existing) return existing
  const task = doRefreshOauthToken(env, providerId, cfg).finally(() => {
    refreshInflight.delete(providerId)
  })
  refreshInflight.set(providerId, task)
  return task
}

async function doRefreshOauthToken(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  if (cfg.flowType === 'browser') {
    return refreshOauthTokenBrowser(env, providerId, cfg)
  }
  return refreshOauthTokenDevice(env, providerId, cfg)
}

/** 设备码模式的 token 刷新（POST JSON: {refresh_token, client_id}） */
async function refreshOauthTokenDevice(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const state = await readOauthToken(env, providerId)
  if (!state?.refresh_token) return false

  try {
    const res = await fetch(cfg.refreshTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.refresh_token, client_id: cfg.clientId }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return false

    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
    if (!data.access_token) return false

    await writeOauthToken(env, providerId, {
      access_token: data.access_token,
      refresh_token: data.refresh_token || state.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      updated_at: Date.now(),
    })
    return true
  } catch {
    return false
  }
}

/** 浏览器登录模式的 token 刷新（POST header X-Refresh-Token）。 */
async function refreshOauthTokenBrowser(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<boolean> {
  const state = await readOauthToken(env, providerId)
  if (!state?.refresh_token) return false
  const fresh = await refreshBrowserTokenState(env, providerId, cfg, state)
  if (!fresh) return false
  await writeOauthToken(env, providerId, fresh)
  return true
}

/**
 * refresh / 登录响应 `expiresIn` 的量级上限（10 年）—— 纯防御值。
 *
 * 实测上游 refresh 响应恒带 `expiresIn=5184000`（60 天），且 JWT 的 `exp-iat` 与
 * `expiresIn` 严格自洽。超过 10 年的值只可能是上游脏数据，照写会把 `expires_at`
 * 推到荒谬未来 → 临近过期判定永假 → token 永不刷新 → 静默过期 → 401 路径把账号
 * **永久禁用**（需重登）。
 */
export const OAUTH_EXPIRES_IN_MAX_MS = 10 * 365 * 24 * 60 * 60 * 1000

/**
 * 对指定的 browser token state 执行刷新，返回新 state（供单 token 与 WorkBuddy 多账号池共用）。
 * 失败返回 null（调用方决定禁用/冷却账号）。
 */
export async function refreshBrowserTokenState(
  env: Env,
  providerId: string,
  cfg: OAuthDeviceConfig,
  state: OAuthTokenState
): Promise<OAuthTokenState | null> {
  if (!state?.refresh_token) return null
  try {
    // 按 token 的 JWT iss 判断域：Global 账号必须用 workbuddy.ai 刷新端点，否则 401
    const realm = detectTokenRealm(state.access_token) === 'global' ? 'global' : 'cn'
    const refreshUrl = browserRefreshUrl(cfg, realm)
    if (!refreshUrl) {
      console.warn(`[oauth-refresh] provider=${providerId} 国际版 token 但未配置 globalRefreshTokenUrl，跳过刷新`)
      return null
    }
    const res = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        ...browserCommonHeaders(cfg, realm),
        'X-Refresh-Token': state.refresh_token,
      },
      body: '',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null

    const env_resp = (await res.json().catch(() => null)) as CodeBuddyEnvelope<CodeBuddyTokenData> | null
    if (!env_resp || env_resp.code !== 0 || !env_resp.data?.accessToken) return null

    const tok = env_resp.data
    const now = Date.now()
    // expiresIn 缺省（≤0）或超 10 年量级（脏值）都**保留旧 expires_at**；
    // 旧值缺失（0）时才回落 7200s，避免 expires_at=0 导致每次请求都刷新。
    const expiresInMs = (tok.expiresIn ?? 0) * 1000
    const expiresAt = expiresInMs > 0 && expiresInMs < OAUTH_EXPIRES_IN_MAX_MS ? now + expiresInMs : state.expires_at || now + 7200 * 1000
    return {
      access_token: tok.accessToken,
      refresh_token: tok.refreshToken || state.refresh_token,
      expires_at: expiresAt,
      updated_at: now,
      // 刷新后必须保留/更新 cookie jar——browser 模式上游 API 依赖 cookie 会话
      cookies: res.headers.get('Set-Cookie') || state.cookies,
    }
  } catch {
    return null
  }
}

/**
 * 读取当前可用的 access_token。若缺失则返回 null；若即将过期则先刷新。
 */
export async function getOauthAccessToken(env: Env, providerId: string, cfg: OAuthDeviceConfig): Promise<string | null> {
  const state = await readOauthToken(env, providerId)
  if (!state?.access_token) return null

  const soon = state.expires_at - Date.now() < OAUTH_TOKEN_REFRESH_MARGIN_MS
  if (soon && state.refresh_token) {
    const ok = await refreshOauthToken(env, providerId, cfg)
    if (ok) {
      const fresh = await readOauthToken(env, providerId)
      return fresh?.access_token ?? null
    }
  }
  return Date.now() < state.expires_at ? state.access_token : null
}

/**
 * 供 Cron 定时任务调用：刷新所有已配置 OAuth 提供商中即将过期/已过期的 token。
 *
 * WorkBuddy（flowType=browser）：token 主要存于账号池（oauth:pool:{id}），而非单 token key。
 * 只读单 token key 会让**池内账号永不刷新**——请求路径虽会对「被选中的账号」做临期刷新，
 * 但低权重/长期冷却/已禁用的账号可能数周不被选中，其 access_token 长期处于过期状态、
 * refresh_token 若上游有闲置失效策略则会丢失（届时只能重新登录）。
 * 这里按池遍历做预防性保活，并对 12153 计数与 realm 做对齐维护。
 */
export async function refreshAllOauthTokens(env: Env, providers: ProviderLike[]): Promise<{ ok: number; fail: number }> {
  let ok = 0
  let fail = 0
  for (const p of providers) {
    if (p.authType !== 'oauth-device' || !p.oauth) continue
    const flow = p.oauth.flowType
    if (flow === 'browser') {
      const r = await refreshAllBrowserPoolTokens(env, p)
      ok += r.ok
      fail += r.fail
      continue
    }
    const state = await readOauthToken(env, p.id)
    if (!state?.refresh_token) continue
    if (state.expires_at - Date.now() > 5 * 60 * 1000) continue // 未临近过期，跳过
    const success = await refreshOauthToken(env, p.id, p.oauth)
    if (success) ok++
    else fail++
  }
  return { ok, fail }
}

/**
 * WorkBuddy（browser 流）账号池保活刷新（Cron 专用）。
 *
 * 节流策略（「临期 + 闲置」双阈值，避免每 2 小时无条件全池打上游）：
 *  - 临期：access_token 将在 NEAR_EXPIRY_MS 内过期 → 刷新；
 *  - 闲置：updatedAt 距今超过 IDLE_MS → 刷新（保活，重置池 KV 存活时间）；
 *  - 禁用账号：**跳过**（需人工重登，刷新必然失败，白打上游并产生噪音日志）。
 *
 * 为什么不用 oauth-pool.ts 的 refreshOauthPoolAccount：oauth.ts 是 oauth-pool.ts 的
 * 上游依赖（oauth-pool 从本模块 import），反向 import 会形成循环依赖。这里用与
 * browserPoolUpsert 同款的裸 KV 读写（OAUTH_POOL_KV_PREFIX + providerId），保持无环。
 */
async function refreshAllBrowserPoolTokens(env: Env, p: ProviderLike): Promise<{ ok: number; fail: number }> {
  const cfg = p.oauth!
  let ok = 0
  let fail = 0
  let pool: Array<{ uid: string; token: OAuthTokenState; enabled?: boolean; state?: { disabled?: boolean }; updatedAt?: number }> = []
  try {
    const raw = await env.KV.get(OAUTH_POOL_KV_PREFIX + p.id)
    const parsed = raw ? JSON.parse(raw) : []
    pool = Array.isArray(parsed) ? parsed : []
  } catch {
    return { ok: 0, fail: 0 } // 池损坏/不可读：不阻断其他 provider 的刷新
  }
  if (pool.length === 0) return { ok: 0, fail: 0 }

  const now = Date.now()
  // 临期阈值：access_token 过期前 10 分钟刷新（与请求路径 OAUTH_TOKEN_REFRESH_MARGIN_MS 同口径）
  const NEAR_EXPIRY_MS = 10 * 60 * 1000
  // 闲置阈值：超过 20 天未被刷新则保活一次
  const IDLE_MS = 20 * 24 * 60 * 60 * 1000

  // ===== 两阶段提交：先刷新产出补丁，最后重新读池合并写回 =====
  // 为什么分两阶段（丢失更新修复）：旧实现在**持有池快照期间**逐个账号 await 上游刷新
  // （每账号最长 15s 超时），循环结束后把整个 pool 原样写回。KV 没有 CAS，而写池的不止
  // 这里——请求路径会写冷却/errCount/lastUsed/credits，oauth-pool.noteOauthError 也会写。
  // 刷新期间这些并发写入会被最后那次「整体覆盖」静默吞掉：丢了冷却 → 坏号立刻被再次
  // 选中；丢了禁用 → 风控号复活。改为：刷新阶段只产出「uid → 新 token」补丁、不持有
  // 快照；提交阶段**重新读一次池**，只按 uid 打补丁再写回，把覆盖窗口从「整个刷新循环」
  // （数十秒）压到「一次 KV get→put」（毫秒级）。
  const updates = new Map<string, { token: OAuthTokenState; clearSessionDead: boolean }>()
  for (const acc of pool) {
    if (!acc || !acc.token?.refresh_token) continue
    // 禁用账号需人工重登，刷新必然失败 → 跳过（不白打上游、不产生噪音）
    if (acc.enabled === false || acc.state?.disabled) continue
    const expiresAt = typeof acc.token.expires_at === 'number' ? acc.token.expires_at : 0
    const nearExpiry = expiresAt - now <= NEAR_EXPIRY_MS
    const idle = typeof acc.updatedAt === 'number' && now - acc.updatedAt >= IDLE_MS
    if (!nearExpiry && !idle) continue

    const fresh = await refreshBrowserTokenState(env, p.id, cfg, acc.token)
    if (fresh) {
      updates.set(acc.uid, {
        token: fresh,
        // 刷新成功证明 session 未死 → 待清零 12153 连续失败计数。
        // 注意仅清计数，不动 disabled（禁用号上面已跳过）。
        clearSessionDead: !!acc.state && typeof acc.state === 'object' && 'sessionDeadFails' in acc.state,
      })
      ok++
    } else {
      fail++
      console.error(`[oauth] WorkBuddy 池账号刷新失败，可能需要重新登录 provider=${p.id} uid=${(acc.uid || '').slice(0, 8)} ${new Date().toISOString()}`)
    }
  }
  // 无变更不写回（避免无谓 KV 写放大）
  if (updates.size === 0) return { ok, fail }

  // 提交阶段：重新读池（拿最新状态）→ 按 uid 打补丁 → 写回。
  // 读失败/池损坏/非数组时**放弃写回**：宁愿本次 Cron 刷新不落盘，也不能用一份空池或
  // 坏池覆盖掉真实账号（那才是真正的数据损失）。
  try {
    const raw = await env.KV.get(OAUTH_POOL_KV_PREFIX + p.id)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) throw new Error('oauth pool is not an array')
    for (const acc of parsed) {
      if (!acc || typeof acc !== 'object' || typeof acc.uid !== 'string') continue
      const patch = updates.get(acc.uid)
      if (!patch) continue
      acc.token = patch.token
      acc.updatedAt = now
      if (patch.clearSessionDead && acc.state && typeof acc.state === 'object') {
        const st = acc.state as Record<string, unknown>
        if (st['sessionDeadFails']) st['sessionDeadFails'] = 0
      }
    }
    await env.KV.put(OAUTH_POOL_KV_PREFIX + p.id, JSON.stringify(parsed))
  } catch {
    /* KV 读/写失败不阻断 Cron */
  }
  return { ok, fail }
}

// ProviderLike 避免循环依赖：仅用 OAuth 相关字段
export interface ProviderLike {
  id: string
  authType?: 'api-key' | 'oauth-device'
  oauth?: OAuthDeviceConfig
}
