/**
 * pages.ts — 管理后台页面（WorkBuddy 专用，服务端只出壳，数据由前端拉 /admin/api/*）。
 *
 * 为什么做成「壳 + 前端拉数据」：账号池是随时变化的热数据（冷却、积分、在途），
 * 服务端渲染会把面板钉在一次快照上；前端按需刷新才能反映真实挑号状态。
 * 因此本文件不 import 任何 KV 读写，唯一的服务端依赖是 SITE_CONFIG。
 */
import type { Context } from 'hono'
import type { AppEnv } from './types'
import { SITE_CONFIG } from './config'

/** HTML 转义：所有拼进模板的动态值都必须过一遍（昵称/uid/错误信息都可能带上游内容） */
const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const HEAD = (title: string) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#f7f8fa">
<title>${esc(title)} · ${esc(SITE_CONFIG.title)}</title>
<link rel="icon" href="${esc(SITE_CONFIG.favicon)}">
<style>
:root{
  --bg:#f7f8fa; --panel:#fff; --line:#e7e9ee; --line-strong:#d7dae2;
  --text:#141821; --muted:#6a7280; --faint:#98a1b0;
  --brand:#3559e0; --brand-soft:#eef1fe;
  --ok:#0f7b45; --ok-soft:#e8f6ee;
  --warn:#a85b00; --warn-soft:#fdf1e0;
  --bad:#c22a2a; --bad-soft:#fdecec;
  --r:12px; --r-sm:8px;
  --shadow:0 1px 2px rgba(20,24,33,.04),0 8px 24px rgba(20,24,33,.05);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--text);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
code,kbd,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
button{font:inherit;cursor:pointer}
input,select,textarea{font:inherit;color:inherit}

