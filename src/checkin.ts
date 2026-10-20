/**
 * checkin.ts — WorkBuddy/CodeBuddy 每日签到（移植自 cpa-plugin/workbuddy）。
 *
 * 协议（来源 cpa-plugin/workbuddy/billing.go）：
 *   状态：POST https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status（fallback .../checkin-status）
 *   签到：POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin
 *   认证：Authorization: Bearer <access_token>
 *   信封：{ code, msg, data }，code=0 成功
 *
 * 流程（对齐 checkin.go/checkinOneAccount）：
 *   Global 账号跳过 → 调状态 → today_checked_in 则跳过 → 否则调 daily-checkin
 *   → code=0 成功；业务错误 msg 含「已签/already/今日」视为已签到
 *
 * 仅 CN 账号（JWT iss 含 codebuddy.cn）可签到；Global（workbuddy.ai）无签到。
 * 多账号：遍历所有 oauth-device provider，各自签到。
 */
import { Context } from 'hono'
import type { Env, Provider, CheckinResult, ApiResponse } from './types'
import { KV_KEYS, CHECKIN_RESULT_TTL_SEC, OAUTH_TOKEN_REFRESH_MARGIN_MS } from './config'
import { getProviders } from './storage'
import { getOauthAccessToken, detectTokenRealm } from './oauth'
import { writeLog } from './admin'
import {
  packageExpiryEntry,
  summarizeExpiringAt,
  isExpiringCredit,
  CREDIT_EXPIRY_WINDOW_MS,
  type CreditExpiryEntry,
  type ExpiringCreditSummary,
} from './credit-expiry'
import {
  isOAuthPoolProvider,
  readOauthPool,
  refreshOauthPoolAccount,
  reenableOauthIfCredits,
  seedOauthPoolFromSingle,
  setOauthPoolAccountNickname,
} from './oauth-pool'
import type { OAuthPoolAccount } from './oauth-pool'
import {
  billingCall,
  pickBool,
  pickNum,
  decodeWorkbuddyClaims,
  fetchWorkbuddyCredits,
  fetchWorkbuddyPaymentType,
  reportWorkbuddyChatActivity,
  fetchWorkbuddyStreak,
  runWorkbuddyCatTravel,
  runWorkbuddyGrowthRewards,
  runWorkbuddyNightCat,
  runWorkbuddyBlindBox,
  fetchWorkbuddyRewardState,
  type WorkbuddyRewardState,
  isAlreadyCheckin,
  billingMeterPaths,
  claimGlobalTrial,
  delayMs,
  completeGlobalRegionFlow,
  fetchIntlCountries,
  type RegionCountry,
  ACTIVITY_ACCOUNT_DELAY_MS,
} from './workbuddy-billing'
import { MAX_ADMIN_REQUEST_BYTES, readOptionalJSONLimited } from './request-body'

/**
 * 国际版注册地区默认兜底（取不到白名单时用，region 完善提交所需）。
 * 与源实现 global_region.py 的默认选择对齐（新加坡）。
 */
const FALLBACK_GLOBAL_REGION: RegionCountry = {
  EnName: 'Singapore',
  Name: 'Singapore',
  IOS2: 'SG',
  IOS3: 'SGP',
  Code: '65',
}

/**
 * 取国际版注册地区：优先 `/billing/area/get-country-code` 白名单第一条
 * （顺序 = web 展示顺序，HK 起），拉取失败回退默认地区。
 */
async function pickGlobalRegion(): Promise<RegionCountry> {
  try {
    const r = await fetchIntlCountries(true)
    if (r.ok && r.list.length > 0) return r.list[0]
  } catch { /* 回退默认 */ }
  return FALLBACK_GLOBAL_REGION
}

/**
 * global 账号注册激活自愈（移植 workbuddy2api activate_region / complete_flow）。
 *
 * 上游对「未完成注册激活」的试用账号，所有 chat/completions 请求都会返回
 * 429 code 14017（"trial version is not yet activated"），换号/重试/退避均无效。
 * 这里先补齐 register + 注册地区完善（幂等：已激活时仅一次 register 查询即返回），
 * 再配合调用方领取一次性 trial 加油包，打通试用通道。
 *
 * 失败只返回结果、不抛出，由调用方记录面板展示；不影响 global 签到语义。
 */
async function ensureGlobalActivation(token: string, uid: string): Promise<{ ok: boolean; message: string }> {
  const res = await completeGlobalRegionFlow(token, uid, await pickGlobalRegion())
  return { ok: res.ok, message: res.msg }
}

/** 查询签到状态。依次试两个端点（CPA fallback 模式）。 */
async function fetchCheckinStatus(
  token: string,
  realm: 'cn' | 'global'
): Promise<{ active: boolean; todayCheckedIn: boolean; streakDays?: number; totalCredits?: number; dailyCredit?: number } | null> {
  // 状态端点候选序列：CN 用带 /v2 的两种拼写；global 另加无 /v2 前缀形态（源实现 R9：
  // 国际版无 /v2 前缀，路径族按 realm 切）。仅 404 会换下一条（billingCall 的 paths 语义）。
  const paths = realm === 'global'
    ? [
        '/billing/meter/checkin-activity-status', '/billing/meter/checkin-status',
        '/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status',
      ]
    : ['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status']
  let lastErr: Error | null = null
  for (const path of paths) {
    try {
      const data = await billingCall(token, path, realm, { paths: [path] })
      const m = (data || {}) as Record<string, any>
      return {
        active: pickBool(m, 'active', 'Active'),
        todayCheckedIn: pickBool(m, 'today_checked_in', 'todayCheckedIn'),
        streakDays: pickNum(m, 'streak_days', 'streakDays'),
        totalCredits: pickNum(m, 'total_credits', 'totalCredits'),
        dailyCredit: pickNum(m, 'daily_credit', 'dailyCredit'),
      }
    } catch (e) {
      lastErr = e as Error
    }
  }
  // 状态查询失败不致命（签到调用本身幂等），返回 null 让调用方决定
  console.warn(`[checkin] status fetch failed: ${lastErr?.message}`)
  return null
}

