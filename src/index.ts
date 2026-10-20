import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import {
  adminAuthMiddleware,
  cloudflareAccessMiddleware,
  proxyKeyAuthMiddleware,
  managementAuthMiddleware,
  handleLogin,
  handleLogout,
} from './auth'
import { handleProxy, handleModels, handleAnthropicMessages, handleResponses } from './proxy'
import { RequestBodyError } from './request-body'
import {
  handleStatus,
  handleGetProviders,
  handleCreateProvider,
  handleUpdateProvider,
  handleUpsertProvider,
  handleDeleteProvider,
  handleTestModel,
  handleTestKeyNew,
  handleTestModelNew,
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
  handleOAuthStatus,
  handleOAuthConnect,
  handleOAuthPoll,
  handleOAuthDisconnect,
  handleOAuthPoolRemove,
  handleOAuthPoolToggle,
  handleOAuthPoolSetPrefer,
  handleOAuthPoolExport,
  handleOAuthModels,
  handleLogs,
  handleLogsClear,
  handleLogConfig,
  writeLog,
  handleGetCache,
  handleDeleteCache,
  handleClearCache,
  handleGetThinkingPrompt,
  handleSetThinkingPrompt,
  handleGetCachePrefix,
  handleSetCachePrefix,
  handleGetPerfSettings,
  handleSetPerfSettings,
} from './admin'
import { renderLoginPage, renderAdminPage } from './pages'
import { seedInitialData, getProviders } from './storage'
import { handleAnalyticsOverview, handleAnalyticsTrend, handleAnalyticsBreakdown, handleUsageLogs } from './analytics/admin-api'
import { refreshAllOauthTokens } from './oauth'
import {
  runAllCheckins,
  handleCheckinTrigger,
  handleCheckinStatus,
  handleAdminOverview,
  handleOAuthActivity,
  handleOAuthTravel,
  handleOAuthDaily,
} from './checkin'
import type { AppEnv, Env, Provider } from './types'

const app = new Hono<AppEnv>()

// ===== 全局中间件 =====
app.use('*', cors())
app.use('*', logger())

// ===== API 路径归一化 =====
// 1) 折叠重复前缀 /v1/v1/… → /v1/…；2) 常见根路径端点自动补 /v1。
// 用 308 重定向（保留方法与请求体），客户端只需跟随重定向一次。
// 很多客户端（Cherry Studio / LobeChat / 各类 SDK）把 Base URL 配成裸域名，
// 少了这一层就要用户在「Base URL 带不带 /v1」上反复试。
const API_ROOT_ALIASES = ['/chat/completions', '/completions', '/messages', '/responses', '/models']
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path === '/v1' || path.startsWith('/v1/')) {
    const folded = path.replace(/^\/v1(?:\/v1)+\//, '/v1/')
    if (folded !== path) return c.redirect(new URL(folded, c.req.url).toString(), 308)
  } else if (API_ROOT_ALIASES.includes(path)) {
    return c.redirect(new URL('/v1' + path, c.req.url).toString(), 308)
  }
  return next()
})

// 首次请求时填充默认数据（WorkBuddy 账号池 + 测试转发 Key）
let seeded = false
app.use('*', async (c, next) => {
  if (!seeded) {
    await seedInitialData(c.env)
    seeded = true
  }
  return next()
})

// ===== 健康检查（无需鉴权，供 LB/探活/监控） =====
app.get('/health', async (c) => c.json({ status: 'ok', ts: Date.now() }))

// ===== 根路径：直达管理控制台 =====
app.get('/', async (c) => c.redirect('/admin'))