/* ===== 顶栏 ===== */
.top{
  position:sticky;top:0;z-index:30;background:rgba(255,255,255,.86);
  backdrop-filter:saturate(1.6) blur(10px);border-bottom:1px solid var(--line);
}
.top-in{max-width:1180px;margin:0 auto;padding:0 20px;height:58px;display:flex;align-items:center;gap:14px}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;letter-spacing:.2px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--brand);box-shadow:0 0 0 4px var(--brand-soft)}
.brand small{font-weight:500;color:var(--muted);font-size:12px}
.spacer{flex:1}
.btn{
  display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-strong);
  background:var(--panel);color:var(--text);padding:7px 12px;border-radius:var(--r-sm);
  font-size:13px;transition:.15s;white-space:nowrap;
}
.btn:hover{border-color:#c3c8d2;background:#fcfcfd}
.btn:active{transform:translateY(1px)}
.btn[disabled]{opacity:.5;cursor:not-allowed;transform:none}
.btn-primary{background:var(--brand);border-color:var(--brand);color:#fff}
.btn-primary:hover{background:#2b4bcb;border-color:#2b4bcb}
.btn-ghost{border-color:transparent;background:transparent;color:var(--muted)}
.btn-ghost:hover{background:#f0f1f4;color:var(--text)}
.btn-sm{padding:4px 9px;font-size:12px;border-radius:7px}
.btn-danger{color:var(--bad);border-color:#f0c8c8}
.btn-danger:hover{background:var(--bad-soft);border-color:#e3a5a5}

/* ===== 布局 ===== */
.wrap{max-width:1180px;margin:0 auto;padding:20px}
.tabs{display:flex;gap:4px;overflow-x:auto;padding:4px;background:#eef0f4;border-radius:10px;margin-bottom:18px}
.tab{
  border:0;background:transparent;color:var(--muted);padding:8px 14px;border-radius:8px;
  font-size:13px;font-weight:550;white-space:nowrap;transition:.15s;
}
.tab:hover{color:var(--text)}
.tab.on{background:var(--panel);color:var(--text);box-shadow:0 1px 2px rgba(20,24,33,.08)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);margin-bottom:16px;overflow:hidden}
.panel-h{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
.panel-h h2{margin:0;font-size:14px;font-weight:650;letter-spacing:.1px}
.panel-h .sub{color:var(--muted);font-size:12px;font-weight:400}
.panel-b{padding:16px}
.panel-b.flush{padding:0}
.grid{display:grid;gap:12px}
.g4{grid-template-columns:repeat(4,1fr)}
.g3{grid-template-columns:repeat(3,1fr)}
.g2{grid-template-columns:repeat(2,1fr)}
@media(max-width:860px){.g4{grid-template-columns:repeat(2,1fr)}.g3,.g2{grid-template-columns:1fr}}

/* ===== 指标卡 ===== */
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;box-shadow:var(--shadow)}
.stat .k{color:var(--muted);font-size:12px;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.stat .v{font-size:24px;font-weight:680;letter-spacing:-.4px;line-height:1.2}
.stat .v small{font-size:13px;font-weight:500;color:var(--muted);margin-left:4px}
.stat .f{margin-top:6px;font-size:12px;color:var(--faint)}

/* ===== 表格 ===== */
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:12px;font-weight:600;color:var(--muted);background:#fbfcfd;white-space:nowrap}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:#fcfcfd}
td.num{font-variant-numeric:tabular-nums}

/* ===== 徽章 ===== */
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;line-height:1.7;white-space:nowrap}
.b-ok{background:var(--ok-soft);color:var(--ok)}
.b-warn{background:var(--warn-soft);color:var(--warn)}
.b-bad{background:var(--bad-soft);color:var(--bad)}
.b-mute{background:#f0f1f4;color:var(--muted)}
.b-brand{background:var(--brand-soft);color:var(--brand)}

/* ===== 表单 ===== */
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.field label{font-size:12.5px;font-weight:600;color:var(--muted)}
.input,select.input,textarea.input{
  width:100%;padding:8px 11px;border:1px solid var(--line-strong);border-radius:var(--r-sm);
  background:#fff;outline:none;transition:.15s;font-size:13px;
}
.input:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
textarea.input{min-height:92px;resize:vertical;line-height:1.6}
.hint{font-size:12px;color:var(--faint);line-height:1.6}

/* ===== 开关 ===== */
.sw{position:relative;display:inline-block;width:36px;height:20px;flex:none}
.sw input{opacity:0;width:0;height:0}
.sw i{position:absolute;inset:0;background:#d6dae2;border-radius:999px;transition:.18s}
.sw i:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.18s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.sw input:checked + i{background:var(--brand)}
.sw input:checked + i:before{transform:translateX(16px)}

/* ===== 弹层 ===== */
.mask{position:fixed;inset:0;background:rgba(16,20,28,.42);display:none;align-items:center;justify-content:center;z-index:60;padding:20px}
.mask.on{display:flex}
.modal{background:var(--panel);border-radius:14px;box-shadow:0 24px 64px rgba(16,20,28,.24);width:100%;max-width:520px;max-height:86vh;overflow:auto}
.modal-h{display:flex;align-items:center;padding:16px 18px;border-bottom:1px solid var(--line)}
.modal-h h3{margin:0;font-size:14.5px;font-weight:650;flex:1}
.modal-b{padding:18px}
.modal-f{padding:14px 18px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end}

/* 一次性展示完整转发 Key：必须可选中、可整段复制，不能靠 toast 承载 */
.notice{padding:10px 12px;border-radius:var(--r-sm);font-size:12.5px;line-height:1.65;margin-bottom:14px;border:1px solid}
.notice.bad{background:#fff5f5;border-color:#f0c2c8;color:#b42333}
.keybox{
  display:block;background:var(--bg);border:1px solid var(--line-strong);border-radius:var(--r-sm);
  padding:11px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:13px;line-height:1.55;word-break:break-all;user-select:all;cursor:text;color:var(--text);
}
.hint-inline{color:var(--muted);font-size:12px;margin:8px 0 0}

/* ===== 登录页 ===== */
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.login-card{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 60px rgba(20,24,33,.10);padding:28px}
.login-card h1{font-size:19px;margin:0 0 4px;font-weight:680;letter-spacing:-.2px}
.login-card p.sub{margin:0 0 22px;color:var(--muted);font-size:13px}
.login-card .btn{width:100%;justify-content:center;padding:10px;margin-top:6px}

/* ===== 提示条 ===== */
.toast{
  position:fixed;left:50%;top:18px;transform:translate(-50%,-16px);z-index:80;
  background:#141821;color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;
  opacity:0;pointer-events:none;transition:.22s;box-shadow:0 10px 30px rgba(0,0,0,.22);max-width:min(560px,92vw);
}
.toast.on{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:#9c2020}
.toast.ok{background:#12603a}
.empty{padding:36px 16px;text-align:center;color:var(--muted);font-size:13px}
.empty b{display:block;color:var(--text);margin-bottom:4px;font-size:14px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mt12{margin-top:12px}
.nowrap{white-space:nowrap}
.tr{text-align:right}
.muted{color:var(--muted)}
.faint{color:var(--faint)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;word-break:break-all}
.alert{display:flex;gap:10px;padding:11px 13px;border-radius:10px;font-size:12.5px;line-height:1.6;margin-bottom:12px}
.alert.warn{background:var(--warn-soft);color:#7a4400}
.alert.info{background:var(--brand-soft);color:#23399c}
details.adv{border:1px solid var(--line);border-radius:10px;padding:0 12px;margin-bottom:12px}
details.adv>summary{cursor:pointer;padding:11px 0;font-size:13px;font-weight:600;color:var(--muted)}
details.adv[open]>summary{border-bottom:1px solid var(--line);margin-bottom:12px}
</style>
</head>`

// ===== 登录页 =====

export async function renderLoginPage(c: Context<AppEnv>) {
  const html = `${HEAD('登录')}
<body>
<div class="login">
  <form class="login-card" id="f">
    <h1>${esc(SITE_CONFIG.title)}</h1>
    <p class="sub">${esc(SITE_CONFIG.subtitle)}</p>
    <div class="field">
      <label for="u">用户名</label>
      <input class="input" id="u" name="username" autocomplete="username" required autofocus>
    </div>
    <div class="field">
      <label for="p">密码</label>
      <input class="input" id="p" name="password" type="password" autocomplete="current-password" required>
    </div>
    <button class="btn btn-primary" id="go" type="submit">登录</button>
    <p class="hint" style="margin-top:14px">首次部署请先在 Cloudflare 环境变量中设置 ADMIN_USERNAME 与 ADMIN_PASSWORD。</p>
  </form>
</div>
<div class="toast" id="toast"></div>
<script>
const toast = (msg, kind) => {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast on' + (kind ? ' ' + kind : '');
  clearTimeout(window.__tt);
  window.__tt = setTimeout(() => { t.className = 'toast' }, 2800);
};
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('go');
  btn.disabled = true;
  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('u').value.trim(),
        password: document.getElementById('p').value,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.success) { location.href = '/admin'; return; }
    toast(j.message || '登录失败', 'bad');
  } catch (err) {
    toast('网络错误：' + err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});
</script>
</body>
</html>`
  return c.html(html)
}

// ===== 管理后台 =====

export async function renderAdminPage(c: Context<AppEnv>) {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  const html = `${HEAD('控制台')}
<body>
<header class="top">
  <div class="top-in">
    <div class="brand"><span class="dot"></span>${esc(SITE_CONFIG.title)}<small id="ver">WorkBuddy 账号池</small></div>
    <div class="spacer"></div>
    <button class="btn btn-sm" id="btn-refresh" title="重新拉取数据">刷新</button>
    <button class="btn btn-sm btn-ghost" id="btn-logout">退出</button>
  </div>
</header>

<main class="wrap">
  <nav class="tabs" id="tabs">
    <button class="tab on" data-tab="home">概览</button>
    <button class="tab" data-tab="accounts">账号池</button>
    <button class="tab" data-tab="models">模型</button>
    <button class="tab" data-tab="access">接入</button>
    <button class="tab" data-tab="logs">日志</button>
    <button class="tab" data-tab="settings">设置</button>
  </nav>

  <!-- 概览 -->
  <section id="tab-home">
    <div class="grid g4" id="stats"></div>
    <div class="panel mt12" id="expiring-panel" style="display:none">
      <div class="panel-h"><h2>即将到期的积分</h2><span class="sub">到期越早越优先消耗，错过作废</span></div>
      <div class="panel-b flush" id="expiring"></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2>快捷操作</h2><span class="sub">按当前账号池执行</span></div>
      <div class="panel-b">
        <div class="row">
          <button class="btn btn-primary" id="btn-daily">一键日常</button>
          <button class="btn" id="btn-checkin">立即签到</button>
          <button class="btn" id="btn-activity">活跃上报</button>
          <button class="btn" id="btn-travel">猫猫旅行</button>
        </div>
        <p class="hint mt12">「一键日常」= 签到 + 活跃上报 + 猫猫旅行；定时任务已在 Cron 中自动执行（每日 10:05 / 22:05，夜猫子 23:30）。</p>
        <div id="op-result" class="mt12"></div>
      </div>
    </div>
    <div class="panel" id="checkin-panel">
      <div class="panel-h"><h2>签到结果</h2><span class="sub">最近一次签到 / 日常任务汇总</span></div>
      <div class="panel-b flush" id="checkin"></div>
    </div>
  </section>

  <!-- 账号池 -->
  <section id="tab-accounts" style="display:none">
    <div class="panel">
      <div class="panel-h">
        <h2>账号池</h2>
        <span class="sub" id="acct-sub"></span>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="btn-pull-models">拉取模型</button>
        <button class="btn btn-sm btn-primary" id="btn-login-account">添加账号</button>
      </div>
      <div class="panel-b flush" id="accounts"></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2>账号池规则</h2></div>
      <div class="panel-b">
        <dl class="kv">
          <dt>挑号策略</dt><dd>优先「7 天内到期且仍有剩余」的账号（到期越早越先消耗），否则按剩余积分加权随机</dd>
          <dt>冷却机制</dt><dd>429 / 余额不足 / 连续错误自动冷却并轮转下一个账号，冷却到期自动恢复</dd>
          <dt>在途上限</dt><dd>单账号并发默认 3，global 域可单独下调，避免高并发把账号打爆</dd>
          <dt>域路由</dt><dd>由 Token 的 JWT <code>iss</code> 自动判断：workbuddy.ai → Global 域，codebuddy.cn → 国内域</dd>
        </dl>
      </div>
    </div>
  </section>

  <!-- 模型 -->
  <section id="tab-models" style="display:none">
    <div class="panel">
      <div class="panel-h">
        <h2>模型列表</h2>
        <span class="sub" id="models-sub"></span>
        <div class="spacer"></div>
        <input class="input" id="model-add" placeholder="手动添加模型 ID" style="width:200px">
        <button class="btn btn-sm" id="btn-add-model">添加</button>
      </div>
      <div class="panel-b flush" id="models"></div>
    </div>
  </section>

  <!-- 接入 -->
  <section id="tab-access" style="display:none">
    <div class="panel">
      <div class="panel-h"><h2>接口地址</h2></div>
      <div class="panel-b">
        <dl class="kv">
          <dt>API Base URL</dt><dd><code id="base-url"></code> <button class="btn btn-sm" data-copy="base-url">复制</button></dd>
          <dt>兼容协议</dt><dd>OpenAI Chat Completions（<code>/v1/chat/completions</code>）、Anthropic Messages（<code>/v1/messages</code>）、OpenAI Responses（<code>/v1/responses</code>）、模型列表（<code>/v1/models</code>）</dd>
          <dt>模型 ID 写法</dt><dd><code>提供商ID/模型ID</code>，例如 <code>workbuddy/claude-sonnet-4</code></dd>
        </dl>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h">
        <h2>转发 Key</h2>
        <span class="sub">客户端用 <code>Authorization: Bearer sk_wb_…</code></span>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-primary" id="btn-new-key">新建 Key</button>
      </div>
      <div class="panel-b flush" id="keys"></div>
    </div>
  </section>

  <!-- 日志 -->
  <section id="tab-logs" style="display:none">
    <div class="panel">
      <div class="panel-h">
        <h2>系统日志</h2>
        <span class="sub">存于 KV，按保留天数自动清理</span>
        <div class="spacer"></div>
        <select class="input" id="log-type" style="width:auto">
          <option value="">全部类型</option>
          <option value="error">仅错误</option>
          <option value="proxy">转发</option>
          <option value="checkin">签到</option>
          <option value="admin">管理</option>
        </select>
        <button class="btn btn-sm btn-danger" id="btn-clear-logs">清空</button>
      </div>
      <div class="panel-b">
        <div class="row" style="margin-bottom:12px">
          <label class="row" style="gap:6px"><span class="sw"><input type="checkbox" id="log-enabled"><i></i></span><span class="muted">启用日志</span></label>
          <span class="faint">保留</span>
          <input class="input" id="log-days" type="number" min="1" max="365" style="width:80px">
          <span class="faint">天</span>
          <button class="btn btn-sm" id="btn-save-log">保存</button>
        </div>
        <div id="logs"></div>
      </div>
    </div>
  </section>

  <!-- 设置 -->
  <section id="tab-settings" style="display:none">
    <div class="panel">
      <div class="panel-h"><h2>提供商</h2><span class="sub">WorkBuddy 端点与登录域</span></div>
      <div class="panel-b">
        <div class="grid g2">
          <div class="field"><label>名称</label><input class="input" id="p-name"></div>
          <div class="field"><label>Base URL</label><input class="input" id="p-base"></div>
        </div>
        <div class="grid g2">
          <div class="field"><label>登录域</label>
            <select class="input" id="p-realm">
              <option value="cn">国内版（copilot.tencent.com）</option>
              <option value="global">国际版（www.workbuddy.ai）</option>
            </select>
          </div>
          <div class="field"><label>允许未登记模型透传</label>
            <label class="row" style="gap:8px"><span class="sw"><input type="checkbox" id="p-unlisted"><i></i></span><span class="faint">开启后不校验模型是否在列表中</span></label>
          </div>
        </div>
        <details class="adv">
          <summary>高级：OAuth 端点</summary>
          <div class="grid g2">
            <div class="field"><label>发起登录</label><input class="input mono" id="o-code"></div>
            <div class="field"><label>轮询 Token</label><input class="input mono" id="o-token"></div>
            <div class="field"><label>刷新 Token</label><input class="input mono" id="o-refresh"></div>
            <div class="field"><label>模型目录</label><input class="input mono" id="o-models"></div>
            <div class="field"><label>Global 发起登录</label><input class="input mono" id="o-gcode"></div>
            <div class="field"><label>Global 轮询 Token</label><input class="input mono" id="o-gtoken"></div>
            <div class="field"><label>Global 刷新 Token</label><input class="input mono" id="o-grefresh"></div>
            <div class="field"><label>Global 模型目录</label><input class="input mono" id="o-gmodels"></div>
          </div>
          <div class="field"><label>系统提示词模式</label>
            <select class="input" id="p-promptmode">
              <option value="passthrough">passthrough（透传，命中内容拦截时自动降级重试）</option>
              <option value="custom">custom（整体替换为自有提示词）</option>
              <option value="append">append（在 system 之后追加）</option>
            </select>
          </div>
          <div class="field"><label>自有系统提示词</label><textarea class="input" id="p-prompttext" placeholder="custom / append 模式下注入"></textarea></div>
        </details>
        <div class="row">
          <button class="btn btn-primary" id="btn-save-provider">保存提供商设置</button>
          <button class="btn btn-danger" id="btn-disconnect">清空账号池</button>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2>注入设置</h2><span class="sub">思维引导 / 缓存前缀 / 超时分级</span></div>
      <div class="panel-b">
        <div class="field"><label>思维引导提示词</label><textarea class="input" id="s-thinking"></textarea>
          <span class="hint">仅在模型勾选了「思维注入」时生效（见模型列表开关）。</span></div>
        <div class="field"><label>缓存前缀提示词</label><textarea class="input" id="s-cache"></textarea>
          <span class="hint">利用上游前缀缓存降低 token 成本，仅在模型勾选「缓存前缀」时生效。</span></div>
        <div class="grid g3">
          <div class="field"><label>总超时 (ms)</label><input class="input" id="s-total" type="number"></div>
          <div class="field"><label>连接超时 (ms)</label><input class="input" id="s-connect" type="number"></div>
          <div class="field"><label>流空闲超时 (ms)</label><input class="input" id="s-idle" type="number"></div>
        </div>
        <button class="btn btn-primary" id="btn-save-inject">保存注入设置</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2>运行信息</h2></div>
      <div class="panel-b"><dl class="kv" id="runtime"></dl></div>
    </div>
  </section>
</main>

<!-- 添加账号 -->
<div class="mask" id="m-login">
  <div class="modal">
    <div class="modal-h"><h3>添加 WorkBuddy 账号</h3><button class="btn btn-sm btn-ghost" data-close>关闭</button></div>
    <div class="modal-b" id="login-body">
      <p class="hint">点击下方按钮生成登录链接，在浏览器中完成登录后本面板会自动检测并入库。</p>
      <div class="row mt12"><button class="btn btn-primary" id="btn-gen-link">生成登录链接</button></div>
      <div id="login-result" class="mt12"></div>
    </div>
  </div>
</div>

<!-- 新建 Key -->
<div class="mask" id="m-key">
  <div class="modal">
    <div class="modal-h"><h3>新建转发 Key</h3><button class="btn btn-sm btn-ghost" data-close>关闭</button></div>
    <div class="modal-b">
      <div class="field"><label>名称</label><input class="input" id="k-name" placeholder="例如：手机 / 笔记本"></div>
      <div class="field"><label>有效期</label>
        <select class="input" id="k-exp">
          <option value="30d">30 天</option>
          <option value="90d" selected>90 天</option>
          <option value="180d">180 天</option>
          <option value="1y">1 年</option>
          <option value="forever">永久</option>
        </select>
      </div>
    </div>
    <div class="modal-f">
      <button class="btn" data-close>取消</button>
      <button class="btn btn-primary" id="btn-create-key">创建</button>
    </div>
  </div>
</div>

<!-- Key 创建结果：完整 Key 只在此处展示这一次 -->
<div class="mask" id="m-key-done">
  <div class="modal">
    <div class="modal-h"><h3 id="m-key-done-title">Key 已创建</h3><button class="btn btn-sm btn-ghost" data-close>关闭</button></div>
    <div class="modal-b">
      <div class="notice bad" id="m-key-done-note"><b>请立即复制保存。</b>关闭后可在列表点「复制」再次取回完整 Key。</div>
      <div class="field">
        <label>完整 Key</label>
        <code class="keybox" id="key-new-val"></code>
        <p class="hint-inline">点击 Key 可整段选中；也可点右下角「复制 Key」。</p>
      </div>
    </div>
    <div class="modal-f">
      <button class="btn" data-close>我已保存，关闭</button>
      <button class="btn btn-primary" id="btn-copy-new-key">复制 Key</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>
<script>
/* ================= 基础工具 ================= */
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const toast = (msg, kind) => {
  const t = $('toast'); t.textContent = msg; t.className = 'toast on' + (kind ? ' ' + kind : '');
  clearTimeout(window.__tt); window.__tt = setTimeout(() => { t.className = 'toast' }, 3200);
};
async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  if (res.status === 401) { location.href = '/admin/login'; throw new Error('未登录'); }
  let j = {};
  try { j = await res.json(); } catch (e) { /* 空响应 */ }
  if (!res.ok || j.success === false) throw new Error(j.message || ('HTTP ' + res.status));
  return j;
}
const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : '—');
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function busy(btn, on, text) {
  if (!btn) return;
  if (on) { btn.dataset.t = btn.textContent; btn.textContent = text || '处理中…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.t || btn.textContent; btn.disabled = false; }
}

/* ================= 状态 ================= */
const S = { providers: [], pid: '', status: null, overview: null, checkin: null, pool: [], preferUid: '', realm: 'cn' };
let pollTimer = null;

const provider = () => S.providers.find((p) => p.id === S.pid) || S.providers[0] || null;

/* ================= 概览 ================= */
function renderStats() {
  const o = S.overview || {};
  const ck = o.checkin || {};
  const wb = o.workbuddy || {};
  const pool = S.pool || [];
  const alive = pool.filter((a) => a.enabled && !a.disabled).length;
  const cooling = pool.filter((a) => a.cooling).length;
  const p = provider();
  const cards = [
    { k: '账号', v: alive, s: '/' + pool.length, f: cooling ? cooling + ' 个冷却中' : '全部可用' },
    { k: '今日签到', v: ck.checkedIn || 0, s: '/' + (ck.totalAccounts || 0), f: ck.checkedIn >= ck.totalAccounts && ck.totalAccounts ? '已全部完成' : '部分待签到' },
    { k: '可用积分', v: fmtNum(wb.remain || 0), s: '', f: wb.size ? '额度池 ' + fmtNum(wb.size) : '以签到回读为准' },
    { k: '模型', v: p ? p.models.filter((m) => m.enabled).length : 0, s: '/' + (p ? p.models.length : 0), f: p && p.enabled ? '提供商已启用' : '提供商已停用' },
  ];
  $('stats').innerHTML = cards.map((c) => \`
    <div class="stat">
      <div class="k">\${esc(c.k)}</div>
      <div class="v">\${esc(c.v)}<small>\${esc(c.s)}</small></div>
      <div class="f">\${esc(c.f)}</div>
    </div>\`).join('');
}

function renderExpiring() {
  const ex = (S.overview || {}).expiring;
  const panel = $('expiring-panel');
  if (!ex || !ex.channels || !ex.channels.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const rows = ex.channels.map((ch) => {
    const days = Math.max(0, Math.floor((ch.soonestAt - Date.now()) / 86400000));
    return \`<tr>
      <td>\${esc(ch.label)}</td>
      <td class="num">\${fmtNum(ch.amount)}</td>
      <td>\${esc(ch.packs || '')}</td>
      <td><span class="badge \${days <= 2 ? 'b-bad' : 'b-warn'}">\${days} 天后到期</span></td>
      <td class="faint">\${esc(fmtTime(ch.soonestAt))}</td>
    </tr>\`;
  }).join('');
  $('expiring').innerHTML = \`<table><thead><tr><th>渠道</th><th>积分</th><th>权益包</th><th>最早到期</th><th>时间</th></tr></thead><tbody>\${rows}</tbody></table>\`;
}

function renderCheckin() {
  const list = ((S.checkin || {}).workbuddy) || [];
  if (!list.length) {
    $('checkin').innerHTML = '<div class="empty"><b>暂无签到记录</b>添加账号后执行「一键日常」或等待定时任务</div>';
    return;
  }
  const rows = list.map((r) => {
    const okBadge = r.success
      ? '<span class="badge b-ok">成功</span>'
      : r.todayCheckedIn
        ? '<span class="badge b-mute">已签到</span>'
        : '<span class="badge ' + (r.reason === 'skipped_global' ? 'b-mute' : 'b-bad') + '">' + esc(reasonText(r.reason)) + '</span>';
    const extra = [];
    if (r.checkinCredit) extra.push('+' + r.checkinCredit + ' 积分');
    if (r.streakDays) extra.push('连登 ' + r.streakDays + ' 天');
    if (r.growthReward && r.growthReward.acted) extra.push('连登奖励 ' + (r.growthReward.message || ''));
    if (r.blindBox && r.blindBox.acted) extra.push('盲盒 ×' + r.blindBox.opened);
    if (r.catTravel && r.catTravel.state) extra.push('旅行：' + r.catTravel.state);
    if (r.nightCat && r.nightCat.state) extra.push('夜猫子：' + r.nightCat.state);
    if (r.trialClaim && r.trialClaim.success) extra.push('国际版试用包已领');
    return \`<tr>
      <td><div style="font-weight:600">\${esc(r.nickname || r.name || r.providerId)}</div>
          <div class="faint mono" style="font-size:11px">\${esc((r.uid || '').slice(0, 12) || r.providerId)}</div></td>
      <td>\${r.realm === 'global' ? '<span class="badge b-brand">国际</span>' : r.realm === 'cn' ? '<span class="badge b-mute">国内</span>' : '<span class="badge b-mute">未知</span>'}</td>
      <td>\${okBadge}</td>
      <td class="num">\${r.totalRemain != null ? fmtNum(r.totalRemain) : '—'}</td>
      <td class="faint" style="max-width:340px">\${esc(extra.join(' · ') || r.message || '')}</td>
      <td class="faint nowrap">\${esc(r.updatedAt ? fmtTime(r.updatedAt) : '—')}</td>
    </tr>\`;
  }).join('');
  $('checkin').innerHTML = \`<table><thead><tr><th>账号</th><th>域</th><th>状态</th><th>余额</th><th>详情</th><th>更新时间</th></tr></thead><tbody>\${rows}</tbody></table>\`;
}

function reasonText(r) {
  return ({
    ok: '成功', already: '今日已签', skipped_global: '国际版免签', skipped_no_token: '无凭证', fail: '失败',
  })[r] || r || '未知';
}

/* ================= 账号池 ================= */
function renderAccounts() {
  const p = provider();
  const pool = S.pool || [];
  $('acct-sub').textContent = p ? (p.id + ' · ' + pool.length + ' 个账号') : '';
  if (!p) {
    $('accounts').innerHTML = '<div class="empty"><b>没有提供商</b>请检查 KV 中的 providers 配置</div>';
    return;
  }
  if (!pool.length) {
    $('accounts').innerHTML = '<div class="empty"><b>账号池为空</b>点击右上角「添加账号」，用 WorkBuddy 账号登录后自动入库</div>';
    return;
  }
  const rows = pool.map((a) => {
    const state = a.disabled
      ? '<span class="badge b-bad">已禁用</span>'
      : a.cooling
        ? '<span class="badge b-warn">冷却 ' + esc(a.remainingText || '') + '</span>'
        : a.enabled === false
          ? '<span class="badge b-mute">已暂停</span>'
          : '<span class="badge b-ok">可用</span>';
    const realm = a.realm === 'global'
      ? '<span class="badge b-brand">国际</span>'
      : '<span class="badge b-mute">国内</span>';
    const isPrefer = S.preferUid && S.preferUid === a.uid;
    const expire = a.expiresAt ? (a.expiresAt > Date.now() ? '<span class="faint">' + esc(fmtTime(a.expiresAt)) + '</span>' : '<span class="badge b-warn">已过期</span>') : '—';
    return \`<tr>
      <td>
        <div style="font-weight:600">\${esc(a.nickname || '(未命名)')}</div>
        <div class="faint mono" style="font-size:11px">\${esc(a.uid)}</div>
      </td>
      <td>\${realm}</td>
      <td>\${state} \${isPrefer ? '<span class="badge b-brand">首选</span>' : ''}</td>
      <td class="num">\${fmtNum(a.credits || 0)}</td>
      <td class="num">\${a.successCount || 0} / \${a.errTotal || 0}</td>
      <td>\${expire}</td>
      <td class="faint nowrap">\${esc(a.updatedAt ? fmtTime(a.updatedAt) : '—')}</td>
      <td class="tr nowrap">
        <button class="btn btn-sm" data-act="prefer" data-uid="\${esc(a.uid)}">\${isPrefer ? '取消首选' : '设为首选'}</button>
        <button class="btn btn-sm" data-act="toggle" data-uid="\${esc(a.uid)}" data-on="\${a.enabled === false ? '1' : '0'}">\${a.enabled === false ? '启用' : '暂停'}</button>
        <button class="btn btn-sm btn-danger" data-act="remove" data-uid="\${esc(a.uid)}">删除</button>
      </td>
    </tr>\`;
  }).join('');
  $('accounts').innerHTML = \`<table>
    <thead><tr><th>账号</th><th>域</th><th>状态</th><th>积分</th><th>成功/错误</th><th>Token 到期</th><th>更新</th><th class="tr">操作</th></tr></thead>
    <tbody>\${rows}</tbody></table>\`;

  $('accounts').querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => accountAction(btn.dataset.act, btn.dataset.uid, btn.dataset.on === '1', btn));
  });
}

async function accountAction(act, uid, on, btn) {
  const p = provider(); if (!p) return;
  try {
    busy(btn, true);
    if (act === 'prefer') {
      await api('/admin/api/oauth/' + encodeURIComponent(p.id) + '/pool/prefer', {
        method: 'POST', body: JSON.stringify({ uid: S.preferUid === uid ? '' : uid }),
      });
      toast(S.preferUid === uid ? '已恢复自动挑选' : '已设为首选账号', 'ok');
    } else if (act === 'toggle') {
      await api('/admin/api/oauth/' + encodeURIComponent(p.id) + '/pool/toggle', {
        method: 'POST', body: JSON.stringify({ uid, enabled: on }),
      });
      toast(on ? '已启用' : '已暂停', 'ok');
    } else if (act === 'remove') {
      if (!confirm('从账号池删除该账号？凭证会一并移除，需要重新登录才能恢复。')) return;
      await api('/admin/api/oauth/' + encodeURIComponent(p.id) + '/pool/remove', {
        method: 'POST', body: JSON.stringify({ uid }),
      });
      toast('已删除', 'ok');
    }
    await loadPool();
    await loadOverview();
  } catch (e) { toast(e.message, 'bad'); }
  finally { busy(btn, false); }
}

/* ================= 模型 ================= */
function renderModels() {
  const p = provider();
  if (!p) { $('models').innerHTML = '<div class="empty">没有提供商</div>'; return; }
  $('models-sub').textContent = p.models.length + ' 个 · ' + p.models.filter((m) => m.enabled).length + ' 个已启用';
  if (!p.models.length) {
    $('models').innerHTML = '<div class="empty"><b>还没有模型</b>点击右上角「拉取模型」从上游目录同步，或手动添加</div>';
    return;
  }
  const rows = p.models.map((m, i) => {
    const think = (p.thinkingInject || []).includes(m.id);
    const cache = (p.cachePrefixInject || []).includes(m.id);
    return \`<tr>
      <td class="mono" style="font-size:12.5px">\${esc(m.id)}</td>
      <td><label class="sw"><input type="checkbox" data-m="enabled" data-i="\${i}" \${m.enabled ? 'checked' : ''}><i></i></label></td>
      <td><label class="sw"><input type="checkbox" data-m="think" data-i="\${i}" \${think ? 'checked' : ''}><i></i></label></td>
      <td><label class="sw"><input type="checkbox" data-m="cache" data-i="\${i}" \${cache ? 'checked' : ''}><i></i></label></td>
      <td class="tr"><button class="btn btn-sm btn-danger" data-del="\${i}">删除</button></td>
    </tr>\`;
  }).join('');
  $('models').innerHTML = \`<table><thead><tr><th>模型 ID</th><th>启用</th><th>思维注入</th><th>缓存前缀</th><th class="tr">操作</th></tr></thead><tbody>\${rows}</tbody></table>\`;

  $('models').querySelectorAll('input[data-m]').forEach((el) => {
    el.addEventListener('change', async () => {
      const i = Number(el.dataset.i);
      const p2 = provider();
      const model = p2.models[i];
      if (!model) return;
      const patch = {};
      if (el.dataset.m === 'enabled') {
        const models = p2.models.map((x, k) => k === i ? { ...x, enabled: el.checked } : x);
        patch.models = models;
      } else {
        const key = el.dataset.m === 'think' ? 'thinkingInject' : 'cachePrefixInject';
        const cur = new Set(p2[key] || []);
        if (el.checked) cur.add(model.id); else cur.delete(model.id);
        patch[key] = [...cur];
      }
      try {
        await api('/admin/api/providers/' + encodeURIComponent(p2.id), { method: 'PUT', body: JSON.stringify(patch) });
        await loadProviders();
        toast('已保存', 'ok');
      } catch (e) { toast(e.message, 'bad'); el.checked = !el.checked; }
    });
  });
  $('models').querySelectorAll('button[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p2 = provider();
      const i = Number(btn.dataset.del);
      const models = p2.models.filter((_, k) => k !== i);
      try {
        await api('/admin/api/providers/' + encodeURIComponent(p2.id), { method: 'PUT', body: JSON.stringify({ models }) });
        await loadProviders();
        toast('已删除', 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    });
  });
}

/* ================= Key ================= */
async function loadKeys() {
  try {
    const j = await api('/admin/api/proxy-keys');
    const list = j.data || [];
    if (!list.length) { $('keys').innerHTML = '<div class="empty">还没有转发 Key</div>'; return; }
    const rows = list.map((k) => {
      const expired = k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
      const badge = !k.enabled ? '<span class="badge b-mute">已停用</span>' : expired ? '<span class="badge b-bad">已过期</span>' : '<span class="badge b-ok">有效</span>';
      return \`<tr>
        <td style="font-weight:600">\${esc(k.name || '(未命名)')}</td>
        <td class="mono" style="font-size:12px">\${esc(k.key)}
          <button class="btn btn-sm" data-kcopy="\${esc(k.id)}">复制</button></td>
        <td>\${badge}</td>
        <td class="faint">\${esc(k.expiresAt ? fmtTime(new Date(k.expiresAt).getTime()) : '永久')}</td>
        <td class="tr nowrap">
          <button class="btn btn-sm" data-ktoggle="\${esc(k.id)}" data-on="\${k.enabled ? '1' : '0'}">\${k.enabled ? '停用' : '启用'}</button>
          <button class="btn btn-sm btn-danger" data-kdel="\${esc(k.id)}">删除</button>
        </td>
      </tr>\`;
    }).join('');
    $('keys').innerHTML = \`<table><thead><tr><th>名称</th><th>Key（脱敏）</th><th>状态</th><th>到期</th><th class="tr">操作</th></tr></thead><tbody>\${rows}</tbody></table>
      <p class="hint-inline">列表只显示脱敏值；点「复制」取回该条完整 Key。完整 Key 可在本页按需查看，请在可信环境下操作。</p>\`;
    $('keys').querySelectorAll('[data-ktoggle]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api('/admin/api/proxy-keys/' + encodeURIComponent(b.dataset.ktoggle), {
          method: 'PATCH', body: JSON.stringify({ enabled: b.dataset.on !== '1' }),
        });
        await loadKeys();
      } catch (e) { toast(e.message, 'bad'); }
    }));
    $('keys').querySelectorAll('[data-kdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('删除该 Key？已配置该 Key 的客户端会立即失效。')) return;
      try {
        await api('/admin/api/proxy-keys/' + encodeURIComponent(b.dataset.kdel), { method: 'DELETE' });
        await loadKeys();
        toast('已删除', 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    }));
    // 复制完整 Key：列表只给脱敏值，这里按 id 单条取回明文。
    // 剪贴板写入放在 fetch 之后可能因手势过期被拒，此时退回弹窗让用户手动复制。
    $('keys').querySelectorAll('[data-kcopy]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const j = await api('/admin/api/proxy-keys/' + encodeURIComponent(b.dataset.kcopy) + '/reveal');
        const full = (j.data || {}).key || '';
        if (!full) { toast('未取到完整 Key', 'bad'); return; }
        try {
          await navigator.clipboard.writeText(full);
          toast('已复制完整 Key', 'ok');
        } catch (err) {
          showFullKey(full, '完整 Key', '浏览器拒绝自动复制，已为你展开完整 Key。请手动选中后按 Ctrl+C。');
        }
      } catch (e) { toast(e.message, 'bad'); }
    }));
  } catch (e) {
    $('keys').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}

/* ================= 日志 ================= */
async function loadLogs() {
  try {
    const type = $('log-type').value;
    const j = await api('/admin/api/logs?limit=60' + (type ? '&type=' + encodeURIComponent(type) : ''));
    const d = j.data || {};
    const list = d.logs || d.entries || [];
    if (!list.length) { $('logs').innerHTML = '<div class="empty">暂无日志</div>'; }
    else {
      $('logs').innerHTML = list.map((l) => {
        const bad = l.type === 'error' || l.level === 'error';
        return \`<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
          <span class="faint mono nowrap" style="font-size:11.5px;min-width:120px">\${esc(fmtTime(l.time || l.ts))}</span>
          <span class="badge \${bad ? 'b-bad' : 'b-mute'}" style="align-self:flex-start">\${esc(l.type || 'info')}</span>
          <span style="flex:1;word-break:break-word">\${esc(l.message || '')}
            \${l.details ? '<div class="faint mono" style="font-size:11.5px;margin-top:2px;white-space:pre-wrap">' + esc(String(l.details).slice(0, 300)) + '</div>' : ''}</span>
        </div>\`;
      }).join('');
    }
    const cfg = await api('/admin/api/logs/config');
    $('log-enabled').checked = (cfg.data || {}).enabled !== false;
    $('log-days').value = (cfg.data || {}).retentionDays || 7;
  } catch (e) {
    $('logs').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}

/* ================= 设置 ================= */
function fillSettings() {
  const p = provider();
  if (!p) return;
  $('p-name').value = p.name || '';
  $('p-base').value = p.baseUrl || '';
  $('p-unlisted').checked = !!p.allowUnlistedModels;
  $('p-promptmode').value = p.promptMode || 'passthrough';
  $('p-prompttext').value = p.promptText || '';
  const o = p.oauth || {};
  $('p-realm').value = o.loginRealm === 'global' ? 'global' : 'cn';
  $('o-code').value = o.deviceCodeUrl || '';
  $('o-token').value = o.deviceTokenUrl || '';
  $('o-refresh').value = o.refreshTokenUrl || '';
  $('o-models').value = o.modelsUrl || '';
  $('o-gcode').value = o.globalDeviceCodeUrl || '';
  $('o-gtoken').value = o.globalDeviceTokenUrl || '';
  $('o-grefresh').value = o.globalRefreshTokenUrl || '';
  $('o-gmodels').value = o.globalModelsUrl || '';
}

async function loadSettings() {
  fillSettings();
  try {
    const [think, cache, perf] = await Promise.all([
      api('/admin/api/thinking-prompt'), api('/admin/api/cache-prefix'), api('/admin/api/perf-settings'),
    ]);
    $('s-thinking').value = (think.data || {}).prompt || '';
    $('s-cache').value = (cache.data || {}).prefix || '';
    const pf = (perf.data || {}).settings || {};
    $('s-total').value = pf.totalTimeoutMs || '';
    $('s-connect').value = pf.connectTimeoutMs || '';
    $('s-idle').value = pf.idleTimeoutMs || '';
  } catch (e) { /* 设置项缺失不阻塞面板 */ }
  const st = S.status || {};
  $('runtime').innerHTML = \`
    <dt>API Base URL</dt><dd class="mono">\${esc(st.baseUrl || '')}</dd>
    <dt>提供商</dt><dd>\${esc(st.providersCount || 0)} 个（启用 \${esc(st.enabledProvidersCount || 0)}）</dd>
    <dt>模型</dt><dd>\${esc(st.modelsCount || 0)} 个（启用 \${esc(st.enabledModelsCount || 0)}）</dd>
    <dt>转发 Key</dt><dd>\${esc(st.proxyKeysCount || 0)} 个有效</dd>
    <dt>管理员</dt><dd>\${st.adminConfigured ? '已配置' : '未配置（请设置 ADMIN_USERNAME / ADMIN_PASSWORD）'}</dd>\`;
  $('base-url').textContent = (st.baseUrl || location.origin) + '/v1';
}

/* ================= 数据加载 ================= */
async function loadProviders() {
  const j = await api('/admin/api/providers');
  S.providers = (j.data || []).filter((p) => p.authType === 'oauth-device' || p.id.startsWith('workbuddy'));
  if (!S.providers.length) S.providers = j.data || [];
  if (!S.pid || !S.providers.some((p) => p.id === S.pid)) S.pid = S.providers[0] ? S.providers[0].id : '';
  renderModels();
}

async function loadPool() {
  const p = provider(); if (!p) { S.pool = []; renderAccounts(); return; }
  try {
    const j = await api('/admin/api/oauth/' + encodeURIComponent(p.id) + '/status');
    const d = j.data || {};
    S.pool = d.pool || [];
    S.preferUid = d.preferUid || '';
    $('acct-sub').textContent = p.id + ' · ' + S.pool.length + ' 个账号';
  } catch (e) {
    S.pool = [];
  }
  renderAccounts();
}

async function loadOverview() {
  try {
    const [ov, ck, st] = await Promise.all([
      api('/admin/api/overview'), api('/admin/api/checkin/status'), api('/admin/api/status'),
    ]);
    S.overview = ov.data || {};
    S.checkin = ck.data || {};
    S.status = st.data || {};
  } catch (e) { /* 概览失败不影响其它面板 */ }
  renderStats(); renderExpiring(); renderCheckin();
}

async function loadAll() {
  try {
    await loadProviders();
    await Promise.all([loadPool(), loadOverview(), loadKeys()]);
    await loadSettings();
    await loadLogs();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ================= 交互 ================= */
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab'); if (!b) return;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
  ['home', 'accounts', 'models', 'access', 'logs', 'settings'].forEach((k) => {
    $('tab-' + k).style.display = (k === b.dataset.tab) ? '' : 'none';
  });
  if (b.dataset.tab === 'logs') loadLogs();
  if (b.dataset.tab === 'settings') loadSettings();
});

$('btn-refresh').addEventListener('click', async (e) => { busy(e.currentTarget, true, '刷新中'); await loadAll(); busy(e.currentTarget, false); toast('已刷新', 'ok'); });
$('btn-logout').addEventListener('click', async () => { await fetch('/admin/logout', { method: 'POST' }); location.href = '/admin/login'; });

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
  b.closest('.mask').classList.remove('on');
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}));
document.querySelectorAll('.mask').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) { m.classList.remove('on'); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } } }));

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy],[data-copy-text]');
  if (!c) return;
  const text = c.dataset.copyText || ($(c.dataset.copy) ? $(c.dataset.copy).textContent : '');
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast('已复制', 'ok'); }
  catch (err) { toast('复制失败，请手动选择', 'bad'); }
});

// 添加账号
$('btn-login-account').addEventListener('click', () => {
  $('m-login').classList.add('on');
  $('login-result').innerHTML = '';
});
$('btn-gen-link').addEventListener('click', async (e) => {
  const p = provider(); if (!p) return;
  const btn = e.currentTarget;
  try {
    busy(btn, true, '生成中…');
    const j = await api('/admin/api/oauth/' + encodeURIComponent(p.id) + '/connect', { method: 'POST', body: '{}' });
    const d = j.data || {};
    const url = d.verification_uri || d.authUrl || '';
    if (!url) throw new Error('上游未返回登录链接');
    $('login-result').innerHTML = \`
      <div class="alert info">在浏览器打开下面的链接完成登录，面板会自动检测（有效期 5 分钟）。</div>
      <div class="field"><label>登录链接</label><input class="input mono" id="auth-url" value="\${esc(url)}" readonly></div>
      <div class="row">
        <a class="btn btn-primary" href="\${esc(url)}" target="_blank" rel="noreferrer">打开登录页</a>
        <button class="btn" data-copy="auth-url">复制链接</button>
        <button class="btn" id="btn-poll">我已登录，检测</button>
      </div>
      <p class="hint mt12" id="poll-state">等待登录…</p>\`;
    $('btn-poll').addEventListener('click', () => pollLogin(p.id));
    startPoll(p.id);
  } catch (err) { toast(err.message, 'bad'); }
  finally { busy(btn, false); }
});

function startPoll(pid) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => pollLogin(pid, true), 4000);
}

async function pollLogin(pid, quiet) {
  try {
    const j = await api('/admin/api/oauth/' + encodeURIComponent(pid) + '/poll', { method: 'POST', body: '{}' });
    const ok = j.success;
    const st = $('poll-state');
    if (st) st.textContent = j.message || (ok ? '登录成功' : '等待登录…');
    if (ok) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      toast('账号已加入池', 'ok');
      setTimeout(async () => { $('m-login').classList.remove('on'); await loadPool(); await loadOverview(); }, 600);
    }
  } catch (e) {
    if (!quiet && $('poll-state')) $('poll-state').textContent = e.message;
  }
}

// 新建 Key
$('btn-new-key').addEventListener('click', () => {
  $('key-new-val').textContent = '';
  $('k-name').value = '';
  $('m-key').classList.add('on');
});
$('btn-create-key').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    busy(btn, true, '创建中…');
    const j = await api('/admin/api/proxy-keys', {
      method: 'POST',
      body: JSON.stringify({ name: $('k-name').value.trim(), expiresIn: $('k-exp').value }),
    });
    const k = (j.data || {}).key || '';
    $('m-key').classList.remove('on');
    await loadKeys();
    // 完整 Key 只在创建响应里出现这一次：用弹窗常驻展示并允许手动选中。
    // 不能再用 toast 承载——toast 2.8 秒自动消失，且窄气泡会把长 Key 省略号截断，
    // 这正是「创建后看不到完整 Key」的根因。
    if (!k) { toast('已创建，但响应未返回完整 Key', 'bad'); return; }
    showFullKey(k, 'Key 已创建');
  } catch (err) { toast(err.message, 'bad'); }
  finally { busy(btn, false); }
});

/** 在弹窗里展示一份完整 Key（创建成功、或列表复制被浏览器拒绝时的兜底） */
function showFullKey(key, title, note) {
  $('key-new-val').textContent = key;
  $('m-key-done-title').textContent = title || '完整 Key';
  if (note) $('m-key-done-note').innerHTML = note;
  $('m-key-done').classList.add('on');
}

/** 选中元素全部文本（剪贴板不可用时的兜底） */
function selectElementText(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* 选择失败时至少文本可见 */ }
}

// 复制完整 Key：在点击事件内直接调用，保住用户手势上下文。
// 若先 await 再调 clipboard，Chrome 会因手势过期抛 NotAllowedError 导致复制失败。
$('btn-copy-new-key').addEventListener('click', async () => {
  const el = $('key-new-val');
  const k = (el.textContent || '').trim();
  if (!k) return;
  try {
    await navigator.clipboard.writeText(k);
    toast('已复制完整 Key', 'ok');
  } catch (err) {
    selectElementText(el);
    toast('浏览器拒绝自动复制，已选中文本，请按 Ctrl+C', 'bad');
  }
});

// 快捷操作
async function daily(kind) {
  const p = provider(); if (!p) return;
  const map = { daily: '/daily', checkin: '', activity: '/activity', travel: '/travel' };
  const btn = $({ daily: 'btn-daily', checkin: 'btn-checkin', activity: 'btn-activity', travel: 'btn-travel' }[kind]);
  try {
    busy(btn, true, '执行中…');
    let j;
    if (kind === 'checkin') j = await api('/admin/api/checkin', { method: 'POST', body: JSON.stringify({ id: p.id }) });
    else j = await api('/admin/api/oauth/' + encodeURIComponent(p.id) + map[kind], { method: 'POST', body: '{}' });
    const s = (j.data || {}).summary || j.data || {};
    $('op-result').innerHTML = '<div class="alert info">' + esc(j.message || ('完成：' + JSON.stringify(s).slice(0, 300))) + '</div>';
    await Promise.all([loadOverview(), loadPool()]);
  } catch (e) {
    $('op-result').innerHTML = '<div class="alert warn">' + esc(e.message) + '</div>';
  } finally { busy(btn, false); }
}
$('btn-daily').addEventListener('click', () => daily('daily'));
$('btn-checkin').addEventListener('click', () => daily('checkin'));
$('btn-activity').addEventListener('click', () => daily('activity'));
$('btn-travel').addEventListener('click', () => daily('travel'));

// 拉取模型
async function pullModels(btn) {
  const p = provider(); if (!p) return;
  try {
    busy(btn, true, '拉取中…');
    const j = await api('/admin/api/oauth/' + encodeURIComponent(p.id) + '/models', { method: 'POST', body: '{}' });
    const list = ((j.data || {}).data) || [];
    if (!list.length) throw new Error('上游未返回模型');
    const have = new Set(p.models.map((m) => m.id));
    const merged = p.models.concat(list.filter((m) => !have.has(m.id)).map((m) => ({ id: m.id, enabled: true })));
    await api('/admin/api/providers/' + encodeURIComponent(p.id), { method: 'PUT', body: JSON.stringify({ models: merged }) });
    await loadProviders();
    toast('同步了 ' + (merged.length - p.models.length) + ' 个新模型' + (j.data.stale ? '（静态兜底清单）' : ''), 'ok');
  } catch (e) { toast(e.message, 'bad'); }
  finally { busy(btn, false); }
}
$('btn-pull-models').addEventListener('click', (e) => pullModels(e.currentTarget));

// 模型手动添加
$('btn-add-model').addEventListener('click', async () => {
  const p = provider(); const id = $('model-add').value.trim();
  if (!p || !id) return;
  if (p.models.some((m) => m.id === id)) { toast('该模型已存在', 'bad'); return; }
  try {
    await api('/admin/api/providers/' + encodeURIComponent(p.id), {
      method: 'PUT', body: JSON.stringify({ models: p.models.concat([{ id, enabled: true }]) }),
    });
    $('model-add').value = '';
    await loadProviders();
    toast('已添加', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
});

// 保存提供商
$('btn-save-provider').addEventListener('click', async (e) => {
  const p = provider(); if (!p) return;
  const btn = e.currentTarget;
  const oauth = Object.assign({}, p.oauth || {});
  oauth.loginRealm = $('p-realm').value;
  oauth.deviceCodeUrl = $('o-code').value.trim();
  oauth.deviceTokenUrl = $('o-token').value.trim();
  oauth.refreshTokenUrl = $('o-refresh').value.trim();
  oauth.modelsUrl = $('o-models').value.trim();
  oauth.globalDeviceCodeUrl = $('o-gcode').value.trim();
  oauth.globalDeviceTokenUrl = $('o-gtoken').value.trim();
  oauth.globalRefreshTokenUrl = $('o-grefresh').value.trim();
  oauth.globalModelsUrl = $('o-gmodels').value.trim();
  try {
    busy(btn, true, '保存中…');
    await api('/admin/api/providers/' + encodeURIComponent(p.id), {
      method: 'PUT',
      body: JSON.stringify({
        name: $('p-name').value.trim(),
        baseUrl: $('p-base').value.trim(),
        allowUnlistedModels: $('p-unlisted').checked,
        promptMode: $('p-promptmode').value,
        promptText: $('p-prompttext').value,
        oauth,
      }),
    });
    await loadProviders();
    toast('已保存', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
  finally { busy(btn, false); }
});

$('btn-disconnect').addEventListener('click', async () => {
  const p = provider(); if (!p) return;
  if (!confirm('清空账号池？所有已登录账号与凭证都会被删除，需重新登录。')) return;
  try {
    await api('/admin/api/oauth/' + encodeURIComponent(p.id) + '/disconnect', { method: 'POST', body: '{}' });
    await loadPool(); await loadOverview();
    toast('已清空', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
});

// 注入设置
$('btn-save-inject').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    busy(btn, true, '保存中…');
    await Promise.all([
      api('/admin/api/thinking-prompt', { method: 'PUT', body: JSON.stringify({ prompt: $('s-thinking').value }) }),
      api('/admin/api/cache-prefix', { method: 'PUT', body: JSON.stringify({ prefix: $('s-cache').value }) }),
      api('/admin/api/perf-settings', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            totalTimeoutMs: Number($('s-total').value) || undefined,
            connectTimeoutMs: Number($('s-connect').value) || undefined,
            idleTimeoutMs: Number($('s-idle').value) || undefined,
          },
        }),
      }),
    ]);
    toast('已保存', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
  finally { busy(btn, false); }
});

// 日志设置
$('log-type').addEventListener('change', loadLogs);
$('btn-save-log').addEventListener('click', async () => {
  try {
    await api('/admin/api/logs/config', {
      method: 'POST',
      body: JSON.stringify({ enabled: $('log-enabled').checked, retentionDays: Number($('log-days').value) || 7 }),
    });
    toast('已保存', 'ok');
    await loadLogs();
  } catch (e) { toast(e.message, 'bad'); }
});
$('btn-clear-logs').addEventListener('click', async () => {
  if (!confirm('清空全部系统日志？')) return;
  try { await api('/admin/api/logs', { method: 'DELETE' }); await loadLogs(); toast('已清空', 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
});

/* ================= 启动 ================= */
loadAll();
</script>
</body>
</html>`
  return c.html(html)
}