/** 执行签到。返回 { success, message, reward?, already? }。 */
export async function performCheckin(
  token: string,
  realm: 'cn' | 'global',
  env?: Env
): Promise<{ success: boolean; message: string; reward?: any; already?: boolean }> {
  try {
    // 路径按 realm 切（global 无 /v2 前缀优先，404 时 fallback），对齐 workbuddy2api checkinMeterPaths。
    // 当前 global 账号在上层已提前 return（不签到），此处保持按 realm 正确以便未来放开即生效。
    const paths = billingMeterPaths('daily-checkin', realm)
    const data = await billingCall(token, paths[0], realm, { paths })
    return { success: true, message: '签到成功', reward: data }
  } catch (e) {
    // 幂等判定走三段式（移植 workbuddy2api cmd/signin/main.go）：
    // 结构化业务错误（BillingError）认业务码 10001/14001（带边界）+ 全量文案；
    // 传输层/解析层裸错误只认中文文案，避免 "address already in use" 这类文本被误判为已签到。
    if (isAlreadyCheckin(e)) {
      return { success: true, message: '今日已签到', already: true }
    }
    return { success: false, message: (e as Error).message }
  }
}

// JWT 解码 / 额度拉取已抽到 src/workbuddy-billing.ts（decodeWorkbuddyClaims / fetchWorkbuddyCredits / fetchWorkbuddyPaymentType）

/**
 * 拉取额度 + 套餐类型并填充到 base。额度拉取抛错时写日志（含 uid/eid 诊断）。
 * 在所有 return 前调用，确保"今日已签"也能拿到额度。
 */
async function fillCredits(env: Env, base: CheckinResult, token: string, realm: 'cn' | 'global', uid: string, enterpriseId: string, deviceToken?: string) {
  try {
    const credits = await fetchWorkbuddyCredits(token, realm, uid, enterpriseId, deviceToken)
    base.totalRemain = credits.totalRemain
    base.totalUsed = credits.totalUsed
    base.totalSize = credits.totalSize
    base.packCount = credits.packCount
    if (credits.packages && credits.packages.length > 0) {
      base.packages = credits.packages
    }
  } catch (e) {
    try { await writeLog(env, 'warn', `[checkin] ${base.name} 额度拉取失败: ${(e as Error).message}`, `uid=${uid || '(空)'} eid=${enterpriseId || '(空)'}`) } catch { /* ignore */ }
  }
  try {
    const pt = await fetchWorkbuddyPaymentType(token, realm, uid, enterpriseId)
    if (pt) base.paymentType = pt
  } catch { /* ignore */ }
}

// ===== KV 结果读写 =====

const resultKey = (providerId: string) => KV_KEYS.CHECKIN_RESULT_PREFIX + providerId

export async function readCheckinResult(env: Env, providerId: string): Promise<CheckinResult | null> {
  const raw = await env.KV.get(resultKey(providerId))
  // R9：损坏的 JSON 视为无结果，不能让 JSON.parse 抛错打断签到列表渲染
  if (!raw) return null
  try {
    return JSON.parse(raw) as CheckinResult
  } catch {
    return null
  }
}

async function writeCheckinResult(env: Env, providerId: string, result: CheckinResult): Promise<void> {
  try {
    await env.KV.put(resultKey(providerId), JSON.stringify(result), {
      expirationTtl: CHECKIN_RESULT_TTL_SEC,
    })
  } catch (e) {
    console.warn(`[checkin] write result failed: ${(e as Error).message}`)
  }
}

// ===== 单账号签到 =====

/**
 * 把刚拉到的额度写回池账号 state.credits（对齐 workbuddy-wild ReenableIfCredits）：
 * 所有拿到额度的路径（成功/已签/global）都调用，否则池面板"积分"会一直显示 0。
 *
 * 同时落盘本次探测的权益包明细（含到期时间）：这是「7 天内到期积分优先」挑号的数据源。
 * 走到这里即代表额度探测成功，故传 `[]` 也有语义（探测成功但无包）——会清掉旧明细，
 * 避免已消失的包继续把挑号钉在某个账号上。
 */
async function syncPoolCredits(env: Env, provider: Provider, account: OAuthPoolAccount, base: CheckinResult) {
  try {
    if (typeof base.totalRemain === 'number') {
      await reenableOauthIfCredits(env, provider.id, account.uid, base.totalRemain, base.packages ?? [])
    }
  } catch { /* ignore */ }
  // 回写昵称到池账号：池侧 nickname 常为空（登录时未解出 JWT），签到时从
  // token 解出后写回，保证账号池列表与签到结果可用 nickname 对齐
  try {
    if (base.nickname && base.nickname !== account.nickname) {
      await setOauthPoolAccountNickname(env, provider.id, account.uid, base.nickname)
    }
  } catch { /* ignore */ }
}

/**
 * WorkBuddy 池内单账号签到 + 额度刷新 + 解冻。
 * 账号 credentials 来自池（oauth:pool:<id>），token 临近过期先刷新（写回池）。
 *
 * opts.interactive：交互式端点（用户等待）→ 活跃上报不做条间间隔。
 */
