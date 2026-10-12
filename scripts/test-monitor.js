// monitor 模块自测：node scripts/test-monitor.js
// 纯函数断言 + 本地 mock API/webhook 的端到端验证，不依赖外网
const assert = require('assert/strict');
const http = require('http');
const { evaluateTraffic, evaluateExpiry, resolveExpires, buildWebhookRequest, createAlerter, startMonitoring } = require('../src/monitor');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ---------- evaluateTraffic ----------
console.log('evaluateTraffic 阈值判定');
const TB = 1e12;
ok('79.9% → ok', () => assert.equal(evaluateTraffic({ monthly_bw_limit_b: TB, bw_counter_b: TB * 0.799 }).level, 'ok'));
ok('80% → warn', () => assert.equal(evaluateTraffic({ monthly_bw_limit_b: TB, bw_counter_b: TB * 0.80 }).level, 'warn'));
ok('95% → critical', () => assert.equal(evaluateTraffic({ monthly_bw_limit_b: TB, bw_counter_b: TB * 0.95 }).level, 'critical'));
ok('99.9% → critical', () => assert.equal(evaluateTraffic({ monthly_bw_limit_b: TB, bw_counter_b: TB * 0.999 }).level, 'critical'));
ok('100% → exhausted', () => assert.equal(evaluateTraffic({ monthly_bw_limit_b: TB, bw_counter_b: TB }).level, 'exhausted'));
ok('真实返回样例 → ok', () => {
  const r = evaluateTraffic({ monthly_bw_limit_b: 1000000000000, bw_counter_b: 815426543, bw_reset_day_of_month: 21 });
  assert.equal(r.level, 'ok');
  assert.equal(r.usedGb, '0.76');
  assert.equal(r.limitGb, '931.32');
});
ok('缺字段 → null', () => assert.equal(evaluateTraffic({ foo: 1 }), null));
ok('自定义阈值生效', () => assert.equal(evaluateTraffic({ monthly_bw_limit_b: 100, bw_counter_b: 5 }, { warnPct: 1 }).level, 'warn'));

// ---------- evaluateExpiry ----------
console.log('evaluateExpiry 到期判定（固定当前时间 2026-08-24）');
const NOW = new Date('2026-08-24T10:00:00Z');
ok('20 天后 → ok', () => assert.equal(evaluateExpiry('2026-09-13', NOW).level, 'ok'));
ok('14 天后 → soon', () => assert.equal(evaluateExpiry('2026-09-07', NOW).level, 'soon'));
ok('7 天后 → imminent', () => assert.equal(evaluateExpiry('2026-08-31', NOW).level, 'imminent'));
ok('当天 → imminent', () => assert.equal(evaluateExpiry('2026-08-24', NOW).level, 'imminent'));
ok('昨天 → expired', () => assert.equal(evaluateExpiry('2026-08-23', NOW).level, 'expired'));
ok('daysLeft 按日计算', () => assert.equal(evaluateExpiry('2026-08-31', NOW).daysLeft, 7));
ok('非法日期 → null', () => assert.equal(evaluateExpiry('不是日期', NOW), null));
ok('未配置 → null', () => assert.equal(evaluateExpiry(undefined, NOW), null));

// ---------- resolveExpires 年度循环 ----------
console.log('resolveExpires 年度循环（当前 2026-08-24）');
ok('今年已过 → 顺延明年', () => assert.equal(resolveExpires('08-21', NOW), '2027-08-21'));
ok('到期日当天 → 仍是今年', () => assert.equal(resolveExpires('08-24', NOW), '2026-08-24'));
ok('今年未到 → 今年', () => assert.equal(resolveExpires('08-25', NOW), '2026-08-25'));
ok('绝对日期原样返回', () => assert.equal(resolveExpires('2027-08-21', NOW), '2027-08-21'));
ok('未配置 → null', () => assert.equal(resolveExpires(undefined, NOW), null));

// ---------- buildWebhookRequest ----------
console.log('buildWebhookRequest 推送格式');
ok('含占位符 → GET 且编码', () => {
  const r = buildWebhookRequest('https://api.day.app/KEY/{title}/{body}', '流量 已用', 'a/b&c');
  assert.equal(r.method, 'get');
  assert.equal(r.url, 'https://api.day.app/KEY/%E6%B5%81%E9%87%8F%20%E5%B7%B2%E7%94%A8/a%2Fb%26c');
});
ok('无占位符 → POST JSON', () => {
  const r = buildWebhookRequest('https://ntfy.example.com/topic', '标题', '内容');
  assert.equal(r.method, 'post');
  assert.deepEqual(r.data, { title: '标题', body: '内容' });
});

