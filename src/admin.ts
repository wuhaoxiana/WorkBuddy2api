import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
  resolveProviderBaseUrl,
  getCacheEntries,
  deleteCacheEntry,
  clearCache,
  type CacheEntryView,
} from './storage'
import { testModelConnection } from './proxy'
import { MAX_ADMIN_REQUEST_BYTES, readOptionalJSONLimited, readStrictJSONLimited } from './request-body'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS } from './config'
import { startOauthDeviceFlow, pollOauthDeviceFlow, readOauthToken, deleteOauthToken, getOauthAccessToken, buildOauthHeaders, detectTokenRealm, OAUTH_POOL_KV_PREFIX } from './oauth'
import { isOAuthPoolProvider, seedOauthPoolFromSingle, listOauthPoolStatus, removeOauthAccount, readOauthPool, setOauthAccountEnabled } from './oauth-pool'
import { injectWorkbuddyChatHeaders, ensureGlobalFallbackSystem } from './workbuddy-upstream'
import { probeWorkbuddyModelCatalogForProvider, __resetWorkbuddyCatalogCacheForTests } from './workbuddy-models'
import type {
  AppEnv,
  Env,
  ApiResponse,
  Provider,
  ApiKeyEntry,
  Model,
  CreateProviderRequest,
  UpdateProviderRequest,
  UpsertProviderRequest,
  CreateProxyKeyRequest,
  TestModelRequest,
  OAuthDeviceConfig,
  OAuthTokenState,
} from './types'

// ===== 系统状态 =====

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组
 * 例: ["k1","k2"] → [{key:"k1",enabled:true},{key:"k2",enabled:true}]
 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  if (!Array.isArray(items)) return []
  if (items.length === 0 || typeof items[0] === 'string') {
    return (items as string[]).map(mapFn)
  }
  return items as T[]
}

/**
 * SSRF 防护：校验待 fetch 的 URL 是否安全（baseUrl / 测试 URL / OAuth 端点）。
 * - 只允许 http/https
 * - 拒绝带用户名/密码凭据的 URL
 * - 拒绝指向本机/内网/保留地址段的 IP 字面量（IPv4 / IPv6）
 * - 拒绝 localhost 等常见本机域名
 * 说明：纯域名无法在 Worker 端做 DNS 反查，依赖平台出网隔离兜底 DNS 重绑定。
 */
export function isSafeHttpUrl(value: string): boolean {
  if (!value || value.length > 2048) return false
  let u: URL
  try { u = new URL(value) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  // 常见本机/内网域名直接拒绝
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') ||
      host === 'metadata.google.internal') return false
  // IP 字面量 → 按网段判断；否则（正常域名）放行
  return !/^[\d.]+$/.test(host) ? true : !isPrivateIp(host)
}

function isPrivateIp(host: string): boolean {
  if (host.includes(':')) {
    // IPv6（可能带 []）；::ffff:a.b.c.d 映射回 IPv4 判断
    let v6 = host
    if (v6.startsWith('[') && v6.endsWith(']')) v6 = v6.slice(1, -1)
    const low = v6.toLowerCase()
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7))
    if (low === '::' || low === '::1') return true
    if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true // 链路本地
    if (low.startsWith('fc') || low.startsWith('fd')) return true // ULA
    return false
  }
  const parts = host.split('.').map((n) => parseInt(n, 10))
  if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 127) return true            // 本机/保留
  if (a === 10) return true                        // 10/8
  if (a === 169 && b === 254) return true          // 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true          // 192.168/16
  if (a === 192 && b === 0) return true            // 192.0.0.0/24（保留，含 192.0.0.9/10 任意播）
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 基准测试网段
  if (a >= 224) return true                        // 组播/广播/保留
  return false
}

/** 校验 OAuth 中会被服务端 fetch 的端点 URL；不合法返回错误文案，全部合法返回 null */
function validateOAuthUrls(oauth?: OAuthDeviceConfig): string | null {
  if (!oauth) return null
  const names: Array<[string, string | undefined]> = [
    ['deviceCodeUrl', oauth.deviceCodeUrl],
    ['deviceTokenUrl', oauth.deviceTokenUrl],
    ['refreshTokenUrl', oauth.refreshTokenUrl],
    ['modelsUrl', oauth.modelsUrl],
    ['globalBaseUrl', oauth.globalBaseUrl],
    ['globalModelsUrl', oauth.globalModelsUrl],
    ['globalDeviceCodeUrl', oauth.globalDeviceCodeUrl],
    ['globalDeviceTokenUrl', oauth.globalDeviceTokenUrl],
    ['globalRefreshTokenUrl', oauth.globalRefreshTokenUrl],
  ]
  for (const [name, v] of names) {
    if (v && !isSafeHttpUrl(v)) return `OAuth ${name} 必须是合法的 http/https 公网地址`
  }
  return null
}

export async function handleStatus(c: Context<AppEnv>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

// ===== 提供商 CRUD =====

/** S8a：对外管理 API 脱敏——只保留 Key 末尾 4 位，绝不把完整 apiKey 泄出到 /api/manage/* */
function maskApiKeys(providers: Provider[]): Provider[] {
  return providers.map((p) => ({
    ...p,
    apiKeys: p.apiKeys.map((k) => ({ enabled: k.enabled, key: k.key.length > 4 ? `****${k.key.slice(-4)}` : '****' })),
  }))
}

/** label 归一化：仅去空白、限长 120；空串视为清除（undefined）。 */
export function normalizeApiKeyLabel(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, 120)
  return s ? s : undefined
}