async function checkinOauthPoolAccount(
  env: Env,
  provider: Provider,
  account: OAuthPoolAccount,
  opts?: { interactive?: boolean }
): Promise<CheckinResult> {
  const now = Date.now()
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    uid: account.uid || undefined,
    realm: 'unknown',
    success: false,
    reason: 'fail',
    message: '',
    todayCheckedIn: false,
    updatedAt: now,
    nickname: account.nickname || undefined,
  }

  let token = account.token?.access_token || ''
  if (!token) {
    base.reason = 'skipped_no_token'
    base.message = '无 access token'
    return base
  }
  // 临近过期先刷新（写回池）
  if (account.token.refresh_token && account.token.expires_at - Date.now() < OAUTH_TOKEN_REFRESH_MARGIN_MS) {
    try {
      const refreshed = await refreshOauthPoolAccount(env, provider.id, account.uid, provider.oauth!)
      if (refreshed) token = refreshed.token.access_token
    } catch { /* 刷新失败继续用旧 token */ }
  }
  if (!token) {
    base.reason = 'skipped_no_token'
    base.message = 'token 刷新失败，无可用 access token'
    return base
  }

  const claims = decodeWorkbuddyClaims(token)
  const uid = account.uid || claims.uid
  const enterpriseId = claims.enterpriseId
  // JWT 是昵称的**唯一权威来源**，必须无条件覆盖池内存储值：
  // 池里的旧值可能是历史版本按 Latin-1 写坏的乱码（å¦¹ / å¿«å¿«ä¹ä¹）。
  // 若沿用「仅在为空时补」的写法，base.nickname 会一直等于乱码旧值，
  // 下面 syncPoolCredits 的回写判定（base.nickname !== account.nickname）恒为 false，
  // 乱码将永久留在 KV 里——这正是「部署了修复但面板仍乱码」的原因。
  if (claims.nickname) {
    base.nickname = claims.nickname
  }

  const realm = detectTokenRealm(token)
  if (realm === 'global') {
    base.realm = 'global'
    base.reason = 'skipped_global'
    base.message = '国际版账号无签到功能'
    base.success = true
    const devTokenGlobalEarly = account.token?.device_token || provider.oauth?.deviceToken
    await fillCredits(env, base, token, 'global', uid, enterpriseId, devTokenGlobalEarly)

    // 国际版**活跃上报**放开（移植 workbuddy2api a190252 / PR #45 实测）：
    // global 账号无签到/任务中心体系（D4 门控，下面 checkin/travel 仍跳过），
    // 但 `/v2/report` 在 workbuddy.ai 上可用（code=0），**同样点亮连登**。
    // billingCall 已按 realm 切 base（workbuddy.ai/v2/report）与 Origin/UA，无需额外改动。
    // 失败只记入结果，不改变 base.success（签到语义上 global 仍算"跳过"）。
    const devTokenGlobal = account.token?.device_token || provider.oauth?.deviceToken
    try {
      const act = await reportWorkbuddyChatActivity(token, 'global', uid, { enterpriseId, deviceToken: devTokenGlobal, count: 5, gapMs: opts?.interactive ? 0 : undefined })
      base.activityReport = { success: act.success, message: act.message }
    } catch (e) {
      base.activityReport = { success: false, message: (e as Error).message }
    }
    try {
      const streak = await fetchWorkbuddyStreak(token, 'global', { uid, enterpriseId, deviceToken: devTokenGlobal })
      if (typeof streak === 'number') base.streakDays = streak
    } catch { /* ignore */ }

    // 国际版**连登奖励兑换 + 补签 + 抽奖**（2026-10-11 实测解除 global 门控）：
    // 旧实现以"global 新号 streak 返回 500"为由整链跳过，实测推翻——workbuddy.ai 的
    // growth 域与 CN 同构且可用（streak/heatmap/lottery 均 200，redeem 返回 code:0 并
    // 真实入账 energy/cards/chances）。跳过等于每月白丢 7d/14d/28d 三档。
    // 安全性：runWorkbuddyGrowthRewards 每步失败静默，streak 不可用时自行返回 acted:false，
    // 与旧门控净效果一致（见该函数文档）。state 复用上面那次 streak 读取，不打两遍。
    try {
      base.growthReward = await runWorkbuddyGrowthRewards(token, 'global', uid, {
        enterpriseId,
        deviceToken: devTokenGlobal,
        env,
        providerId: provider.id,
      })
    } catch (e) {
      base.growthReward = { acted: false, message: (e as Error).message }
    }

    // 国际版盲盒（同 runWorkbuddyBlindBox，实测 workbuddy.ai 的 buddy/quota 同样 200）：
    // 与 redeem 同序（先领 energy 再花）。失败静默，不改 base.success。
    try {
      base.blindBox = await runWorkbuddyBlindBox(token, 'global', { uid, enterpriseId, deviceToken: devTokenGlobal })
    } catch (e) {
      base.blindBox = { acted: false, opened: 0, items: [], message: (e as Error).message }
    }

    // 国际版注册激活自愈（移植 workbuddy2api activate_region / complete_flow）：
    // 补齐 register + 地区，解决上游 chat 429 code 14017「trial not activated」。
    // 失败只记录，不改 base.success（global 签到语义仍算"跳过"）。uid 缺失则跳过。
    if (uid) {
      try {
        base.globalActivation = await ensureGlobalActivation(token, uid)
      } catch (e) {
        base.globalActivation = { ok: false, message: (e as Error).message }
      }
    }
    // 国际版一次性 trial 加油包（移植 workbuddy2api trial.go）：global 无签到/任务中心，
    // trial 是其唯一天然积分增益动作。幂等（14051 = 已领过，视为正常）。
    // 失败不影响 base.success（签到语义上 global 仍算"跳过"），只记录结果供面板展示。
    try {
      const tr = await claimGlobalTrial(token)
      base.trialClaim = { success: tr.ok, already: tr.already, message: tr.msg }
    } catch (e) {
      base.trialClaim = { success: false, already: false, message: (e as Error).message }
    }

    // 注意：**不**做猫猫旅行（runWorkbuddyCatTravel）——global 无猫猫旅行体系
    //（对齐 workbuddy2api travel.go:56-58 的 D4 门控）。

    await syncPoolCredits(env, provider, account, base)
    return base
  }
  if (realm !== 'cn') {
    base.realm = 'unknown'
    base.reason = 'fail'
    base.message = '无法判断账号领域（非 WorkBuddy token）'
    return base
  }
  base.realm = 'cn'

  // 状态探测
  const status = await fetchCheckinStatus(token, 'cn')
  if (status) {
    base.todayCheckedIn = status.todayCheckedIn
    base.streakDays = status.streakDays
    base.totalCredits = status.totalCredits
    base.dailyCredit = status.dailyCredit
    if (status.todayCheckedIn) {
      base.success = true
      base.reason = 'already'
      base.message = '今日已签到'
      base.lastCheckinAt = now
    }
  }

  // 未签到则执行签到
  if (!base.todayCheckedIn) {
    const res = await performCheckin(token, 'cn', env)
    base.success = res.success
    base.message = res.message
    base.reason = res.success ? (res.already ? 'already' : 'ok') : 'fail'
    base.lastCheckinAt = now
    if (res.success) base.todayCheckedIn = true
  }

  // 生态增值与自动化任务（P2）：活跃上报（点亮连登/领猫门槛） + 回读 streak + 猫猫旅行
  const devToken = account.token?.device_token || provider.oauth?.deviceToken
  let activityReportedOk = false
  try {
    // gapMs：交互式端点跳过条间间隔（5×1.5s 会让手动操作卡 6s+）
    const act = await reportWorkbuddyChatActivity(token, 'cn', uid, { enterpriseId, deviceToken: devToken, count: 5, gapMs: opts?.interactive ? 0 : undefined })
    base.activityReport = { success: act.success, message: act.message }
    activityReportedOk = act.success
  } catch (e) {
    base.activityReport = { success: false, message: (e as Error).message }
  }

  // 连登奖励 + 兑换状态**一次读完**（移植 workbuddy2api 91418c5 GrowthRewardState）：
  // 上游设计该端点为"一次 GET 同时给出 streak.days 与 redemption_status（各档状态），免二次请求"。
  // 故这里读一次，既回填面板展示的连登天数，又供下面的连登奖励兑换复用（避免同端点打两遍）。
  let rewardState: WorkbuddyRewardState | null = null
  try {
    rewardState = await fetchWorkbuddyRewardState(token, 'cn', { uid, enterpriseId, deviceToken: devToken })
    if (rewardState) base.streakDays = rewardState.days
  } catch { /* ignore */ }

  try {
    // 传 env/providerId 启用领养当日防抖（对齐 workbuddy2api adoptTriedToday）：
    // 门槛未达时同日不再重试领养，避免对上游重试轰炸。
    // forceAdopt：本流程刚完成 5 条活跃上报 → 对话量可能刚好补满（"门槛刚达成"的新状态，
    // 不算对上游重试轰炸）→ 豁免当日防抖，就地闭环（对齐源实现 travelAdoptForce）。
    const travel = await runWorkbuddyCatTravel(token, 'cn', uid, {
      enterpriseId,
      deviceToken: devToken,
      env,
      providerId: provider.id,
      forceAdopt: activityReportedOk,
    })
    base.catTravel = travel
  } catch (e) {
    base.catTravel = { state: 'error', message: (e as Error).message }
  }

  // 夜猫子 black_cat（2026-10-11 接线）：官方规则「每天 1 次 × 累计 3 天」，
  // 且**只在 CST 23:00–08:00 窗口内计数**。函数内部自行判窗口，非窗口期直接返回
  // skipped 且**不发任何上游请求**，故这里无条件调用是安全的。
  // 为什么之前一直没生效：runWorkbuddyNightCat 早已实现并有测试，但**零调用方**，
  // 且 cron 的 10:05/22:05 都不在窗口内——接线后仍需一个窗口内的 cron（见 wrangler.toml）。
  try {
    base.nightCat = await runWorkbuddyNightCat(token, 'cn', uid, { enterpriseId, deviceToken: devToken })
  } catch (e) {
    base.nightCat = { state: 'error', message: (e as Error).message }
  }

  // 连登奖励兑换 + 连登抽奖（移植 workbuddy2api 91418c5）：在活跃上报 + streak 自检之后执行，
  // 与源实现 scheduler.runActivity 的末段同序（活跃上报点亮连登 → 才有可领档位）。
  // 幂等闸用 KV 日键（`redeemTriedToday`），多 isolate 一致；正常态（已领/未达标/无次数）静默，
  // 失败只记录不改 base.success（与 catTravel 的失败口径一致）。
  // state=rewardState：复用上面那次读取，不再打一遍 /activity/growth/streak。
  try {
    base.growthReward = await runWorkbuddyGrowthRewards(token, 'cn', uid, {
      enterpriseId,
      deviceToken: devToken,
      env,
      providerId: provider.id,
      state: rewardState,
    })
  } catch (e) {
    base.growthReward = { acted: false, message: (e as Error).message }
  }

  // 盲盒（移植 WorkBuddy-Daily t_blindbox）：能量（energy）的**唯一消耗出口**，
  // 攒着不用就是沉没成本。放在连登兑换之后——redeem 会发 energy，先领再花。
  // 正常态静默：能量不足时 runWorkbuddyBlindBox 直接返回 acted:false 且不发写请求。
  try {
    base.blindBox = await runWorkbuddyBlindBox(token, 'cn', { uid, enterpriseId, deviceToken: devToken })
  } catch (e) {
    base.blindBox = { acted: false, opened: 0, items: [], message: (e as Error).message }
  }

  // 额度信息 + 解冻（签到就是为了解冻冷却账号，对齐 workbuddy-wild ReenableIfCredits）
  await fillCredits(env, base, token, 'cn', uid, enterpriseId, devToken)
  await syncPoolCredits(env, provider, account, base)
  return base
}