// ===== 登录/退出 =====
app.get('/admin/login', async (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
// logout 改 POST-only——GET 会被链接型 CSRF 触发（SameSite=Lax 对顶层导航 GET 仍带 Cookie）
app.post('/admin/logout', handleLogout)

// ===== 管理后台（需 Session 验证） =====
// Cloudflare Access 加固：配置 CF_ACCESS_AUD + CF_ACCESS_TEAM_DOMAIN 后，
// 管理后台额外强制校验 Cf-Access-Jwt（未配置则放行）。只挂 /admin/*，
// 与客户端 /v1/* 的转发 Key 鉴权完全无关。
app.use('/admin/*', cloudflareAccessMiddleware)
app.use('/admin/*', adminAuthMiddleware)
// CSRF 防护——管理面写操作校验 Origin 与 Host 同源。
// 同源 fetch/表单都带 Origin；跨站提交（含旧浏览器无 Origin）另有 SameSite=Lax 兜底。
app.use('/admin/*', async (c, next) => {
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
  const origin = c.req.header('Origin')
  if (origin) {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return c.json({ success: false, message: '请求来源不合法' }, 403)
    }
    const host = c.req.header('Host') || ''
    if (originHost !== host) {
      return c.json({ success: false, message: '跨站请求被拒绝（CSRF 防护）' }, 403)
    }
  }
  return next()
})

app.get('/admin', async (c) => {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  return renderAdminPage(c)
})

// 系统状态
app.get('/admin/api/status', handleStatus)

// 提供商 CRUD
app.get('/admin/api/providers', handleGetProviders)
app.post('/admin/api/providers', handleCreateProvider)
app.put('/admin/api/providers/:id', handleUpdateProvider)
app.delete('/admin/api/providers/:id', handleDeleteProvider)
app.post('/admin/api/providers/:id/test-model', handleTestModel)
app.post('/admin/api/test-key', handleTestKeyNew)
app.post('/admin/api/test-model', handleTestModelNew)

// 转发 Key 管理
app.get('/admin/api/proxy-keys', handleGetProxyKeys)
app.post('/admin/api/proxy-keys', handleCreateProxyKey)
app.delete('/admin/api/proxy-keys/:id', handleDeleteProxyKey)
app.patch('/admin/api/proxy-keys/:id', handleUpdateProxyKey)

// OAuth（WorkBuddy 浏览器登录 / 设备码）
app.get('/admin/api/oauth/:id/status', handleOAuthStatus)
app.post('/admin/api/oauth/:id/connect', handleOAuthConnect)
app.post('/admin/api/oauth/:id/poll', handleOAuthPoll)
app.post('/admin/api/oauth/:id/disconnect', handleOAuthDisconnect)
// 账号池：删除指定 uid / 启用停用 / 首选 / 凭证导出
app.post('/admin/api/oauth/:id/pool/remove', handleOAuthPoolRemove)
app.post('/admin/api/oauth/:id/pool/prefer', handleOAuthPoolSetPrefer)
app.post('/admin/api/oauth/:id/pool/toggle', handleOAuthPoolToggle)
app.get('/admin/api/oauth/:id/pool/export', handleOAuthPoolExport)
// 生态任务：活跃上报、猫猫旅行、一键日常（签到 + 活跃 + 旅行）
app.post('/admin/api/oauth/:id/activity', handleOAuthActivity)
app.post('/admin/api/oauth/:id/travel', handleOAuthTravel)
app.post('/admin/api/oauth/:id/daily', handleOAuthDaily)
// 模型拉取有副作用（请求上游并自动合并保存到 provider.models），改 POST 防链接型 CSRF
app.post('/admin/api/oauth/:id/models', handleOAuthModels)

// 日志管理
app.get('/admin/api/logs', handleLogs)
app.delete('/admin/api/logs', handleLogsClear)
app.get('/admin/api/logs/config', handleLogConfig)
app.post('/admin/api/logs/config', handleLogConfig)

// 内存缓存管理
app.get('/admin/api/cache', handleGetCache)
app.delete('/admin/api/cache', handleClearCache)
app.delete('/admin/api/cache/:key', handleDeleteCache)

// 注入与性能设置
app.get('/admin/api/thinking-prompt', handleGetThinkingPrompt)
app.put('/admin/api/thinking-prompt', handleSetThinkingPrompt)
app.get('/admin/api/cache-prefix', handleGetCachePrefix)
app.put('/admin/api/cache-prefix', handleSetCachePrefix)
app.get('/admin/api/perf-settings', handleGetPerfSettings)
app.put('/admin/api/perf-settings', handleSetPerfSettings)

// 签到（浏览器面板用，需 session 认证）
app.get('/admin/api/checkin/status', handleCheckinStatus)
app.post('/admin/api/checkin', handleCheckinTrigger)

// 概览驾驶舱聚合：签到额度 + 到期提醒
app.get('/admin/api/overview', handleAdminOverview)

// Analytics Engine 用量统计（未绑定数据集时返回空数据，不报错）
app.get('/admin/api/analytics/overview', handleAnalyticsOverview)
app.get('/admin/api/analytics/trend', handleAnalyticsTrend)
app.get('/admin/api/analytics/breakdown', handleAnalyticsBreakdown)
app.get('/admin/api/usage-logs', handleUsageLogs)

// ===== 对外管理 API（需管理 Token 验证，供手机脚本等外部调用） =====
app.use('/api/manage/*', managementAuthMiddleware)
app.get('/api/manage/providers', handleGetProviders)
app.post('/api/manage/providers/upsert', handleUpsertProvider)
app.delete('/api/manage/providers/:id', handleDeleteProvider)
// 签到（脚本手动触发，需管理 Token）：不带 :id = 全量，带 :id = 单个 provider
app.post('/api/manage/checkin', handleCheckinTrigger)
app.post('/api/manage/checkin/:id', handleCheckinTrigger)

// ===== API 转发路由（需转发 Key 验证） =====
app.use('/v1/*', proxyKeyAuthMiddleware)
app.get('/v1/models', handleModels)

// Anthropic Messages API — 必须在 /v1/* 通配之前注册
app.post('/v1/messages', handleAnthropicMessages)

// OpenAI Responses API — 必须在 /v1/* 通配之前注册
app.post('/v1/responses', handleResponses)

// 通用转发（Chat Completions 及其他）
app.all('/v1/*', handleProxy)

// ===== 404 处理 =====
app.notFound((c) => c.json({ error: { message: '接口不存在', type: 'not_found' } }, 404))

// ===== 错误处理 =====
app.onError((err, c) => {
  // 请求体 JSON 解析失败（原生 Request.json() 会抛 SyntaxError）：返回 400 而非 500。
  if (err instanceof SyntaxError && /Unexpected (end of JSON input|token)/i.test(err.message)) {
    return c.json({ error: { message: '请求体 JSON 格式错误', type: 'bad_request' } }, 400)
  }
  // 入站请求体有界读取错误：超限 413，非法 JSON/multipart 400。
  if (err instanceof RequestBodyError) {
    if (err.code === 'REQUEST_TOO_LARGE') {
      return c.json({ error: { message: 'request body exceeds configured limit', type: 'invalid_request_error', code: 'REQUEST_TOO_LARGE' } }, 413)
    }
    if (err.code === 'INVALID_MULTIPART') {
      return c.json({ error: { message: 'multipart 请求体格式错误', type: 'invalid_request_error', code: 'INVALID_MULTIPART' } }, 400)
    }
    return c.json({ error: { message: '请求体 JSON 格式错误', type: 'invalid_request_error', code: 'INVALID_JSON' } }, 400)
  }
  console.error('未捕获的错误:', err)
  return c.json({ error: { message: '服务器内部错误', type: 'server_error' } }, 500)
})

// ===== Cron：定时任务（按 event.cron 分发） =====
//   "0 */2 * * *"   —— 每 2 小时刷新账号池内 Token（保活 + 临期续期）
//   "5 2,14 * * *"  —— 每日 10:05 / 22:05（北京时间）自动签到
//   "30 15 * * *"   —— 每日 23:30（北京时间）夜猫子任务（官方只在 CST 23:00–08:00 窗口内计数）
// ⚠️ Cloudflare ES Module Workers 只认 default export 上的 handler：
//    scheduled 若写成 named export（export async function scheduled），运行时找不到
//    default.scheduled，cron 触发后会被静默丢弃 → 定时签到/token 刷新均不执行。
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  if (event.cron === '5 2,14 * * *') {
    const summary = await runAllCheckins(env)
    console.log(`[checkin] cron done: total=${summary.total} ok=${summary.success} already=${summary.already} fail=${summary.fail} skipped=${summary.skipped}`)
    return
  }
  if (event.cron === '30 15 * * *') {
    // 夜猫子窗口（CST 23:30）：签到链里的 runWorkbuddyNightCat 只在 23:00–08:00 计数，
    // 而日常签到 cron 的 10:05/22:05 都不在窗口内，故必须单开一条窗口内 cron，
    // 否则夜猫子永远点不亮（函数早已实现但无触发时机）。
    // 复用签到链：它内部按 realm 分流，夜猫子只对 CN 账号发上报（global 无该体系）。
    try {
      const summary = await runAllCheckins(env)
      console.log(`[night-cat] cron done: total=${summary.total} ok=${summary.success} already=${summary.already} fail=${summary.fail}`)
    } catch (err) {
      console.error(`[night-cat] cron error: ${(err as Error).message}`)
    }
    return
  }
  // token 刷新（默认 / "0 */2 * * *"）：OAuth 提供商账号池临期刷新 + 闲置保活
  try {
    const providers = (await getProviders(env)) as Provider[]
    const oauthProviders = providers.filter((p) => p.authType === 'oauth-device' && p.oauth)
    const result = await refreshAllOauthTokens(env, oauthProviders)
    console.log(`[oauth] cron refresh done: ${result.ok} ok, ${result.fail} fail`)
  } catch (err) {
    console.error(`[oauth-cron] error: ${(err as Error).message}`)
  }
}

// fetch 与 scheduled 必须都挂在 default export 上，Cloudflare 才会注册并调用。
// Hono 的 fetch 为实例箭头属性，解构后 this 仍绑定 app，可安全赋值。
// 外层包装：X-Request-Id 全链路追踪——
//   - 取客户端 x-request-id / x-correlation-id，缺失则生成 UUID；
//   - 写回请求头（经 proxy 的白名单 x- 前缀自动透传到上游）；
//   - 响应头回写同 ID，客户端/日志可按 ID 串联网关与上游。
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const reqId = req.headers.get('x-request-id') || req.headers.get('x-correlation-id') || crypto.randomUUID()
    const reqHeaders = new Headers(req.headers)
    reqHeaders.set('x-request-id', reqId)
    const newReq = new Request(req, { headers: reqHeaders })
    const res = await app.fetch(newReq, env, ctx)
    const resHeaders = new Headers(res.headers)
    resHeaders.set('x-request-id', reqId)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: resHeaders })
  },
  scheduled,
}