// ---------- createAlerter ----------
console.log('createAlerter 去重 / 升级 / 恢复');
(async () => {
  const sent = [];
  const alerter = createAlerter('http://x/{title}/{body}', { realertMs: 50, send: async (url, t, b) => { sent.push(t); } });

  assert.equal(await alerter.fire('traffic', 2, '告警A', 'x'), true, '首次告警发出');
  assert.equal(await alerter.fire('traffic', 2, '告警A', 'x'), false, '同级 24h 内不重复');
  assert.equal(await alerter.fire('traffic', 3, '告警B升级', 'x'), true, '级别升级立即再告');
  assert.equal(await alerter.fire('traffic', 3, '告警B升级', 'x'), false, '升级后同级仍去重');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(await alerter.fire('traffic', 3, '告警B', 'x'), true, '超过重告间隔后再告');
  assert.equal(await alerter.resolve('traffic', '已恢复', 'ok'), true, '恢复通知发出');
  assert.equal(await alerter.resolve('traffic', '已恢复', 'ok'), false, '重复恢复不再通知');
  assert.equal(sent.length, 4, `共发送 ${sent.length} 次`);
  passed++;
  console.log('  ✓ alerter 全流程');

  // ---------- startMonitoring 端到端（mock API + mock webhook） ----------
  console.log('startMonitoring 端到端（本地 mock）');
  const hooks = [];
  const hookServer = http.createServer((req, res) => { hooks.push(decodeURIComponent(req.url)); res.writeHead(200).end('ok'); });

  let usageBody = JSON.stringify({ monthly_bw_limit_b: 1000, bw_counter_b: 100, bw_reset_day_of_month: 21 });
  const apiServer = http.createServer((req, res) => {
    if (!req.url.includes('service=1&id=k')) { res.writeHead(200).end('Invalid parameters'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(usageBody);
  });

  await Promise.all([
    new Promise(r => hookServer.listen(0, '127.0.0.1', r)),
    new Promise(r => apiServer.listen(0, '127.0.0.1', r))
  ]);
  const mk = (srv) => (s, id) => `http://127.0.0.1:${srv.address().port}/getbwcounter.php?service=${s}&id=${id}`;
  const hookUrl = `http://127.0.0.1:${hookServer.address().port}/push/{title}/{body}`;

  // 到期日相对当前时间生成，避免硬编码日期随真实时钟过期
  const EXPIRES = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  const m = startMonitoring({
    service: 1, id: 'k',
    expires: EXPIRES,
    webhookUrl: hookUrl,
    warnPct: 5,           // 100/1000=10% > 5%，首轮即触发 warn
    intervalMinutes: 60,
    firstCheckDelayMs: 50,
    urls: { primary: mk(apiServer) }
  });

  await new Promise(r => setTimeout(r, 800));
  let st = m.status();
  assert.equal(st.traffic.level, 'warn', '首轮检查后 traffic=warn');
  assert.equal(st.traffic.usedGb, '0.00');
  assert.equal(st.expiry.level, 'imminent', `到期日 ${EXPIRES}（6 天后）→ imminent`);
  assert.equal(st.subscription.consecutiveFailures, 0);
  assert.ok(hooks.some(h => h.includes('流量')), '流量告警已推送到 webhook');
  assert.ok(hooks.some(h => h.includes('到期')), '到期告警已推送到 webhook');
  passed++; console.log('  ✓ 端到端：用量拉取 + 状态判定 + webhook 推送');

  // 恢复流程：用量降回低位 → 恢复通知
  hooks.length = 0;
  usageBody = JSON.stringify({ monthly_bw_limit_b: 1000, bw_counter_b: 10, bw_reset_day_of_month: 21 });
  await m.stop();
  const m2 = Object.assign(m, {});
  // 直接用新实例验证恢复（stop 后 interval 已清）
  const m3 = startMonitoring({
    service: 1, id: 'k', webhookUrl: hookUrl, warnPct: 5,
    firstCheckDelayMs: 50,
    urls: { primary: mk(apiServer) }
  });
  await new Promise(r => setTimeout(r, 800));
  assert.equal(m3.status().traffic.level, 'ok');
  passed++; console.log('  ✓ 恢复判定（用量回落 → ok）');

  // subscription-userinfo 标准头
  console.log('getUserinfoHeader 订阅头');
  assert.equal(m3.getUserinfoHeader(), 'upload=0; download=10; total=1000', '无到期配置时不带 expire');
  const expireHeader = m.getUserinfoHeader();
  assert.match(expireHeader, /^upload=0; download=\d+; total=\d+; expire=\d{10}$/, '带 expire 为 Unix 秒');
  const expireTs = Number(expireHeader.split('expire=')[1]);
  assert.equal(new Date(expireTs * 1000).toISOString().slice(0, 10), EXPIRES, 'expire 对应到期日当天');
  const fresh = startMonitoring({ service: 2, id: 'x', urls: { primary: mk(apiServer) } });
  assert.equal(fresh.getUserinfoHeader(), null, '尚无数据时返回 null');
  fresh.stop();
  passed++; console.log('  ✓ userinfo 头格式 / expire / 空数据');

  // noteSubResult 连续失败告警
  m3.noteSubResult(false); m3.noteSubResult(false);
  assert.equal(m3.status().subscription.consecutiveFailures, 2);
  m3.noteSubResult(false);
  assert.equal(m3.status().subscription.consecutiveFailures, 3);
  await new Promise(r => setTimeout(r, 300)); // webhook 异步送达
  assert.ok(hooks.some(h => h.includes('订阅源')), '连续失败 3 次已告警');
  m3.noteSubResult(true);
  assert.equal(m3.status().subscription.consecutiveFailures, 0, '恢复后计数清零');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(hooks.some(h => h.includes('恢复正常')), '恢复通知已推送');
  passed++; console.log('  ✓ 订阅源失败计数 / 告警 / 恢复');

  m3.stop();
  apiServer.close(); hookServer.close();

  console.log(`\n${passed} 项全部通过`);
})();