/** WorkBuddy 池全账号签到，返回带 accounts 的汇总 CheckinResult（存 KV 供面板展示）。 */
/**
 * WorkBuddy 池全账号签到。
 *
 * opts.interactive：调用方是否为**用户等待的交互式端点**（管理后台手动触发）。
 * true 时跳过账号间限速与条间间隔——否则一次手动操作会因
 * "N 账号 × (5 条 × 1.5s + 0.8s)" 而卡住数十秒（且接近 Workers 请求时限）。
 * cron 后台路径保持 false（无客户端等待，防风控优先，对齐源实现后台调度语义）。
 */
async function checkinOauthPoolAccounts(
  env: Env,
  provider: Provider,
  opts?: { interactive?: boolean }
): Promise<CheckinResult> {
  const now = Date.now()
  const interactive = opts?.interactive === true
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    realm: 'unknown',
    success: false,
    reason: 'fail',
    message: '',
    todayCheckedIn: false,
    updatedAt: now,
  }
  // 兼容迁移：池空时把既有单 token 种子进池
  try { await seedOauthPoolFromSingle(env, provider.id) } catch { /* ignore */ }
  const pool = await readOauthPool(env, provider.id)
  if (pool.length === 0) {
    base.reason = 'skipped_no_token'
    base.message = '账号池为空（未登录任何账号）'
    return base
  }

  const accounts: CheckinResult[] = []
  let success = 0, already = 0, fail = 0, skipped = 0
  let firstAccount = true
  for (const acc of pool) {
    // 账号间限速（对齐 workbuddy2api activityAccountDelay/travelAccountDelay = 800ms）：
    // 每账号签到内含 5 条活跃上报 + 旅行巡检（多个上游请求），
    // 池内账号连续无间隔处理会对上游形成突发压力。交互式端点跳过（用户等待）。
    if (!firstAccount && !interactive) await delayMs(ACTIVITY_ACCOUNT_DELAY_MS)
    firstAccount = false
    try {
      const r = await checkinOauthPoolAccount(env, provider, acc, { interactive })
      accounts.push(r)
      if (r.success) {
        if (r.reason === 'already') already++
        else if (r.reason === 'ok') success++
        else skipped++
      } else {
        fail++
      }
    } catch (e) {
      accounts.push({
        providerId: provider.id, name: provider.name, uid: acc.uid || undefined, realm: 'unknown',
        success: false, reason: 'fail', message: (e as Error).message || String(e),
        todayCheckedIn: false, updatedAt: Date.now(), nickname: acc.nickname || acc.uid,
      })
      fail++
    }
  }

  base.accounts = accounts
  base.todayCheckedIn = accounts.some((a) => a.todayCheckedIn)
  base.success = success > 0 || already > 0
  base.reason = success > 0 ? 'ok' : (already > 0 ? 'already' : (fail > 0 ? 'fail' : 'skipped_no_token'))
  base.message = `共 ${accounts.length} 个账号：成功 ${success} / 已签 ${already} / 失败 ${fail} / 跳过 ${skipped}`
  // 汇总额度：取任一成功账号
  const okOne = accounts.find((a) => a.reason === 'ok' || a.reason === 'already')
  if (okOne) {
    base.totalRemain = okOne.totalRemain
    base.totalUsed = okOne.totalUsed
    base.totalSize = okOne.totalSize
    base.packCount = okOne.packCount
    base.paymentType = okOne.paymentType
    base.nickname = okOne.nickname
    base.streakDays = okOne.streakDays
    base.totalCredits = okOne.totalCredits
  }
  await writeCheckinResult(env, provider.id, base)
  return base
}

