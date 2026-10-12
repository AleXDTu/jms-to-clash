const axios = require('axios');

// 用量 API 与订阅 API 同凭据（service+id），但只有面板镜像域名提供，
// jmssub.net / jjsubmarines.com 只镜像订阅内容、没有 /members/ 面板
const DEFAULT_USAGE_URLS = {
  primary: (service, id) => `https://justmysocks6.net/members/getbwcounter.php?service=${service}&id=${id}`,
  fallback: (service, id) => `https://justmysocks.net/members/getbwcounter.php?service=${service}&id=${id}`
};

const GB = 1024 ** 3;

function fmtGb(bytes) {
  return (bytes / GB).toFixed(2);
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ==================== 状态判定（纯函数，便于测试） ====================

// 流量：ok → warn(≥80%) → critical(≥95%) → exhausted(≥100%)
function evaluateTraffic(usage, thresholds = {}) {
  if (!usage ||
      typeof usage.monthly_bw_limit_b !== 'number' ||
      typeof usage.bw_counter_b !== 'number') {
    return null;
  }
  const warnPct = thresholds.warnPct ?? 80;
  const criticalPct = thresholds.criticalPct ?? 95;
  const limit = usage.monthly_bw_limit_b;
  const used = usage.bw_counter_b;
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const pctFixed = pct.toFixed(1);
  const detail = `已用 ${fmtGb(used)} / ${fmtGb(limit)} GB（${pctFixed}%），${usage.bw_reset_day_of_month} 号重置`;

  if (pct >= 100) return { level: 'exhausted', sev: 4, pct, pctFixed, usedGb: fmtGb(used), limitGb: fmtGb(limit), title: 'JMS 流量已耗尽', body: detail };
  if (pct >= criticalPct) return { level: 'critical', sev: 3, pct, pctFixed, usedGb: fmtGb(used), limitGb: fmtGb(limit), title: 'JMS 流量即将耗尽', body: detail };
  if (pct >= warnPct) return { level: 'warn', sev: 2, pct, pctFixed, usedGb: fmtGb(used), limitGb: fmtGb(limit), title: 'JMS 流量用量告警', body: detail };
  return { level: 'ok', sev: 0, pct, pctFixed, usedGb: fmtGb(used), limitGb: fmtGb(limit), title: 'JMS 流量正常', body: detail };
}

// 到期：ok → soon(≤14天) → imminent(≤7天) → expired(<0天)。按 UTC 日粒度
function evaluateExpiry(expires, now = new Date(), thresholds = {}) {
  const ts = Date.parse(`${expires}T00:00:00Z`);
  if (!expires || Number.isNaN(ts)) return null;
  const soonDays = thresholds.soonDays ?? 14;
  const imminentDays = thresholds.imminentDays ?? 7;

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysLeft = Math.round((ts - today) / 86400000);
  const base = { date: expires, daysLeft };

  if (daysLeft < 0) return { ...base, level: 'expired', sev: 4, title: 'JMS 订阅已到期', body: `订阅已于 ${expires} 到期（逾期 ${-daysLeft} 天），请立即续费，否则节点将被终止` };
  if (daysLeft <= imminentDays) return { ...base, level: 'imminent', sev: 3, title: 'JMS 订阅即将到期', body: `订阅 ${expires} 到期，仅剩 ${daysLeft} 天，请尽快续费` };
  if (daysLeft <= soonDays) return { ...base, level: 'soon', sev: 2, title: 'JMS 订阅到期提醒', body: `订阅 ${expires} 到期，还剩 ${daysLeft} 天，记得续费` };
  return { ...base, level: 'ok', sev: 0, title: 'JMS 订阅有效期正常', body: `订阅 ${expires} 到期，还剩 ${daysLeft} 天` };
}

// JMS_EXPIRES 支持两种写法：YYYY-MM-DD（绝对日期）或 MM-DD（每年循环，如 08-21，
// 过期后自动顺延到下一年，年付套餐续费日固定时用这种，免去年年改配置）
function resolveExpires(expires, now = new Date()) {
  if (!expires) return null;
  const trimmed = String(expires).trim();
  const m = /^(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) return trimmed;
  const year = now.getUTCFullYear();
  let date = `${year}-${m[1]}-${m[2]}`;
  const ts = Date.parse(`${date}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (ts < today) date = `${year + 1}-${m[1]}-${m[2]}`;
  return date;
}

// ==================== 告警 ====================

// webhook 模板 URL 含 {title}/{body} 占位符则 GET（Bark/Server酱/PushPlus），
// 否则 POST JSON（ntfy / 自建接收端）
function buildWebhookRequest(url, title, body) {
  if (url.includes('{title}') || url.includes('{body}')) {
    return {
      method: 'get',
      url: url.replace('{title}', encodeURIComponent(title)).replace('{body}', encodeURIComponent(body))
    };
  }
  return { method: 'post', url, data: { title, body } };
}

async function sendWebhook(url, title, body) {
  const req = buildWebhookRequest(url, title, body);
  await axios({ ...req, timeout: 10000 });
}

// 同级告警 24 小时内不重复；级别升级立即再告；恢复时单独通知一次
function createAlerter(webhookUrl, opts = {}) {
  const realertMs = opts.realertMs ?? 24 * 60 * 60 * 1000;
  const send = opts.send || sendWebhook;
  const active = new Map(); // key -> { sev, ts }

  async function deliver(title, body) {
    if (!webhookUrl) return;
    try { await send(webhookUrl, title, body); }
    catch (e) { console.error('[ALERT] webhook 发送失败:', e.message); }
  }

  return {
    async fire(key, sev, title, body) {
      const prev = active.get(key);
      const now = Date.now();
      if (prev && !(sev > prev.sev || now - prev.ts >= realertMs)) return false;
      active.set(key, { sev, ts: now });
      console.log(`[ALERT][${key}] ${title} — ${body}`);
      await deliver(title, body);
      return true;
    },
    async resolve(key, title, body) {
      if (!active.delete(key)) return false;
      console.log(`[ALERT][${key}] 已恢复 — ${title}`);
      await deliver(title, body);
      return true;
    }
  };
}

// ==================== 轮询监控 ====================

// 订阅源连续拉取失败次数达到该值时告警（账号被终止时 getsub 会开始失败）
const SUB_FETCH_ALERT_THRESHOLD = 3;
const USAGE_API_ALERT_THRESHOLD = 3;

function startMonitoring(opts) {
  const { service, id } = opts;
  const expires = opts.expires || null;
  const webhookUrl = opts.webhookUrl || null;
  const intervalMinutes = Math.min(Math.max(parseInt(opts.intervalMinutes, 10) || 60, 5), 1440);
  const urls = opts.urls || DEFAULT_USAGE_URLS;
  const thresholds = {
    warnPct: opts.warnPct, criticalPct: opts.criticalPct,
    soonDays: opts.soonDays, imminentDays: opts.imminentDays
  };

  const state = {
    usage: null, usageAt: 0, source: null, checkedAt: null, lastError: null,
    usageApiFailures: 0, subFailures: 0
  };
  const alerter = createAlerter(webhookUrl);
  let checking = false;

  async function fetchUsage() {
    for (const [name, mk] of Object.entries(urls)) {
      try {
        const resp = await axios.get(mk(service, id), {
          timeout: 15000,
          headers: { 'User-Agent': 'ClashForWindows/0.20.39' }
        });
        // 镜像有时用 text/html 回 JSON，axios 不会自动解析
        const data = typeof resp.data === 'string' ? safeJsonParse(resp.data.trim()) : resp.data;
        if (!data || typeof data.monthly_bw_limit_b !== 'number' || typeof data.bw_counter_b !== 'number') {
          throw new Error('响应缺少流量字段');
        }
        return { data, source: name };
      } catch (e) {
        state.lastError = `${name}: ${e.message}`;
      }
    }
    return null;
  }

  async function checkOnce() {
    if (checking) return;
    checking = true;
    try {
      await doCheck();
    } finally {
      checking = false;
    }
  }

  async function doCheck() {
    const result = await fetchUsage();
    state.checkedAt = new Date().toISOString();

    if (result) {
      state.usage = result.data;
      state.usageAt = Date.now();
      state.source = result.source;
      state.usageApiFailures = 0;
      state.lastError = null;

      const traffic = evaluateTraffic(result.data, thresholds);
      if (traffic) {
        state.traffic = traffic;
        if (traffic.level === 'ok') {
          await alerter.resolve('traffic', `流量已用 ${traffic.pctFixed}%（${traffic.usedGb}/${traffic.limitGb} GB），恢复正常`);
        } else {
          await alerter.fire('traffic', traffic.sev, traffic.title, traffic.body);
        }
      }
      await alerter.resolve('usageapi', '用量 API 恢复正常');
    } else {
      state.usageApiFailures++;
      if (state.usageApiFailures >= USAGE_API_ALERT_THRESHOLD) {
        await alerter.fire('usageapi', 3, 'JMS 用量 API 连续查询失败',
          `连续 ${state.usageApiFailures} 次失败（${state.lastError}）。账号可能已失效，或镜像域名已更换`);
      }
    }

    const resolved = resolveExpires(expires);
    const expiry = resolved ? evaluateExpiry(resolved, new Date(), thresholds) : null;
    if (expiry) {
      state.expiry = { ...expiry, recurring: /^\d{2}-\d{2}$/.test(String(expires).trim()) };
      if (expiry.level === 'ok') {
        await alerter.resolve('expiry', `续费日 ${expiry.date}（${expiry.daysLeft} 天后），无需操作`);
      } else {
        await alerter.fire('expiry', expiry.sev, expiry.title, expiry.body);
      }
    }
  }

  // 由订阅转换管线回填：拉取成功/失败（缓存命中不算）
  function noteSubResult(ok) {
    if (ok) {
      if (state.subFailures > 0) {
        alerter.resolve('subfetch', '订阅源拉取恢复正常');
      }
      state.subFailures = 0;
    } else {
      state.subFailures++;
      if (state.subFailures >= SUB_FETCH_ALERT_THRESHOLD) {
        alerter.fire('subfetch', 4, 'JMS 订阅源连续拉取失败',
          `主备订阅均失败 ${state.subFailures} 次，服务正在用过期缓存。账号可能已被终止，请立即检查`);
      }
    }
  }

  function status() {
    return {
      traffic: state.traffic ? {
        level: state.traffic.level, pct: state.traffic.pctFixed,
        usedGb: state.traffic.usedGb, limitGb: state.traffic.limitGb,
        resetDay: state.usage ? state.usage.bw_reset_day_of_month : null,
        source: state.source
      } : null,
      expiry: state.expiry ? {
        level: state.expiry.level, date: state.expiry.date, daysLeft: state.expiry.daysLeft,
        recurring: state.expiry.recurring || false
      } : null,
      usageApi: {
        ok: !state.lastError, checkedAt: state.checkedAt, lastError: state.lastError
      },
      subscription: { consecutiveFailures: state.subFailures }
    };
  }

  const timer = setInterval(() => checkOnce().catch(e => console.error('[MONITOR] 检查异常:', e.message)), intervalMinutes * 60 * 1000);
  setTimeout(() => checkOnce().catch(e => console.error('[MONITOR] 检查异常:', e.message)), opts.firstCheckDelayMs ?? 3000);

  // Clash 订阅标准头（subscription-userinfo）：客户端刷新订阅时显示已用/总量/到期
  function getUserinfoHeader() {
    const u = state.usage;
    if (!u) return null;
    let h = `upload=0; download=${u.bw_counter_b}; total=${u.monthly_bw_limit_b}`;
    const resolved = resolveExpires(expires);
    if (resolved && evaluateExpiry(resolved)) {
      h += `; expire=${Math.floor(Date.parse(`${resolved}T23:59:59Z`) / 1000)}`;
    }
    return h;
  }

  // 用量数据过期时按需异步刷新（不阻塞当前请求，刷新后的值下次请求生效）
  function refreshIfStale(maxAgeMs = 15 * 60 * 1000) {
    if (state.usageAt && Date.now() - state.usageAt <= maxAgeMs) return;
    checkOnce().catch(e => console.error('[MONITOR] 按需刷新异常:', e.message));
  }

  return { status, noteSubResult, getUserinfoHeader, refreshIfStale, stop() { clearInterval(timer); } };
}

module.exports = {
  evaluateTraffic,
  evaluateExpiry,
  resolveExpires,
  buildWebhookRequest,
  createAlerter,
  startMonitoring
};