export async function handleGetProviders(c: Context<AppEnv>) {
  const providers = await getProviders(c.env)
  // /api/manage/*（外部管理 API）一律脱敏；/admin/api/*（浏览器后台）保持原样以便编辑
  if (new URL(c.req.url).pathname.startsWith('/api/manage/')) {
    return c.json<ApiResponse<Provider[]>>({ success: true, data: maskApiKeys(providers) })
  }
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<AppEnv>) {
  const body = await readStrictJSONLimited<CreateProviderRequest>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)

  if (!body.id || !body.name || !body.baseUrl) {
    return c.json<ApiResponse>({ success: false, message: 'id、name、baseUrl 为必填项' }, 400)
  }
  if (!isSafeHttpUrl(body.baseUrl)) {
    return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 http/https 公网地址' }, 400)
  }
  const oauthErr = validateOAuthUrls(body.oauth)
  if (oauthErr) {
    return c.json<ApiResponse>({ success: false, message: oauthErr }, 400)
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return c.json<ApiResponse>({ success: false, message: `提供商 id "${body.id}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id: body.id,
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/$/, ''),
    apiType: body.apiType || 'openai',
    authType: body.authType || 'api-key',
    oauth: body.oauth,
    cooldown: body.cooldown,
    allowUnlistedModels: body.allowUnlistedModels,
    thinkingInject: body.thinkingInject,
    cachePrefixInject: body.cachePrefixInject,
    apiKeys: normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true })),
    models: body.models
      ? normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
      : [],
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)
  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await readStrictJSONLimited<UpdateProviderRequest>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)

  const existing = await getProvider(c.env, id)
  if (!existing) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) {
    if (!isSafeHttpUrl(body.baseUrl)) {
      return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 http/https 公网地址' }, 400)
    }
    updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  }
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.authType !== undefined) updates.authType = body.authType
  if (body.oauth !== undefined) {
    const oauthErr = validateOAuthUrls(body.oauth)
    if (oauthErr) return c.json<ApiResponse>({ success: false, message: oauthErr }, 400)
    updates.oauth = body.oauth
  }
  if (body.cooldown !== undefined) updates.cooldown = body.cooldown ?? undefined
  if (body.allowUnlistedModels !== undefined) updates.allowUnlistedModels = body.allowUnlistedModels
  if (body.thinkingInject !== undefined) updates.thinkingInject = body.thinkingInject ?? undefined
  if (body.cachePrefixInject !== undefined) updates.cachePrefixInject = body.cachePrefixInject ?? undefined
  // 提示词模式三值（移植 ff64ecd 的 append）：非法值不落库，回落 undefined（=passthrough）
  if (body.promptMode !== undefined) {
    updates.promptMode = body.promptMode === 'custom' || body.promptMode === 'append' ? body.promptMode : undefined
  }
  if (body.promptText !== undefined) updates.promptText = body.promptText ?? undefined
  if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.models !== undefined) {
    updates.models = normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

/**
 * 对外管理 API：upsert + 合并。
 * - id 不存在 → 创建（需 name + baseUrl）
 * - id 存在 → 合并：name/baseUrl/apiType/authType/enabled 传了覆盖；
 *   apiKeys 按 key 字符串去重追加（保留原 enabled，永不删除）；
 *   models 按 id 去重追加（永不删除）；oauth 保留不动。
 * 供 /api/manage/providers/upsert 使用（需 managementAuthMiddleware）。
 */
export async function handleUpsertProvider(c: Context<AppEnv>) {
  const body = await readStrictJSONLimited<UpsertProviderRequest>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  if (!body.id) {
    return c.json<ApiResponse>({ success: false, message: 'id 为必填项' }, 400)
  }

  // 归一化入参 keys/models 为对象数组，确保 enabled 有值（normalizeArray 对象路径不补 enabled）
  const incomingKeys: ApiKeyEntry[] = (body.apiKeys || []).map((k) =>
    typeof k === 'string'
      ? { key: k, enabled: true }
      : { key: k.key, enabled: k.enabled !== undefined ? k.enabled : true, label: normalizeApiKeyLabel(k.label) }
  )
  const incomingModels: Model[] = (body.models || []).map((m) =>
    typeof m === 'string'
      ? { id: m, enabled: true }
      : { id: m.id, enabled: m.enabled !== undefined ? m.enabled : true }
  )

  const existing = await getProvider(c.env, body.id)

  // ===== 不存在 → 创建 =====
  if (!existing) {
    if (!body.name || !body.baseUrl) {
      return c.json<ApiResponse>({ success: false, message: '新建时 name、baseUrl 为必填项' }, 400)
    }
    if (!isSafeHttpUrl(body.baseUrl)) {
      return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 http/https 公网地址' }, 400)
    }
    const now = new Date().toISOString()
    const provider: Provider = {
      id: body.id,
      name: body.name,
      baseUrl: body.baseUrl.replace(/\/$/, ''),
      apiType: body.apiType || 'openai',
      authType: body.authType || 'api-key',
      apiKeys: incomingKeys,
      models: incomingModels,
      enabled: body.enabled !== undefined ? body.enabled : true,
      cooldown: body.cooldown,
      promptMode: body.promptMode,
      promptText: body.promptText,
      thinkingInject: body.thinkingInject,
      cachePrefixInject: body.cachePrefixInject,
      createdAt: now,
      updatedAt: now,
    }
    await addProvider(c.env, provider)
    return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
  }

  // ===== 存在 → 合并 =====
  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) {
    if (!isSafeHttpUrl(body.baseUrl)) {
      return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 http/https 公网地址' }, 400)
    }
    updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  }
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.authType !== undefined) updates.authType = body.authType
  if (body.cooldown !== undefined) updates.cooldown = body.cooldown
  // 提示词模式三值（custom / append / passthrough），非法值不落库
  if (body.promptMode !== undefined) {
    updates.promptMode = body.promptMode === 'custom' || body.promptMode === 'append' ? body.promptMode : 'passthrough'
  }
  if (body.promptText !== undefined) updates.promptText = body.promptText
  if (body.thinkingInject !== undefined) updates.thinkingInject = body.thinkingInject
  if (body.cachePrefixInject !== undefined) updates.cachePrefixInject = body.cachePrefixInject
  if (body.enabled !== undefined) updates.enabled = body.enabled

  // keys 合并：以现有为底，按 key 字符串去重追加，保留原 enabled
  if (body.apiKeys !== undefined) {
    const merged: ApiKeyEntry[] = [...existing.apiKeys]
    const existingKeySet = new Set(merged.map((k) => k.key))
    for (const k of incomingKeys) {
      if (existingKeySet.has(k.key)) continue  // 已存在：保留原项，不覆盖、不重复
      merged.push({ key: k.key, enabled: k.enabled, label: k.label })
      existingKeySet.add(k.key)
    }
    updates.apiKeys = merged
  }

  // models 合并：以现有为底，按 id 去重追加
  if (body.models !== undefined) {
    const merged: Model[] = [...existing.models]
    const existingModelSet = new Set(merged.map((m) => m.id))
    for (const m of incomingModels) {
      if (existingModelSet.has(m.id)) continue
      merged.push({ id: m.id, enabled: m.enabled })
      existingModelSet.add(m.id)
    }
    updates.models = merged
  }

  // oauth 不在 updates 中 → updateProvider 浅合并时保留 existing.oauth
  const updated = await updateProvider(c.env, body.id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

export async function handleDeleteProvider(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  // 同时删除 OAuth token 和设备码状态，避免残留数据干扰
  await deleteOauthToken(c.env, id)
  return c.json<ApiResponse>({ success: true, message: '提供商已删除' })
}

export async function handleTestModel(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await readStrictJSONLimited<TestModelRequest>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  // 注意：不校验模型是否已保存到 KV。测试的目的是验证"这个模型 ID 能否在上游用"，
  // 用户在编辑表单里新加的模型（尚未点保存）也应能直接测试，避免"先保存才能测"的割裂体验。
  // modelId 仅作为字符串透传给上游 chat/completions，与是否已入库无关。

  // OAuth 提供商：用 KV 中的 access_token 测试，无需 API Key
  if (provider.authType === 'oauth-device' && provider.oauth) {
    const cfg = provider.oauth
    const token = await getOauthAccessToken(c.env, provider.id, cfg)
    if (!token) {
      return c.json<ApiResponse>({ success: false, message: 'OAuth 未连接或 Token 已失效，请先发起连接' }, 400)
    }
    const tokenState = await readOauthToken(c.env, provider.id)
    const cookies = tokenState?.cookies
    // 域路由 + 401 自动切换：先尝试主域，401 时自动切换到备用域
    // CN token 不应尝试 Global 域（iss 不匹配，APISIX 必然 401）
    // aigateway 内部始终用 OpenAI chat/completions 格式与上游通信
    const endpoint = 'chat/completions'
    const tokenRealm = detectTokenRealm(token)
    const realms: Array<'cn' | 'global'> = tokenRealm === 'global' && cfg.globalBaseUrl
      ? ['global', 'cn']
      : tokenRealm === 'cn'
        ? ['cn']
        : ['cn', ...(cfg.globalBaseUrl ? ['global' as const] : [])]
    // WorkBuddy（browser 流）连通性测试必须补全官方协议头（X-CodeBuddy-Request / WorkBuddy UA /
    // X-Domain / X-Machine-ID 等）——否则全球域 WAF/限流把请求判为"非官方客户端形态"而返 429/403，
    // 与真实转发（proxy 侧注入同一套头）不一致，测出来的 429 是**假阴性**（实际 chat 可用）。
    const isWorkbuddyPool = provider.oauth?.flowType === 'browser' || (typeof provider.id === 'string' && provider.id.startsWith('workbuddy'))
    // WorkBuddy global 域 GPT/推理模型（如 gpt-5.4、gpt-6-sol）上游模型提供商要求 max_tokens ≥ 100
    // （否则上游报 400 11133 integer_below_min_value；对齐 workbuddy2api c6e849f / global_e2e_test.go:308），
    // 统一设为 100 保证全部模型均可通过
    const testMaxTokens = isWorkbuddyPool ? 100 : 1
    const testBody = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: testMaxTokens, stream: true })
    for (const realm of realms) {
      const realmBase = (realm === 'global' && cfg.globalBaseUrl ? cfg.globalBaseUrl : provider.baseUrl).replace(/\/$/, '')
      const origin = realm === 'global' && cfg.globalOrigin ? cfg.globalOrigin : (cfg.extraHeaders?.Origin)
      const url = `${realmBase}/${endpoint}`
      const headers = buildOauthHeaders(cfg, token, { origin, apiType: provider.apiType, cookies })
      if (isWorkbuddyPool) {
        injectWorkbuddyChatHeaders(headers, token, realm, tokenState ? { uid: tokenState.uid, enterprise_id: tokenState.enterprise_id, domain: tokenState.domain, device_token: tokenState.device_token } : undefined, cfg, { chatPath: true })
      }
      // 此处**直连上游**，不走 forwardProxy，故缺失真实转发管线里的
      // ensureGlobalFallbackSystem。global 域要求首条为 system，缺省会
      // 400 code 11128「first message is not system prompt」（补丁仅对 global）。
      const sendBody = realm === 'global'
        ? (() => {
            const obj = JSON.parse(testBody) as Record<string, unknown>
            ensureGlobalFallbackSystem(obj)
            return JSON.stringify(obj)
          })()
        : testBody
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: sendBody,
          signal: AbortSignal.timeout(20000),
        })
        // 401 且有备用域 → 自动切换重试
        if (response.status === 401 && realms.length > 1 && realm !== realms[realms.length - 1]) {
          console.log(`[test-model] ${realm} 域返回 401，自动切换到下一个域`)
          continue
        }
        // 非 2xx 时回显上游 body（截断），便于分辨 14017 未激活 / 6004 模型限流 / 普通 rate limit / 403 封禁
        let diag = ''
        if (!response.ok) {
          try {
            const raw = (await response.text()) || ''
            diag = raw && raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
          } catch { /* 读 body 失败忽略 */ }
        }
        const message = response.ok ? '' : `HTTP ${response.status}${diag ? `：${diag}` : ''}`
        return c.json<ApiResponse>({ success: true, data: { success: response.ok, statusCode: response.status, message } })
      } catch (err) {
        if (realms.length > 1 && realm !== realms[realms.length - 1]) continue
        return c.json<ApiResponse>({ success: true, data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' } })
      }
    }
    return c.json<ApiResponse>({ success: true, data: { success: false, statusCode: 0, message: '所有域均请求失败' } })
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const resolvedBase = resolveProviderBaseUrl(c.env, provider.baseUrl)
  if (!resolvedBase) {
    return c.json<ApiResponse>({ success: false, message: `提供商 "${provider.name}" 的 baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置` }, 400)
  }
  const result = await testModelConnection(resolvedBase, enabledKeys[0].key, modelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

export async function handleTestKeyNew(c: Context<AppEnv>) {
  const { url, apiKey } = await readStrictJSONLimited<{
    url: string
    apiKey: string
  }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  if (!url || !apiKey) {
    return c.json<ApiResponse>({ success: false, message: 'url 和 apiKey 为必填项' }, 400)
  }
  if (!isSafeHttpUrl(url)) {
    return c.json<ApiResponse>({ success: false, message: 'url 必须是合法的 http/https 公网地址' }, 400)
  }

  const resolvedUrl = resolveProviderBaseUrl(c.env, url)
  if (!resolvedUrl) {
    return c.json<ApiResponse>({ success: false, message: 'baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置' }, 400)
  }
  const cleanBase = resolvedUrl.replace(/\/$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    let errBody = ''
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    } else {
      // 读取上游错误体，写入日志便于排查（如 400/401 的具体原因）
      try {
        const raw = await response.text()
        errBody = raw.substring(0, 1000)
        await writeLog(c.env, 'error', `[test-key] ${cleanBase}/models → ${response.status}`, errBody)
      } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: {
        success: response.ok,
        statusCode: response.status,
        data,
        message: response.ok ? '' : `HTTP ${response.status}: ${errBody}`,
      },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

export async function handleTestModelNew(c: Context<AppEnv>) {
  const { url, apiKey, model } = await readStrictJSONLimited<{
    url: string
    apiKey: string
    model: string
  }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  if (!url || !model || !apiKey) {
    return c.json<ApiResponse>({ success: false, message: 'url、apiKey、model 为必填项' }, 400)
  }
  if (!isSafeHttpUrl(url)) {
    return c.json<ApiResponse>({ success: false, message: 'url 必须是合法的 http/https 公网地址' }, 400)
  }

  const resolvedUrl = resolveProviderBaseUrl(c.env, url)
  if (!resolvedUrl) {
    return c.json<ApiResponse>({ success: false, message: 'baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置' }, 400)
  }
  const cleanBase = resolvedUrl.replace(/\/$/, '')
  // aigateway 内部始终用 OpenAI chat/completions 格式与上游通信
  const endpoint = 'chat/completions'

  try {
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    })

    let errBody = ''
    if (!response.ok) {
      // 读取上游错误体并写日志，便于排查 4xx/5xx 具体原因
      try {
        const raw = await response.text()
        errBody = raw.substring(0, 1000)
        await writeLog(c.env, 'error', `[test-model] ${cleanBase}/${endpoint} model=${model} → ${response.status}`, errBody)
      } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: {
        success: response.ok,
        statusCode: response.status,
        message: response.ok ? '' : `HTTP ${response.status}: ${errBody}`,
      },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

// ===== 内存缓存管理（P4）=====

export async function handleGetCache(c: Context<AppEnv>) {
  return c.json<ApiResponse<CacheEntryView[]>>({ success: true, data: getCacheEntries() })
}

export async function handleDeleteCache(c: Context<AppEnv>) {
  const key = c.req.param('key')
  if (!key) return c.json<ApiResponse>({ success: false, message: '缺少 key 参数' }, 400)
  const deleted = deleteCacheEntry(decodeURIComponent(key))
  if (!deleted) return c.json<ApiResponse>({ success: false, message: `缓存项 "${key}" 不存在` }, 404)
  return c.json<ApiResponse>({ success: true, message: `已清除缓存 "${key}"` })
}

export async function handleClearCache(c: Context<AppEnv>) {
  const { cleared, total } = clearCache()
  return c.json<ApiResponse>({ success: true, message: `已清空缓存（${cleared}/${total}）`, data: { cleared, total } })
}

// ===== 转发 Key 管理 =====

export async function handleGetProxyKeys(c: Context<AppEnv>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<AppEnv>) {
  const body = await readStrictJSONLimited<CreateProxyKeyRequest>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间：自定义天数 > 自定义小时数 > 预设选项 > 永久
  let expiresAt: string | null = null
  let ttlSeconds = 0

  if (typeof body.expiresInDays === 'number' && body.expiresInDays > 0) {
    ttlSeconds = body.expiresInDays * 24 * 60 * 60
  } else if (typeof body.expiresInHours === 'number' && body.expiresInHours > 0) {
    ttlSeconds = body.expiresInHours * 60 * 60
  } else if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) ttlSeconds = ttl
  }

  if (ttlSeconds > 0) {
    expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
  }

  await addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export async function handleDeleteProxyKey(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await readStrictJSONLimited<{
    enabled?: boolean
    allowedModels?: string[]
    expiresIn?: string
    expiresInDays?: number
    expiresInHours?: number
  }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.allowedModels !== undefined) updates.allowedModels = body.allowedModels
  // 续期/修改过期时间：传了任一有效期字段时重算 expiresAt。
  // 语义为「从当前时间起重新计算新有效期」——已过期的 Key 也能直接续期恢复，
  // 无需删掉重加（新增会生成全新的 Key 字符串，客户端配置全要改）。
  // 优先级：自定义天数 > 自定义小时数 > 预设选项；'forever' 或全部无效 → 永久有效。
  if (body.expiresIn !== undefined || body.expiresInDays !== undefined || body.expiresInHours !== undefined) {
    let ttlSeconds = 0
    if (typeof body.expiresInDays === 'number' && body.expiresInDays > 0) {
      ttlSeconds = body.expiresInDays * 24 * 60 * 60
    } else if (typeof body.expiresInHours === 'number' && body.expiresInHours > 0) {
      ttlSeconds = body.expiresInHours * 60 * 60
    } else if (body.expiresIn && body.expiresIn !== 'forever') {
      const ttl = EXPIRY_OPTIONS[body.expiresIn]
      if (ttl) ttlSeconds = ttl
    }
    updates.expiresAt = ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null
  }
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}

// ===== OAuth 设备码管理 =====

/** 查询某 OAuth 提供商的连接状态（token 是否存在/过期时间；池提供商额外返回账号池状态） */
export async function handleOAuthStatus(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device') {
    return c.json<ApiResponse>({ success: false, message: '该提供商未启用 OAuth 认证' }, 400)
  }

  const token = await readOauthToken(c.env, id)
  const data: Record<string, unknown> = {
    connected: !!token,
    expiresAt: token?.expires_at ?? null,
    updatedAt: token?.updated_at ?? null,
    // 只暴露是否有 Cookie，绝不返回 Cookie 片段（会话凭据）
    hasCookies: !!(token?.cookies),
  }
  // WorkBuddy 多账号池：返回池账号状态（脱敏）供面板展示
  if (isOAuthPoolProvider(provider)) {
    try { await seedOauthPoolFromSingle(c.env, id) } catch { /* ignore */ }
    data.pool = await listOauthPoolStatus(c.env, id)
    data.preferUid = provider.preferOauthUid || ''
  }
  return c.json<ApiResponse>({ success: true, data })
}

/** 删除 WorkBuddy 池内指定 uid 账号。 */
export async function handleOAuthPoolRemove(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isOAuthPoolProvider(provider)) {
    return c.json<ApiResponse>({ success: false, message: '该提供商不是多账号池模式' }, 400)
  }
  const body = await readOptionalJSONLimited<{ uid?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const uid = String(body?.uid || '').trim()
  if (!uid) return c.json<ApiResponse>({ success: false, message: '缺少 uid 参数' }, 400)
  const removed = await removeOauthAccount(c.env, id, uid)
  if (!removed) return c.json<ApiResponse>({ success: false, message: '账号不存在' }, 404)
  return c.json<ApiResponse>({ success: true, message: '已从账号池删除 ' + uid })
}

/**
 * POST /admin/api/oauth/:id/pool/toggle：人工启用/禁用池内账号。
 *
 * WorkBuddy（国内 `codebuddy.cn` / 国际 `workbuddy.ai`）的账号池形态：一个 provider 一个账号池。
 *
 * 与「移除」的分工：禁用是**可逆暂停**（保留凭证、额度与昵称，只是不再被挑号），移除才是删除。
 * 写的是顶层 `enabled`（人工决定），面板刷新、签到解冻、token 刷新都不会覆盖它；
 * 恢复只能再点一次「启用」——这正是「我自己停掉的号不会被自动流程偷偷放回来」的保证。
 */
export async function handleOAuthPoolToggle(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isOAuthPoolProvider(provider)) {
    return c.json<ApiResponse>({ success: false, message: '该提供商不是多账号池模式' }, 400)
  }
  const body = await readOptionalJSONLimited<{ uid?: string; enabled?: boolean }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const uid = String(body?.uid || '').trim()
  if (!uid) return c.json<ApiResponse>({ success: false, message: '缺少 uid 参数' }, 400)
  // enabled 必须显式给 boolean：缺省按 true 处理的话，一个手滑的空 body 就会把账号「启用」，
  // 与禁用/启用对称、且失败安全的语义不符（停用是保守方向，恢复必须是有意为之）。
  if (typeof body?.enabled !== 'boolean') {
    return c.json<ApiResponse>({ success: false, message: '缺少 enabled 参数（true=启用 / false=禁用）' }, 400)
  }
  const ok = await setOauthAccountEnabled(c.env, id, uid, body.enabled)
  if (!ok) return c.json<ApiResponse>({ success: false, message: '账号不存在' }, 404)
  return c.json<ApiResponse>({ success: true, message: (body.enabled ? '已启用 ' : '已禁用 ') + uid })
}

/** POST /admin/api/oauth/:id/pool/prefer：设置首选账号（面板下拉框指定，留空则恢复自动挑选）。 */
export async function handleOAuthPoolSetPrefer(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (!isOAuthPoolProvider(provider)) {
    return c.json<ApiResponse>({ success: false, message: '该提供商不是多账号池模式' }, 400)
  }
  const body = await readOptionalJSONLimited<{ uid?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const uid = String(body?.uid || '').trim()
  // 校验 uid 必须是池内账号，防止乱填。
  if (uid) {
    const uids = (await listOauthPoolStatus(c.env, id)).map(a => String(a.uid))
    if (!uids.includes(uid)) return c.json<ApiResponse>({ success: false, message: '账号不存在' }, 400)
  }
  await updateProvider(c.env, id, { preferOauthUid: uid || undefined })
  return c.json<ApiResponse>({ success: true, message: uid ? '已指定首选账号 ' + uid : '已恢复自动挑选' })
}

/** GET /admin/api/oauth/:id/pool/export：导出账号池完整凭证与 Token。
 *  支持 query param ?uid=... 过滤单账号，?download=1 直接下发 JSON 附件。
 *  输出数据同时兼容 scripts/workbuddy/ 脚本库读取与外部调用。
 */
export async function handleOAuthPoolExport(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  const isWb = isOAuthPoolProvider(provider)

  let rawList: Array<{ uid: string; nickname?: string; token?: OAuthTokenState }> = []

  if (isWb) {
    try { await seedOauthPoolFromSingle(c.env, id) } catch { /* ignore */ }
    const pool = await readOauthPool(c.env, id)
    for (const a of pool) {
      rawList.push({ uid: a.uid, nickname: a.nickname, token: a.token })
    }
  }

  // 若池为空，回退尝试读取单 token
  if (rawList.length === 0) {
    const single = await readOauthToken(c.env, id)
    if (single) {
      rawList.push({
        uid: single.uid || id,
        nickname: single.uid || id,
        token: single,
      })
    }
  }

  const reqUid = c.req.query('uid')?.trim()
  if (reqUid) {
    rawList = rawList.filter(x => x.uid === reqUid)
    if (rawList.length === 0) {
      return c.json<ApiResponse>({ success: false, message: '未找到指定 UID 的账号凭证' }, 404)
    }
  }

  const exported = rawList.map(item => {
    const t = (item.token || {}) as OAuthTokenState
    const tokenStr = t.access_token || ''
    const domain = t.domain || ''
    return {
      uid: item.uid,
      nickname: item.nickname || item.uid,
      access_token: tokenStr,
      refresh_token: t.refresh_token || '',
      expires_at: t.expires_at || 0,
      domain,
      enterprise_id: t.enterprise_id || '',
      device_token: t.device_token || '',
      // workbuddy2api 格式
      auth: {
        accessToken: tokenStr,
        refreshToken: t.refresh_token || '',
        domain: domain,
      },
      account: {
        uid: item.uid,
        nickname: item.nickname || item.uid,
      },
      // ai-gateway 原始 token 结构
      token: t,
    }
  })

  if (c.req.query('download') === '1') {
    const filename = reqUid ? `workbuddy-${reqUid}.json` : `${id}-accounts.json`
    return new Response(JSON.stringify(reqUid && exported[0] ? exported[0] : exported, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  return c.json<ApiResponse>({ success: true, data: exported })
}

/** 发起 OAuth 设备码授权流程，返回授权链接与用户码 */
export async function handleOAuthConnect(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }

  const result = await startOauthDeviceFlow(c.env, id, provider.oauth)
  if (!result.success) {
    return c.json<ApiResponse>({ success: false, message: result.message }, 500)
  }
  return c.json<ApiResponse>({ success: true, data: result.device })
}

/** 轮询 OAuth 设备码授权结果 */
export async function handleOAuthPoll(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }

  const result = await pollOauthDeviceFlow(c.env, id, provider.oauth)
  return c.json<ApiResponse>({
    success: result.status === 'success',
    message: result.message,
    data: result.status === 'success' ? { connected: true } : { connected: false },
  })
}

/** 断开 OAuth 连接，删除 KV 中的 token（池提供商一并清空账号池） */
export async function handleOAuthDisconnect(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  await deleteOauthToken(c.env, id)
  // WorkBuddy 多账号池：断开即清空池内全部账号
  const p = await getProvider(c.env, id).catch(() => null)
  if (p && isOAuthPoolProvider(p)) {
    await c.env.KV.delete(OAUTH_POOL_KV_PREFIX + id).catch(() => {})
  }
  return c.json<ApiResponse>({ success: true, message: '已断开 OAuth 连接' })
}

/**
 * 解析上游模型列表响应，兼容三种格式：
 * ① WorkBuddy：{ code, data: { agents:[{name,models:[]}], models:[{id,disabled}] } }
 * ② OpenAI：{ data: [{id}] }
 * ③ 根级 models 数组：{ models: [{id}] }
 */
function parseModelList(json: any): Array<{ id: string }> {
  const models: Array<{ id: string }> = []
  if (json?.data?.agents && Array.isArray(json.data.agents)) {
    const cliAgent = json.data.agents.find((a: any) => a && a.name === 'cli' && Array.isArray(a.models))
    const cliModelIds: string[] = cliAgent?.models || []
    const modelMeta = new Map<string, any>(
      (json.data.models || []).map((m: any) => [m?.id, m] as [string, any]).filter(([k]: [string, any]) => k)
    )
    if (cliModelIds.length > 0) {
      models.push(...cliModelIds
        .filter((mid) => modelMeta.has(mid) && !modelMeta.get(mid)?.disabled)
        .map((mid) => ({ id: mid })))
    }
    if (models.length === 0) {
      models.push(...(json.data.models || [])
        .filter((m: any) => m && m.id && !m.disabled)
        .map((m: any) => ({ id: m.id })))
    }
  } else if (Array.isArray(json?.data)) {
    models.push(...json.data.filter((m: any) => m && m.id).map((m: any) => ({ id: m.id })))
  } else if (Array.isArray(json?.models)) {
    models.push(...json.models.filter((m: any) => m && m.id).map((m: any) => ({ id: m.id })))
  }
  return models
}

/**
 * 拉取 OAuth 提供商的上游模型列表（登录后动态发现，替代写死的预设模型）。
 * - 401 自动域切换：Global token 打到 CN 域会被 APISIX 拒绝（反之亦然），
 *   当 JWT 域判断不确定或配置缺失时，自动尝试另一个域。
 * - 参考 cpa-plugin/models.go 的 callModelsAPI 实现。
 */

/** WorkBuddy/CodeBuddy 静态候选模型与目录探测：**统一 owner** = workbuddy-models.ts。
 *
 *  P1 修正：此处原为 `WORKBUDDY_MODELS`（`glm-4.5/glm-4.6/.../doubao-1.5-pro`，上一代模型名）
 *  + `WORKBUDDY_GLOBAL_MODELS`，且注释称「上游无公开 models 端点，实测 /models 类路径均 404」
 *  「CN 域 /console/…/models 实测 404，无公开端点」。这两条结论**都与事实不符**：
 *  workbuddy2api 长期用同一 URL（与 pages.ts `_modelsUrl` 完全一致）做 CN 动态源且可用。
 *  该"404"很可能是当初未带 WorkBuddy 三段式 UA / `CommonHeaders` 探测所致。
 *
 *  现在 CN 与 global **对称**走动态探测（主路 `/v3/config` + 企业端点补缺），静态清单
 *  降级为"仅动态失败时的兜底"并标注 `stale`（见文件顶部 import 与 handleOAuthModels）。 */

// ===== WorkBuddy 模型目录动态探测（移植 workbuddy2api 0adc345 v3-config-merge） =====
// 目标：CN/global 对称走「/v3/config（主）+ 企业端点（补缺）」并发并集探测；
// 静态清单只是兜底（动态全失败时使用，并在响应里标注 stale）。
// 仅探测**模型名/元数据**，不做倍率/成本推断；结果只返回清单，入库仍靠用户「+」/保存。

/** 供测试清空模型目录探测缓存（转发到 workbuddy-models 的 owner）。 */
export function __resetGlobalModelsCacheForTests(): void {
  __resetWorkbuddyCatalogCacheForTests()
}

export { __resetWorkbuddyCatalogCacheForTests }

export async function handleOAuthModels(c: Context<AppEnv>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  if (provider.authType !== 'oauth-device' || !provider.oauth) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置 OAuth 认证' }, 400)
  }

  const cfg = provider.oauth

  // WorkBuddy/CodeBuddy：CN 与 global **对称**走动态目录探测
  // （主路 /v3/config + 企业端点补缺，并发并集；移植 workbuddy2api 0adc345 v3-config-merge）。
  //
  // P1 修正：此处原为「国内版仍用内置静态清单（CN 域 /console/…/models 实测 404，无公开端点）」。
  // 该结论与事实不符——workbuddy2api 长期用同一 URL 做 CN 动态源且可用（与本仓 pages.ts
  // `_modelsUrl` 完全一致）；"404"很可能是当初未带三段式 UA 探测所致。而旧静态清单
  // （glm-4.5/glm-4.6/deepseek-v3/…）与上游 CN 实际清单几乎完全不相交，用户据此入库后
  // 每次调用都撞 11102。现在 CN 也走动态，静态只在动态全失败时兜底并标注 stale。
  //
  // 结果只返回清单，入库仍靠用户「+」/保存。
  if ((provider.authType === 'oauth-device' && provider.oauth?.flowType === 'browser') || provider.id.startsWith('workbuddy')) {
    const wbToken = await getOauthAccessToken(c.env, provider.id, cfg)
    const wbRealm: 'cn' | 'global' = wbToken && detectTokenRealm(wbToken) === 'global' ? 'global' : 'cn'
    const probe = await probeWorkbuddyModelCatalogForProvider(c.env, provider, wbRealm)
    const models = probe.entries.map((m) => ({ id: m.id }))
    return c.json<ApiResponse>({
      success: true,
      data: {
        data: models,
        realm: wbRealm,
        // stale=true 表示两路动态探测全失败、这份清单是静态兜底（可能过期）
        stale: probe.stale,
        ...(probe.warnings.length > 0 ? { warnings: probe.warnings } : {}),
      },
    })
  }

  const token = await getOauthAccessToken(c.env, provider.id, cfg)
  if (!token) {
    return c.json<ApiResponse>({ success: false, message: 'OAuth 未连接或 Token 已失效，请先发起连接' }, 400)
  }
  const tokenState = await readOauthToken(c.env, provider.id)
  const cookies = tokenState?.cookies

  const debug: Record<string, unknown> = {
    realm: detectTokenRealm(token),
    tokenHeader: cfg.tokenHeader || 'x-api-key',
    tokenHeaderPrefix: cfg.tokenHeaderPrefix || '（前缀值不打印）',
    hasCookies: !!cookies,
    modelsUrl: cfg.modelsUrl || `${provider.baseUrl.replace(/\/$/, '')}/models`,
    baseUrl: provider.baseUrl,
    // extraHeaders 可能含 Origin/Referer 之外的敏感值（如 client_secret），只记头名
    extraHeaderNames: cfg.extraHeaders ? Object.keys(cfg.extraHeaders) : undefined,
    tokenExpiresAt: tokenState?.expires_at ? new Date(tokenState.expires_at).toISOString() : 'unknown',
  }

  const cleanBase = provider.baseUrl.replace(/\/$/, '')
  const realm = detectTokenRealm(token)

  // 构建候选端点：主域优先，备用域兜底（401 时自动切换）
  const cnEndpoint = {
    url: cfg.modelsUrl || `${cleanBase}/models`,
    origin: cfg.extraHeaders?.Origin as string | undefined,
    label: 'CN',
  }
  const globalUrl = cfg.globalModelsUrl
    || (cfg.globalBaseUrl ? `${cfg.globalBaseUrl.replace(/\/$/, '')}/models` : '')
  const globalEndpoint = globalUrl
    ? { url: globalUrl, origin: cfg.globalOrigin as string | undefined, label: 'Global' }
    : null

  // JWT 明确判定域时，对应端点优先；null/不确定时 CN 优先（baseUrl 默认 CN）
  // CN token 不应尝试 Global 域（iss 不匹配，APISIX 必然 401）
  const candidates = realm === 'global' && globalEndpoint
    ? [globalEndpoint, cnEndpoint]
    : realm === 'cn'
      ? [cnEndpoint]
      : [cnEndpoint, globalEndpoint].filter(Boolean) as typeof cnEndpoint[]

  const errors: string[] = []
  for (const ep of candidates) {
    try {
      const reqHeaders = buildOauthHeaders(cfg, token, { origin: ep.origin, cookies })
      debug['requestUrl'] = ep.url
      // 只记请求头名与是否有 Cookie（值长度），绝不打印 token / cookie 值
      debug['requestHeaders'] = Object.keys(reqHeaders).reduce((acc, k) => {
        const v = reqHeaders[k] || ''
        const lk = k.toLowerCase()
        if (lk === 'cookie') acc[k] = `yes (${v.length} chars)`
        else if (lk === 'x-api-key' || lk === 'authorization') acc[k] = v.length > 0 ? '***' : ''
        else acc[k] = v
        return acc
      }, {} as Record<string, string>)

      const response = await fetch(ep.url, {
        method: 'GET',
        headers: reqHeaders,
        signal: AbortSignal.timeout(20000),
      })

      if (response.ok) {
        const json: any = await response.json().catch(() => null)
        if (!json) {
          return c.json<ApiResponse>({ success: false, message: '上游响应不是有效 JSON', data: debug }, 502)
        }
        const models = parseModelList(json)
        if (models.length === 0) {
          return c.json<ApiResponse>({ success: false, message: '上游未返回任何模型', data: debug }, 502)
        }
        // 仅返回清单，用户手工「+」添加并保存后才入库（不自动写 provider.models）
        return c.json<ApiResponse>({ success: true, data: { data: models } })
      }

      let detail = ''
      try { detail = (await response.text()).substring(0, 500) } catch { /* ignore */ }
      const errMsg = `[${ep.label}] HTTP ${response.status}${detail ? '：' + detail : ''}`
      errors.push(errMsg)

      if ((response.status === 401 || response.status === 400) && candidates.length > 1) {
        continue
      }

      return c.json<ApiResponse>({
        success: false,
        message: `上游返回 HTTP ${response.status}${detail ? '：' + detail : ''} --- 调试信息 --- ${JSON.stringify(debug)}`,
        data: { debug, allErrors: errors },
      }, 502)
    } catch (err) {
      const errMsg = `[${ep.label}] ${(err as Error).message || '请求异常'}`
      errors.push(errMsg)
      if (candidates.length > 1) continue
      return c.json<ApiResponse>({ success: false, message: (err as Error).message || '拉取模型列表失败', data: { debug, allErrors: errors } }, 502)
    }
  }

  return c.json<ApiResponse>({
    success: false,
    message: `所有域均请求失败: ${errors.join(' | ')}`,
    data: { debug, allErrors: errors },
  }, 502)
}

// ===== 日志系统 =====

export interface LogEntry {
  id: string
  time: string
  type: 'info' | 'error' | 'warn' | 'request' | 'response'
  message: string
  details?: string
}

const LOG_PREFIX = 'log:'
const DEFAULT_LOG_RETENTION_DAYS = 7 // 默认日志保留天数
// 搜索模式下 KV.get 次数上限（与 KV.list 页数合计 ≤950 subrequest，动态收紧，见 handleLogs）
const SEARCH_SCAN = 990

/**
 * 从日志 key 名解析写入时间戳（毫秒）。
 * key 格式 = 'log:' + Date.now().toString(36) + Math.random().toString(36).slice(2,8)
 * 去掉 'log:' 前缀和 6 位随机后缀，剩余即 base36 时间戳。解析失败返回 NaN。
 * 用于搜索时按日期预过滤 key 名，免去对不相关时间段日志的 KV.get。
 */
function tsFromLogKey(name: string): number {
  const ts36 = name.slice(LOG_PREFIX.length, name.length - 6)
  const ts = parseInt(ts36, 36)
  return Number.isFinite(ts) ? ts : NaN
}

/**
 * 日志内容脱敏：日志里绝不落盘密钥原文。
 * 覆盖：Bearer token、sk_cf_* 类转发 Key、API Key、x-api-key / Authorization 值、
 * Cookie（会话凭据）、token / refresh_token / secret 类的 JSON 值。
 */
function sanitizeLogText(text: string): string {
  if (!text) return text
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1***')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}/gi, 'sk_***')
    .replace(/("?(?:x-api-key|authorization|api[-_]?key|refresh_token|access_token|client_secret|token)"?\s*[:=]\s*")[^"]{6,}(")/gi, '$1***$3')
    .replace(/(cookie[^=:=]*[:=]\s*"?)["',;][^"',;]{4,}["',;]/gi, '$1***')
    .replace(/(Set-Cookie[^,;]*=)[^,;]{4,}/gi, '$1***')
}

// ===== 日志 KV 写入 =====
// P4：log_enabled 开关做内存缓存（5s TTL），消除每请求 1 次 KV.get；开关切换时同步刷新。
let logEnabledCache = { at: 0, value: true }
const LOG_ENABLED_CACHE_TTL_MS = 5_000

/**
 * 日志开关判断（默认开启）：只有 KV 明确存 'false' 才关闭日志，
 * 'true'、缺失、空值或任何非 'false' 值均视为开启。
 * 修复"日志突然不记录"：原实现严格 === 'true'，一旦 KV 值异常/被覆盖
 * （如某次误写 '0'、'false 前导空格'、或 KV 为空）就会静默停止全部日志。
 */
async function isLogEnabled(env: Env): Promise<boolean> {
  if (Date.now() - logEnabledCache.at < LOG_ENABLED_CACHE_TTL_MS) return logEnabledCache.value
  const raw = await env.KV.get('config:log_enabled')
  const value = raw !== 'false' // 仅显式 'false' 视为关闭，其余均开启
  logEnabledCache = { at: Date.now(), value }
  return value
}

// 日志保留天数：KV config:log_retention_days 存储，5s 内存缓存，避免每请求 1 次 KV.get。
// 保留天数变化后最多 5 秒生效；超期日志由 KV expirationTtl 自动过期删除。
let logRetentionCache = { at: 0, days: DEFAULT_LOG_RETENTION_DAYS }

/** 读取日志保留天数（钳制到 1..365），带内存缓存 */
export async function getLogRetentionDays(env: Env): Promise<number> {
  if (Date.now() - logRetentionCache.at >= LOG_ENABLED_CACHE_TTL_MS) {
    const raw = await env.KV.get('config:log_retention_days')
    const n = Number(raw)
    logRetentionCache = {
      at: Date.now(),
      days: Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 365) : DEFAULT_LOG_RETENTION_DAYS,
    }
  }
  return logRetentionCache.days
}

/** 写日志到 KV */
export async function writeLog(env: Env, type: LogEntry['type'], message: string, details?: string) {
  // 检查是否启用日志
  if (!(await isLogEnabled(env))) return

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const entry: LogEntry = {
    id,
    time: new Date().toISOString(),
    type,
    message: sanitizeLogText(message),
    details: details ? sanitizeLogText(details).substring(0, 4000) : undefined,
  }
  // 保留天数动态设置过期时间：超期日志由 KV 自动删除
  const days = await getLogRetentionDays(env)
  await env.KV.put(LOG_PREFIX + id, JSON.stringify(entry), { expirationTtl: days * 24 * 60 * 60 })
}

/** 安全解析分页参数：非数字/缺失时回退默认值（R8：parseInt 遇 NaN 会污染 slice/limit） */
const toInt = (raw: string | null | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * 获取日志列表（支持 limit / offset 分页 + type / keyword / 日期范围搜索）。
 * 无搜索条件时只读本页窗口的 key（P5：subrequest 最小化）；
 * 有搜索条件时先用 key 名时间戳做日期预过滤（免 KV.get），再对命中 key 读取过滤——
 * 日期搜索可覆盖全部日志，关键词搜索扫描上限 SEARCH_SCAN 控 subrequest 在 1000 内。
 */
export async function handleLogs(c: Context<AppEnv>) {
  const limit = Math.min(Math.max(toInt(c.req.query('limit'), 50), 1), 200)
  const type = c.req.query('type') || ''
  const offset = Math.max(toInt(c.req.query('offset'), 0), 0)
  // 搜索条件：关键词（小写匹配 message+details）、日期范围（按 entry.time 绝对时间戳比较）
  const keyword = (c.req.query('keyword') || '').trim().toLowerCase().slice(0, 100)
  const startRaw = c.req.query('start') || ''
  const endRaw = c.req.query('end') || ''
  const startTime = startRaw ? new Date(startRaw).getTime() : NaN
  const endTime = endRaw ? new Date(endRaw).getTime() : NaN
  const hasFilter = !!(type || keyword || !Number.isNaN(startTime) || !Number.isNaN(endTime))

  // P5：KV.list 只拉 key 名（便宜）。
  // 注意：KV.list 按字典序升序返回（旧→新），新日志写在字典序末尾。
  // 旧实现按 MAX_KEY_SCAN=10 万条截断，一旦保留窗口内日志超过该数量，
  // 会漏掉字典序末尾的「最新日志」，导致系统日志停在旧窗口、看起来"突然不记录了"。
  // 因此必须遍历到 list_complete，保证最新日志一定能查到；
  // 只设 MAX_LIST_PAGES 防单请求 subrequest 超限（每页 1 次 KV.list）。
  const MAX_LIST_PAGES = 700 // 700 页 × 1000 = 70 万条，为后续 KV.get 留足 subrequest 余量
  const names: string[] = []
  let cursor: string | undefined
  let listPages = 0
  do {
    const list = await c.env.KV.list({ prefix: LOG_PREFIX, limit: 1000, cursor })
    cursor = list.list_complete ? undefined : list.cursor
    for (const k of list.keys) names.push(k.name)
    listPages++
  } while (cursor && listPages < MAX_LIST_PAGES)
  // key 名 = 'log:' + Date.now().toString(36) + 随机，字典序正序 = 旧→新；取最新在前
  names.reverse()
  const kvTotal = names.length

  // 无搜索：只读 offset..offset+limit 窗口的 key（原逻辑，type 过滤保持向后兼容）
  if (!hasFilter) {
    const logs: LogEntry[] = []
    const slice = names.slice(offset, offset + limit)
    for (let i = 0; i < slice.length; i += 25) {
      const raws = await Promise.all(slice.slice(i, i + 25).map((n) => c.env.KV.get(n)))
      for (const raw of raws) {
        if (!raw) continue
        try {
          const entry = JSON.parse(raw) as LogEntry
          if (!type || entry.type === type) logs.push(entry)
        } catch { /* skip corrupt entries */ }
      }
    }
    return c.json<ApiResponse>({ success: true, data: { logs: logs.slice(0, limit), total: kvTotal, offset } })
  }

  // 搜索：先用 key 名时间戳做日期预过滤（免 KV.get），大幅减少需读取的 key 数
  const startMs = Number.isNaN(startTime) ? -Infinity : startTime
  const endMs = Number.isNaN(endTime) ? Infinity : endTime
  const byDate = names.filter((n) => {
    const ts = tsFromLogKey(n)
    // 解析失败的 key 保留（保险，后续用 entry.time 兜底过滤）
    if (Number.isNaN(ts)) return true
    return ts >= startMs && ts <= endMs
  })
  // 控 subrequest：候选 key 上限 SEARCH_SCAN，并按已用 KV.list 页数动态收紧，
  // 保证 listPages + KV.get 总数不超 Workers 单请求 1000 subrequest 上限。
  const scan = byDate.slice(0, Math.min(SEARCH_SCAN, Math.max(0, 950 - listPages)))
  const matched: LogEntry[] = []
  for (let i = 0; i < scan.length; i += 25) {
    const raws = await Promise.all(scan.slice(i, i + 25).map((n) => c.env.KV.get(n)))
    for (const raw of raws) {
      if (!raw) continue
      try {
        const entry = JSON.parse(raw) as LogEntry
        if (type && entry.type !== type) continue
        // 日期已在 key 名预过滤，但解析失败的 key 仍需用 entry.time 兜底精确过滤
        if (!Number.isNaN(startTime) || !Number.isNaN(endTime)) {
          const ts = new Date(entry.time).getTime()
          if (!Number.isNaN(startTime) && ts < startTime) continue
          if (!Number.isNaN(endTime) && ts > endTime) continue
        }
        if (keyword) {
          const hay = ((entry.message || '') + '\n' + (entry.details || '')).toLowerCase()
          if (!hay.includes(keyword)) continue
        }
        matched.push(entry)
      } catch { /* skip corrupt entries */ }
    }
  }
  return c.json<ApiResponse>({
    success: true,
    data: {
      logs: matched.slice(offset, offset + limit),
      total: matched.length,
      offset,
      scanned: scan.length,
      kvTotal,
      truncated: byDate.length > scan.length,
    },
  })
}

/**
 * 清除日志。
 * - 带 expired=1：按保留天数清理——以当前时间为起点往前推，删除超过保留天数的日志。
 *   保留天数取 KV config:log_retention_days（与写日志时的过期策略一致），无需前端传日期。
 * - 不带参数：全量删除。
 * 均按 cursor 循环删除直至删完，设单次上限防止日志量过大时 subrequest 超限。
 */
export async function handleLogsClear(c: Context<AppEnv>) {
  const DELETE_CAP = 20000
  const expiredOnly = c.req.query('expired') === '1'
  let deleted = 0
  let skipped = 0
  if (expiredOnly) {
    const days = await getLogRetentionDays(c.env)
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    let cursor: string | undefined
    do {
      const list = await c.env.KV.list({ prefix: LOG_PREFIX, limit: 1000, cursor })
      cursor = list.list_complete ? undefined : list.cursor
      const targets = list.keys.filter((k) => {
        const ts = tsFromLogKey(k.name)
        return Number.isNaN(ts) ? false : ts < cutoff
      })
      for (let i = 0; i < targets.length; i += 50) {
        await Promise.all(targets.slice(i, i + 50).map((k) => c.env.KV.delete(k.name)))
      }
      deleted += targets.length
      skipped += list.keys.length - targets.length
    } while (cursor)
    return c.json<ApiResponse>({
      success: true,
      message: `已删除 ${deleted} 条超过保留天数（${days} 天）的日志${skipped ? `，保留范围内 ${skipped} 条` : ''}`,
    })
  }
  let cursor: string | undefined
  do {
    const list = await c.env.KV.list({ prefix: LOG_PREFIX, limit: 1000, cursor })
    cursor = list.list_complete ? undefined : list.cursor
    for (let i = 0; i < list.keys.length; i += 50) {
      await Promise.all(list.keys.slice(i, i + 50).map((k) => c.env.KV.delete(k.name)))
    }
    deleted += list.keys.length
  } while (cursor && deleted < DELETE_CAP)
  return c.json<ApiResponse>({
    success: true,
    message: deleted >= DELETE_CAP ? `已清除 ${deleted} 条（达到单次上限，可再次执行）` : '日志已清除',
  })
}

/** 获取/设置日志开关状态 + 保留天数 */
export async function handleLogConfig(c: Context<AppEnv>) {
  if (c.req.method === 'POST') {
    const body = await readOptionalJSONLimited(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
    // enabled 字段可选：未传时保持现有值（兼容只改保留天数的调用）
    if (body.enabled !== undefined) {
      const enabled = body.enabled ? 'true' : 'false'
      await c.env.KV.put('config:log_enabled', enabled)
      logEnabledCache = { at: Date.now(), value: enabled === 'true' }  // 立即刷新缓存
    }
    // 保留天数：1..365，非法值忽略
    if (body.retentionDays !== undefined) {
      const n = Number(body.retentionDays)
      if (Number.isFinite(n) && n > 0) {
        const days = Math.min(Math.trunc(n), 365)
        await c.env.KV.put('config:log_retention_days', String(days))
        logRetentionCache = { at: Date.now(), days }  // 立即刷新缓存
      }
    }
    const enabled = await c.env.KV.get('config:log_enabled')
    const retention = await getLogRetentionDays(c.env)
    return c.json<ApiResponse>({ success: true, data: { enabled: enabled !== 'false', retentionDays: retention } })
  }
  const enabled = await c.env.KV.get('config:log_enabled')
  const retention = await getLogRetentionDays(c.env)
  return c.json<ApiResponse>({ success: true, data: { enabled: enabled !== 'false', retentionDays: retention } })
}

/** 读取当前生效的思维引导提示词（含是否自定义标记） */
export async function handleGetThinkingPrompt(c: Context<AppEnv>) {
  const { getThinkingPrompt, isThinkingPromptCustom, DEFAULT_THINKING_PROMPT } = await import('./thinking')
  const [prompt, isCustom] = await Promise.all([getThinkingPrompt(c.env), isThinkingPromptCustom(c.env)])
  return c.json<ApiResponse>({ success: true, data: { prompt, isCustom, defaultPrompt: DEFAULT_THINKING_PROMPT } })
}

/** 保存（或清空）思维引导提示词。body.prompt 为空 → 清空回退默认。 */
export async function handleSetThinkingPrompt(c: Context<AppEnv>) {
  const { setThinkingPrompt } = await import('./thinking')
  const body = await readStrictJSONLimited<{ prompt?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
  await setThinkingPrompt(c.env, prompt)
  return c.json<ApiResponse>({ success: true, message: '已保存' })
}

// ===== 缓存前缀设置（KV 存储，管理后台可编辑）=====

/** 读取当前生效的缓存前缀（含是否自定义标记） */
export async function handleGetCachePrefix(c: Context<AppEnv>) {
  const { getCachePrefix, isCachePrefixCustom, DEFAULT_CACHE_PREFIX } = await import('./cache-prefix')
  const [prefix, isCustom] = await Promise.all([getCachePrefix(c.env), isCachePrefixCustom(c.env)])
  return c.json<ApiResponse>({ success: true, data: { prefix, isCustom, defaultPrefix: DEFAULT_CACHE_PREFIX } })
}

/** 保存（或清空）缓存前缀。body.prefix 为空 → 清空回退默认。 */
export async function handleSetCachePrefix(c: Context<AppEnv>) {
  const { setCachePrefix } = await import('./cache-prefix')
  const body = await readStrictJSONLimited<{ prefix?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const prefix = typeof body?.prefix === 'string' ? body.prefix : ''
  await setCachePrefix(c.env, prefix)
  return c.json<ApiResponse>({ success: true, message: '已保存' })
}

// ===== 性能设置（超时分级，KV 存储，管理后台可编辑）=====

/** 读取当前性能设置（含是否自定义与内置默认值） */
export async function handleGetPerfSettings(c: Context<AppEnv>) {
  const { getPerfSettings, isPerfSettingsCustom, DEFAULT_PERF_SETTINGS } = await import('./perf')
  const [settings, isCustom] = await Promise.all([getPerfSettings(c.env), isPerfSettingsCustom(c.env)])
  return c.json<ApiResponse>({ success: true, data: { settings, isCustom, defaults: DEFAULT_PERF_SETTINGS } })
}

/** 保存性能设置（部分字段合并，空对象 → 清空回退默认） */
export async function handleSetPerfSettings(c: Context<AppEnv>) {
  const { setPerfSettings } = await import('./perf')
  const body = await readStrictJSONLimited<{ settings?: Partial<import('./perf').PerfSettings> }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const settings = body?.settings ?? {}
  await setPerfSettings(c.env, settings)
  return c.json<ApiResponse>({ success: true, message: '已保存（最多 10s 生效）' })
}