/**
 * 单 provider 签到。
 * opts.interactive：交互式端点（管理后台手动触发，用户等待 HTTP 响应）→ 跳过防风控延时；
 * cron 后台路径保持缺省（false）。
 */
export async function checkinOneAccount(
  env: Env,
  provider: Provider,
  opts?: { interactive?: boolean }
): Promise<CheckinResult> {
  // WorkBuddy 多账号池：browser 登录流提供商遍历池内所有账号各自签到，返回带 accounts 的汇总结果
  if (isOAuthPoolProvider(provider)) {
    return checkinOauthPoolAccounts(env, provider, opts)
  }

  const now = Date.now()
  const base: CheckinResult = {
    providerId: provider.id,
    name: provider.name,
    realm: 'unknown',
    success: false,
    reason: 'fail',
    message: '',
    todayCheckedIn: false,
    updatedAt: now,
  }

  // 取 access token（自动刷新）
  const token = provider.oauth
    ? await getOauthAccessToken(env, provider.id, provider.oauth)
    : null
  if (!token) {
    base.reason = 'skipped_no_token'
    base.message = '无可用 token（未登录或刷新失败）'
    return base
  }

  // 从 JWT 解出 uid / enterpriseId / nickname（额度接口与面板展示用）
  const claims = decodeWorkbuddyClaims(token)
  const uid = claims.uid
  const enterpriseId = claims.enterpriseId
  if (claims.nickname) base.nickname = claims.nickname

  const realm = detectTokenRealm(token)
  if (realm === 'global') {
    base.realm = 'global'
    base.reason = 'skipped_global'
    base.message = '国际版账号无签到功能'
    base.success = true
    // 国际版也拉额度信息（对齐 CPA 面板展示）
    const devTokenGlobal = provider.oauth?.deviceToken
    await fillCredits(env, base, token, 'global', uid, enterpriseId, devTokenGlobal)
    // 国际版活跃上报放开（同池化路径，移植 workbuddy2api a190252 / PR #45）
    try {
      const act = await reportWorkbuddyChatActivity(token, 'global', uid, { enterpriseId, deviceToken: devTokenGlobal, count: 5, gapMs: opts?.interactive ? 0 : undefined })
      base.activityReport = { success: act.success, message: act.message }
    } catch (e) {
      base.activityReport = { success: false, message: (e as Error).message }
    }
    try {
      const streak = await fetchWorkbuddyStreak(token, 'global', { uid, enterpriseId, deviceToken: devTokenGlobal })
      if (typeof streak === 'number') base.streakDays = streak
    } catch { /* ignore */ }
    // 国际版连登奖励兑换 + 补签 + 抽奖（2026-10-11 实测解除 global 门控，理由见池化路径）
    try {
      base.growthReward = await runWorkbuddyGrowthRewards(token, 'global', uid, {
        enterpriseId,
        deviceToken: devTokenGlobal,
        env,
        providerId: provider.id,
      })
    } catch (e) {
      base.growthReward = { acted: false, message: (e as Error).message }
    }
    // 国际版盲盒（同上）
    try {
      base.blindBox = await runWorkbuddyBlindBox(token, 'global', { uid, enterpriseId, deviceToken: devTokenGlobal })
    } catch (e) {
      base.blindBox = { acted: false, opened: 0, items: [], message: (e as Error).message }
    }
    // 国际版注册激活自愈（同池化路径，移植 workbuddy2api activate_region / complete_flow）：
    // 补齐 register + 地区，解决上游 chat 429 code 14017「trial not activated」。
    if (uid) {
      try {
        base.globalActivation = await ensureGlobalActivation(token, uid)
      } catch (e) {
        base.globalActivation = { ok: false, message: (e as Error).message }
      }
    }
    // 国际版一次性 trial 加油包（同池化路径，移植 workbuddy2api trial.go）
    try {
      const tr = await claimGlobalTrial(token)
      base.trialClaim = { success: tr.ok, already: tr.already, message: tr.msg }
    } catch (e) {
      base.trialClaim = { success: false, already: false, message: (e as Error).message }
    }
    // 不做猫猫旅行：global 无该体系（对齐 workbuddy2api travel.go:56-58 D4 门控）
    await writeCheckinResult(env, provider.id, base)
    return base
  }
  if (realm !== 'cn') {
    base.realm = 'unknown'
    base.reason = 'fail'
    base.message = '无法判断账号领域（非 WorkBuddy token）'
    return base
  }
  base.realm = 'cn'

  // 状态探测
  const status = await fetchCheckinStatus(token, 'cn')
  if (status) {
    base.todayCheckedIn = status.todayCheckedIn
    base.streakDays = status.streakDays
    base.totalCredits = status.totalCredits
    base.dailyCredit = status.dailyCredit
    if (status.todayCheckedIn) {
      base.success = true
      base.reason = 'already'
      base.message = '今日已签到'
      base.lastCheckinAt = now
    }
  }

  // 执行签到
  if (!base.todayCheckedIn) {
    const res = await performCheckin(token, 'cn', env)
    base.success = res.success
    base.message = res.message
    base.reason = res.success ? (res.already ? 'already' : 'ok') : 'fail'
    base.lastCheckinAt = now
    if (res.success) base.todayCheckedIn = true
    if (res.success && !res.already && res.reward && typeof (res.reward as any).credit === 'number') {
      base.checkinCredit = (res.reward as any).credit
    }
  }

  // 生态增值与自动化任务（P2）：活跃上报 + streak 回读 + 猫猫旅行
  const devToken = provider.oauth?.deviceToken
  let activityReportedOk = false
  try {
    const act = await reportWorkbuddyChatActivity(token, 'cn', uid, { enterpriseId, deviceToken: devToken, count: 5, gapMs: opts?.interactive ? 0 : undefined })
    base.activityReport = { success: act.success, message: act.message }
    activityReportedOk = act.success
  } catch (e) {
    base.activityReport = { success: false, message: (e as Error).message }
  }

  // 连登奖励 + 兑换状态**一次读完**（移植 workbuddy2api 91418c5 GrowthRewardState）：
  // 上游设计该端点为"一次 GET 同时给出 streak.days 与 redemption_status（各档状态），免二次请求"。
  // 故这里读一次，既回填面板展示的连登天数，又供下面的连登奖励兑换复用（避免同端点打两遍）。
  let rewardState: WorkbuddyRewardState | null = null
  try {
    rewardState = await fetchWorkbuddyRewardState(token, 'cn', { uid, enterpriseId, deviceToken: devToken })
    if (rewardState) base.streakDays = rewardState.days
  } catch { /* ignore */ }

  try {
    // 同池化路径：启用领养当日防抖 + 上报成功后豁免（对话量刚补满，就地闭环）
    const travel = await runWorkbuddyCatTravel(token, 'cn', uid, {
      enterpriseId,
      deviceToken: devToken,
      env,
      providerId: provider.id,
      forceAdopt: activityReportedOk,
    })
    base.catTravel = travel
  } catch (e) {
    base.catTravel = { state: 'error', message: (e as Error).message }
  }

  // 连登奖励兑换 + 连登抽奖（移植 workbuddy2api 91418c5，同池化路径）
  // state=rewardState：复用上面那次读取，不再打一遍 /activity/growth/streak。
  try {
    base.growthReward = await runWorkbuddyGrowthRewards(token, 'cn', uid, {
      enterpriseId,
      deviceToken: devToken,
      env,
      providerId: provider.id,
      state: rewardState,
    })
  } catch (e) {
    base.growthReward = { acted: false, message: (e as Error).message }
  }

  // 额度信息（可用/已用/额度池/包数 + 套餐类型）
  await fillCredits(env, base, token, 'cn', uid, enterpriseId, provider.oauth?.deviceToken)

  await writeCheckinResult(env, provider.id, base)
  return base
}

// ===== 全量签到 =====

/** 是否参与签到扫全量（WorkBuddy 的 oauth-device 账号；api-key 提供商无签到）。 */
function participatesInCheckin(p: Provider): boolean {
  return p.authType === 'oauth-device' && !!p.oauth
}

/**
 * 结构上不参与签到的账号（skip 语义，**不是**「待签」）：
 * - skipped_global：国际版 WorkBuddy 无签到体系（`checkin.ts` realm==='global' 分支只做活跃上报）
 * - skipped_no_token：账号没有可用 access token，本轮不可能签成
 * 面板 KPI 若把它们计入分母，会长期显示「N 个待签」——用户已全部签到也无法清零。
 */
const CHECKIN_SKIPPED_REASONS = ['skipped_global', 'skipped_no_token'] as const

/** 是否为 skip（非「待签」）账号。KPI 分母与 runAllCheckins 的 skipped 口径共用此判定。 */
function isCheckinSkipped(r: Pick<CheckinResult, 'reason'>): boolean {
  return (CHECKIN_SKIPPED_REASONS as readonly string[]).includes(r.reason)
}

/**
 * 全量签到（遍历所有参与签到的 provider）。
 *
 * opts.interactive：交互式端点（用户等待）→ 跳过防风控延时。
 * 缺省 false（cron 后台路径，防风控优先）。
 */
export async function runAllCheckins(env: Env, silent = false, opts?: { interactive?: boolean }): Promise<{
  total: number
  success: number
  already: number
  fail: number
  skipped: number
  results: CheckinResult[]
}> {
  const providers = (await getProviders(env)) as Provider[]
  const oauthProviders = providers.filter(participatesInCheckin)

  const results: CheckinResult[] = []
  // 简单串行（账号数量通常很少，且避免并发刷新 token 冲突）
  for (const p of oauthProviders) {
    try {
      const r = await checkinOneAccount(env, p, { interactive: opts?.interactive })
      results.push(r)
      // 写日志（silent 模式跳过，用于面板后台静默刷新，避免日志噪音）
      if (!silent) {
        try {
          await writeLog(env, 'info', `[checkin] ${p.name} → ${r.reason}`, JSON.stringify(r))
        } catch { /* ignore */ }
      }
    } catch (e) {
      const r: CheckinResult = {
        providerId: p.id, name: p.name, realm: 'unknown',
        success: false, reason: 'fail', message: (e as Error).message,
        todayCheckedIn: false, updatedAt: Date.now(),
      }
      results.push(r)
    }
  }

  const success = results.filter((r) => r.reason === 'ok').length
  const already = results.filter((r) => r.reason === 'already').length
  const fail = results.filter((r) => r.reason === 'fail').length
  const skipped = results.filter((r) => isCheckinSkipped(r)).length

  return { total: results.length, success, already, fail, skipped, results }
}

// ===== Hono handlers（放此处避免与 admin.ts 循环依赖） =====

/** POST /admin/api/checkin 或 /api/manage/checkin：手动触发签到。body 可选 {id} 单个。 */
export async function handleCheckinTrigger(c: Context<{ Bindings: Env }>) {
  // 有界读取：body 可选（空 → 全量签到），容错语义与原 try/catch 一致；超限仍 413。
  const body = await readOptionalJSONLimited<{ id?: string; silent?: boolean }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const id = body.id?.trim()

  if (id) {
    const providers = (await getProviders(c.env)) as Provider[]
    const p = providers.find((x) => x.id === id)
    if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
    // interactive: true —— 管理后台手动触发，用户等待 HTTP 响应，
    // 跳过防风控延时（否则多账号 × 6s+ 会让操作明显卡顿）
    const result = await checkinOneAccount(c.env, p, { interactive: true })
    if (!body.silent) {
      try { await writeLog(c.env, 'info', `[checkin] ${p.name} → ${result.reason}（手动）`, JSON.stringify(result)) } catch { /* ignore */ }
    }
    return c.json<ApiResponse<CheckinResult>>({ success: true, data: result })
  }

  // interactive: true —— 手动全量签到（用户等待）
  const summary = await runAllCheckins(c.env, !!body.silent, { interactive: true })
  return c.json<ApiResponse>({ success: true, data: { summary } })
}

/** GET /admin/api/checkin/status：返回所有 provider 的签到结果（面板展示）。 */
export async function handleCheckinStatus(c: Context<{ Bindings: Env }>) {
  const providers = (await getProviders(c.env)) as Provider[]

  // WorkBuddy：oauth-device 家族
  const oauthProviders = providers.filter(participatesInCheckin)

  const workbuddy: CheckinResult[] = []
  for (const p of oauthProviders) {
    const r = await readCheckinResult(c.env, p.id)
    if (r) {
      workbuddy.push(r)
    } else {
      // 无结果占位，让面板知道有此 WorkBuddy 账号但未签到
      workbuddy.push({
        providerId: p.id, name: p.name, realm: 'unknown',
        success: false, reason: 'skipped_no_token', message: '尚未签到',
        todayCheckedIn: false, updatedAt: 0,
      })
    }
  }

  return c.json<ApiResponse>({ success: true, data: { workbuddy } })
}

/**
 * 一个待汇总的积分池：窗口内到期的条目 + 这些条目的**数据时点**。
 *
 * 时点只记「真正计入的条目」所属账号的探测时刻，并取其中**最早**的一个：
 * 面板要说的是「这个数字有多旧」，用最新的一次会掩盖陈旧账号（一个 3 小时前探过、
 * 一个有 2 天前的待救包 → 标「3 小时前」等于骗人）。
 */
interface ExpiringBucket {
  entries: CreditExpiryEntry[]
  /** 计入条目里最旧的探测时刻 epoch ms；无 → null */
  at: number | null
}

/** 往桶里放一条：只有真正计入窗口的条目才参与「数据时点」（否则陈旧账号会污染标注）。 */
function pushExpiring(bucket: ExpiringBucket, entry: CreditExpiryEntry, probedAt: number | undefined, now: number) {
  if (!isExpiringCredit(entry, now)) return
  bucket.entries.push(entry)
  if (typeof probedAt !== 'number' || !Number.isFinite(probedAt) || probedAt <= 0) return
  if (bucket.at === null || probedAt < bucket.at) bucket.at = probedAt
}

/** 汇总一个桶：额度合计 + 最早到期 + 数据时点（没有计入条目时时点归 null）。 */
function summarizeBucket(bucket: ExpiringBucket, now: number): { summary: ExpiringCreditSummary; at: number | null } {
  const summary = summarizeExpiringAt(bucket.entries, now)
  return { summary, at: summary.amount > 0 ? bucket.at : null }
}

/** WorkBuddy 的额度与签到进度快照。 */
interface CheckinFamilyQuota {
  /** 账号总数（含国际版 / 无 token 等 skip 账号）：额度卡据此判断有没有数据 */
  accounts: number
  /** 计入签到分母的账号数（skip 账号不计） */
  checkinAccounts: number
  /** 其中今日已签到数 */
  checkedIn: number
  /** 可用额度合计（逐账号 totalRemain 累加，含国际版账号） */
  remain: number
  /** 额度池合计（逐账号 totalSize 累加） */
  size: number
  /**
   * 7 天窗口内到期且仍有剩余的积分，**按域拆开**：国内版与国际版是两套账号、
   * 两个独立积分池，合并成一个数看不出该去哪个账号救火。
   */
  expiringCn: ExpiringBucket
  /** 国际版（realm=global）账号窗口内到期的积分 */
  expiringGlobal: ExpiringBucket
}

/**
 * 聚合 WorkBuddy 签到 KV。
 *
 * 逐 provider 读 `checkin:result:<id>`（TTL 2 天）：池提供商逐账号累加，单账号直接取。
 * skip 账号（国际版 / 无 token）不计入签到分子分母——它们结构上签不成，计入会让
 * 「今日签到」永不达标；但额度仍要累加（国际版账号照样消耗额度池），账号数也照算
 * （否则只有国际版账号的提供商会被额度卡误判成「无账号」）。
 *
 * 顺带把各账号 `packages`（上次签到/额度探测落盘的权益包明细）汇成「7 天内到期」汇总，
 * 供概览明细卡按渠道列出待作废积分——挑号用的是同一份 `isExpiringCredit` 口径。
 * 到期条目按账号 `realm` 分桶（国内 / 国际版），因为那是两个互不相干的积分池；
 * 数据时点取账号级 `updatedAt`（签到结果落盘时刻 = 额度明细的探测时刻）。
 */
async function aggregateCheckinFamily(env: Env, familyProviders: readonly Provider[], now: number): Promise<CheckinFamilyQuota> {
  const out: CheckinFamilyQuota = {
    accounts: 0, checkinAccounts: 0, checkedIn: 0, remain: 0, size: 0,
    expiringCn: { entries: [], at: null },
    expiringGlobal: { entries: [], at: null },
  }
  for (const p of familyProviders) {
    const r = await readCheckinResult(env, p.id)
    if (!r) continue
    const accounts = r.accounts && r.accounts.length > 0 ? r.accounts : [r]
    for (const a of accounts) {
      out.accounts++
      if (!isCheckinSkipped(a)) {
        out.checkinAccounts++
        if (a.todayCheckedIn) out.checkedIn++
      }
      if (typeof a.totalRemain === 'number') out.remain += a.totalRemain
      if (typeof a.totalSize === 'number') out.size += a.totalSize
      // realm 为 unknown 的一律并入国内桶：只有显式 global 才说明是海外域账号
      const bucket = a.realm === 'global' ? out.expiringGlobal : out.expiringCn
      for (const pkg of a.packages || []) pushExpiring(bucket, packageExpiryEntry(pkg), a.updatedAt, now)
    }
  }
  return out
}

/** 概览「7 天内到期积分」明细的一行（一个独立的积分池）。 */
export interface ExpiringChannel {
  /** 稳定标识：workbuddy / workbuddy-global */
  key: string
  /** 展示名：WorkBuddy / WorkBuddy 国际版 */
  label: string
  /** 该渠道窗口内到期且仍有剩余的积分合计 */
  amount: number
  /** 该渠道最早到期时刻 epoch ms */
  soonestAt: number
  /** 计入的权益包条数 */
  packs: number
  /**
   * 该渠道额度明细的**数据时点**（epoch ms，取计入条目里最旧的一次探测）；未知 → null。
   * 面板据此标出「数据 N 小时前」——这个数字是快照值，不标就会被当成实时。
   */
  dataAt: number | null
}


/**
 * GET /admin/api/overview：概览驾驶舱聚合数据（P2）。
 * 聚合来源：WorkBuddy 签到 KV（额度与签到进度）。来源失败不阻塞其它来源。
 *
 * `expiring` 是「7 天内到期积分」明细（每个独立积分池一行：产品族 × 域），
 * 数据源与挑号优先级判定同源：取签到快照的 `packages`（CST 墙钟到期）。
 * 它由「上次签到/积分探测」写入，因此是**快照时点**的值而不是此刻实时值——
 * 每行附 `dataAt`（最旧一次探测的时刻），面板据此标出「数据 N 小时前」，
 * 否则快照值会被当成实时值读。
 */
export async function handleAdminOverview(c: Context<{ Bindings: Env }>) {
  const now = Date.now()
  const providers = (await getProviders(c.env)) as Provider[]

  const checkinProviders = providers.filter(participatesInCheckin)
  const workbuddy = await aggregateCheckinFamily(c.env, checkinProviders, now)

  // 明细只列「确实有积分快作废」的池；空的池不占行（面板另有整体空态文案兜底）。
  const expiringChannels: ExpiringChannel[] = []
  const pushChannel = (key: string, label: string, b: ExpiringBucket) => {
    const { summary, at } = summarizeBucket(b, now)
    if (summary.amount > 0 && summary.soonestAt !== null) {
      expiringChannels.push({
        key, label,
        amount: summary.amount, soonestAt: summary.soonestAt, packs: summary.packs,
        dataAt: at,
      })
    }
  }
  pushChannel('workbuddy', 'WorkBuddy', workbuddy.expiringCn)
  pushChannel('workbuddy-global', 'WorkBuddy 国际版', workbuddy.expiringGlobal)
  // 到期越早越优先处理
  expiringChannels.sort((a, b) => a.soonestAt - b.soonestAt)

  return c.json<ApiResponse>({
    success: true,
    data: {
      // 今日签到进度与额度（仅 WorkBuddy）
      checkin: {
        checkedIn: workbuddy.checkedIn,
        totalAccounts: workbuddy.checkinAccounts,
      },
      workbuddy: { remain: workbuddy.remain, size: workbuddy.size, accounts: workbuddy.accounts },
      // 7 天内到期积分明细：total/soonestAt 为跨渠道合计，channels 为逐渠道行
      expiring: {
        windowDays: CREDIT_EXPIRY_WINDOW_MS / 86400000,
        total: expiringChannels.reduce((sum, ch) => sum + ch.amount, 0),
        soonestAt: expiringChannels.length > 0 ? expiringChannels[0].soonestAt : null,
        channels: expiringChannels,
      },
    },
  })
}

/** POST /admin/api/oauth/:id/activity：手动触发活跃上报。 */
export async function handleOAuthActivity(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')?.trim()
  const providers = (await getProviders(c.env)) as Provider[]
  const p = providers.find((x) => x.id === id)
  if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  const pool = await readOauthPool(c.env, p.id)
  if (pool.length === 0) return c.json<ApiResponse>({ success: false, message: '账号池为空' }, 400)

  const results: any[] = []
  let ok = 0
  for (const acc of pool) {
    if (acc.state?.disabled) continue
    const token = acc.token?.access_token || ''
    if (!token) continue
    const claims = decodeWorkbuddyClaims(token)
    const uid = acc.uid || claims.uid
    const enterpriseId = acc.token?.enterprise_id || claims.enterpriseId
    const devToken = acc.token?.device_token || p.oauth?.deviceToken
    // 按 token realm 决定上报域（global → workbuddy.ai/v2/report）：
    // 国际版 /v2/report 可用并点亮连登（移植 workbuddy2api a190252 / PR #45）。
    const accRealm = detectTokenRealm(token) === 'global' ? 'global' : 'cn'
    // gapMs=0：这是**管理后台手动端点**，用户会等待 HTTP 响应；5 条 × 1.5s = 6s 会让
    // 操作明显卡顿（且接近 Workers 请求时限）。防风控间隔仅在 cron 后台路径保留
    //（那里没有客户端等待，且源实现本身就是后台调度）。
    const res = await reportWorkbuddyChatActivity(token, accRealm, uid, { enterpriseId, deviceToken: devToken, count: 5, gapMs: 0 })
    if (res.success) ok++
    results.push({ uid, nickname: acc.nickname, realm: accRealm, ...res })
  }
  return c.json<ApiResponse>({ success: true, message: `已完成活跃上报（成功 ${ok}/${pool.length}）`, data: results })
}

/** POST /admin/api/oauth/:id/travel：手动触发猫猫旅行巡检。 */
export async function handleOAuthTravel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')?.trim()
  const providers = (await getProviders(c.env)) as Provider[]
  const p = providers.find((x) => x.id === id)
  if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  const pool = await readOauthPool(c.env, p.id)
  if (pool.length === 0) return c.json<ApiResponse>({ success: false, message: '账号池为空' }, 400)

  const results: any[] = []
  for (const acc of pool) {
    if (acc.state?.disabled) continue
    const token = acc.token?.access_token || ''
    if (!token) continue
    // global 账号无猫猫旅行体系（对齐 workbuddy2api travel.go:56-58 D4 门控），跳过不发请求
    if (detectTokenRealm(token) === 'global') continue
    const claims = decodeWorkbuddyClaims(token)
    const uid = acc.uid || claims.uid
    const enterpriseId = acc.token?.enterprise_id || claims.enterpriseId
    const devToken = acc.token?.device_token || p.oauth?.deviceToken
    // 传 env/providerId 启用领养当日防抖
    const res = await runWorkbuddyCatTravel(token, 'cn', uid, { enterpriseId, deviceToken: devToken, env: c.env, providerId: p.id })
    results.push({ uid, nickname: acc.nickname, ...res })
  }
  return c.json<ApiResponse>({ success: true, message: `已完成猫猫旅行巡检（共 ${results.length} 个账号）`, data: results })
}

/** POST /admin/api/oauth/:id/daily：一键日常任务（签到 + 活跃上报 + 猫猫旅行）。 */
export async function handleOAuthDaily(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')?.trim()
  const providers = (await getProviders(c.env)) as Provider[]
  const p = providers.find((x) => x.id === id)
  if (!p) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  // interactive: true —— 一键日常是用户等待的交互式操作
  const result = await checkinOneAccount(c.env, p, { interactive: true })
  return c.json<ApiResponse<CheckinResult>>({ success: true, message: '已完成一键日常任务', data: result })
}
