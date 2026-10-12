const express = require('express');
const axios = require('axios');
const YAML = require('yaml');
const fs = require('fs');
const crypto = require('crypto');
const { startMonitoring } = require('./monitor');

const app = express();
const PORT = process.env.PORT || 3000;

// 订阅凭据从环境变量读，不写进源码（仓库泄露不等于订阅泄露）
const JMS_SERVICE = process.env.JMS_SERVICE;
const JMS_ID = process.env.JMS_ID;
const TOKEN_FILE = process.env.TOKEN_FILE || './tokens.txt';

// 缺配置直接退出，避免带病启动导致裸奔
if (!JMS_SERVICE || !JMS_ID) {
  console.error('[FATAL] 缺少环境变量 JMS_SERVICE / JMS_ID');
  process.exit(1);
}

// 主备订阅地址
const SUBSCRIPTION_URLS = {
  primary: `https://jmssub.net/members/getsub.php?service=${JMS_SERVICE}&id=${JMS_ID}`,
  fallback: `https://jjsubmarines.com/members/getsub.php?service=${JMS_SERVICE}&id=${JMS_ID}`
};

// 缓存配置
const CACHE_TTL = 5 * 60 * 1000; // 5分钟
let cache = {
  data: null,
  timestamp: 0,
  source: null
};

// ==================== 访问令牌 ====================

// token 存独立文件，一行一个，# 开头为注释。改文件即生效，无需重启
let tokenCache = { list: [], mtime: 0, checked: 0 };

function loadTokens() {
  const now = Date.now();
  if (now - tokenCache.checked < 5000) return tokenCache.list;
  tokenCache.checked = now;

  try {
    const st = fs.statSync(TOKEN_FILE);
    if (st.mtimeMs === tokenCache.mtime) return tokenCache.list;

    const list = fs.readFileSync(TOKEN_FILE, 'utf-8')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'));

    tokenCache = { list, mtime: st.mtimeMs, checked: now };
    console.log(`[TOKEN] 已加载 ${list.length} 个 token`);
    return list;
  } catch (e) {
    // fail closed：读不到就一个都不放行，绝不退化成不校验
    console.error('[TOKEN] 读取失败，拒绝所有请求:', e.message);
    tokenCache = { list: [], mtime: 0, checked: now };
    return [];
  }
}

// 校验失败一律返回 404，不暴露端点存在
function checkToken(req, res, next) {
  const input = Buffer.from(String(req.query.token || ''));
  const ok = loadTokens().some(t => {
    const valid = Buffer.from(t);
    // 长度不等时 timingSafeEqual 会抛异常，必须先短路
    return input.length === valid.length && crypto.timingSafeEqual(input, valid);
  });

  if (!ok) return res.status(404).type('text/plain').send('Not Found');
  next();
}

if (loadTokens().length === 0) {
  console.error(`[FATAL] ${TOKEN_FILE} 不存在或为空，没有任何可用 token`);
  process.exit(1);
}

// ==================== 到期 / 流量监控 ====================

const monitor = startMonitoring({
  service: JMS_SERVICE,
  id: JMS_ID,
  expires: process.env.JMS_EXPIRES,          // 可选：续费日 YYYY-MM-DD，到期倒计时告警
  webhookUrl: process.env.ALERT_WEBHOOK_URL, // 可选：告警推送，含 {title}/{body} 占位符则 GET，否则 POST JSON
  intervalMinutes: process.env.USAGE_CHECK_MINUTES
});

// ==================== 协议解析器 ====================

// 解析 VMess 链接
function parseVmess(link) {
  try {
    const base64 = link.replace('vmess://', '');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    const config = JSON.parse(json);
    
    const proxy = {
      name: config.ps || config.add,
      type: 'vmess',
      server: config.add,
      port: parseInt(config.port, 10) || 443,
      uuid: config.id,
      alterId: parseInt(config.aid || 0, 10),
      cipher: config.scy || 'auto',
      udp: true,
      network: config.net || 'tcp'
    };
    
    // WebSocket 配置
    if (config.net === 'ws') {
      proxy['ws-opts'] = {
        path: config.path || '/',
        headers: { Host: config.host || config.add }
      };
    }
    
    // gRPC 配置
    if (config.net === 'grpc') {
      proxy['grpc-opts'] = {
        'grpc-service-name': config.path || ''
      };
    }
    
    // TLS 配置
    if (config.tls === 'tls') {
      proxy.tls = true;
      proxy['skip-cert-verify'] = true;
      // mihomo 里 vmess/vless 的 SNI 字段是 servername，不是 sni
      if (config.sni) proxy.servername = config.sni;
    }
    
    return proxy;
  } catch (e) {
    console.error('[VMESS] 解析失败:', e.message);
    return null;
  }
}

// 解析 VLESS 链接
function parseVless(link) {
  // vless://uuid@server:port?encryption=none&security=tls&sni=xxx&type=ws&path=/xxx#name
  try {
    const url = new URL(link.replace('vless://', 'https://'));
    
    const proxy = {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: 'vless',
      server: url.hostname,
      port: parseInt(url.port, 10) || 443,
      uuid: url.username,
      udp: true,
      tls: false
    };
    
    const params = url.searchParams;
    
    // 流控
    proxy.flow = params.get('flow') || '';
    
    // TLS 配置
    const security = params.get('security') || 'none';
    if (security === 'tls' || security === 'reality') {
      proxy.tls = true;
      proxy['skip-cert-verify'] = true;
      // mihomo 里 vmess/vless 的 SNI 字段是 servername，不是 sni
      if (params.get('sni')) proxy.servername = params.get('sni');
      
      // Reality 配置
      if (security === 'reality') {
        proxy['reality-opts'] = {
          'public-key': params.get('pbk') || '',
          'short-id': params.get('sid') || ''
        };
        if (params.get('fp')) proxy['client-fingerprint'] = params.get('fp');
      }
    }
    
    // 传输层配置
    const type = params.get('type') || 'tcp';
    proxy.network = type;
    
    if (type === 'ws') {
      proxy['ws-opts'] = {
        path: params.get('path') || '/',
        headers: { Host: params.get('host') || url.hostname }
      };
    } else if (type === 'grpc') {
      proxy['grpc-opts'] = {
        'grpc-service-name': params.get('serviceName') || params.get('path') || ''
      };
    } else if (type === 'h2') {
      proxy['h2-opts'] = {
        host: [params.get('host') || url.hostname],
        path: params.get('path') || '/'
      };
    }
    
    return proxy;
  } catch (e) {
    console.error('[VLESS] 解析失败:', e.message);
    return null;
  }
}

// 解析 Trojan 链接
function parseTrojan(link) {
  try {
    const url = new URL(link.replace('trojan://', 'https://'));
    
    const proxy = {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: 'trojan',
      server: url.hostname,
      port: parseInt(url.port, 10) || 443,
      password: url.username,
      udp: true,
      'skip-cert-verify': true,
      sni: url.searchParams.get('sni') || url.hostname
    };
    
    // WebSocket 配置
    const type = url.searchParams.get('type');
    if (type === 'ws') {
      proxy.network = 'ws';
      proxy['ws-opts'] = {
        path: url.searchParams.get('path') || '/',
        headers: { Host: url.searchParams.get('host') || url.hostname }
      };
    }
    
    // gRPC 配置
    if (type === 'grpc') {
      proxy.network = 'grpc';
      proxy['grpc-opts'] = {
        'grpc-service-name': url.searchParams.get('serviceName') || ''
      };
    }
    
    return proxy;
  } catch (e) {
    console.error('[TROJAN] 解析失败:', e.message);
    return null;
  }
}

// 解析 Shadowsocks 链接
function parseSS(link) {
  try {
    // 移除 ss:// 前缀
    let content = link.replace('ss://', '');
    
    // 分离备注名
    let name = '';
    if (content.includes('#')) {
      const parts = content.split('#');
      content = parts[0];
      name = decodeURIComponent(parts[1]);
    }
    
    // 尝试 SIP002 格式: base64(method:password@server:port)
    // 或者旧格式: base64(method:password)@server:port
    
    let method, password, server, port;
    
    // 检查是否是 SIP002 格式（没有 @ 在 base64 外面）
    if (!content.includes('@') || content.match(/^[A-Za-z0-9+/=]+$/)) {
      // 纯 base64，解码后格式为 method:password@server:port
      const decoded = Buffer.from(content, 'base64').toString('utf-8');
      const match = decoded.match(/^(.+?):(.+)@(.+):(\d+)$/);
      if (match) {
        method = match[1];
        password = match[2];
        server = match[3];
        port = match[4];
      } else {
        throw new Error('Invalid SS format after decode');
      }
    } else {
      // 旧格式: base64(method:password)@server:port
      const atIndex = content.lastIndexOf('@');
      const userInfo = content.substring(0, atIndex);
      const hostPort = content.substring(atIndex + 1);
      
      const decoded = Buffer.from(userInfo, 'base64').toString('utf-8');
      const colonIndex = decoded.indexOf(':');
      method = decoded.substring(0, colonIndex);
      password = decoded.substring(colonIndex + 1);
      
      const hostParts = hostPort.split(':');
      server = hostParts[0];
      port = hostParts[1];
    }
    
    return {
      name: name || server,
      type: 'ss',
      server: server,
      port: parseInt(port, 10) || 443,
      cipher: method,
      password: password,
      udp: true
    };
  } catch (e) {
    console.error('[SS] 解析失败:', e.message, link);
    return null;
  }
}

// 解析 Hysteria2 链接
function parseHysteria2(link) {
  // hysteria2://password@server:port?sni=xxx#name
  try {
    const url = new URL(link.replace('hysteria2://', 'https://').replace('hy2://', 'https://'));
    
    return {
      name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
      type: 'hysteria2',
      server: url.hostname,
      port: parseInt(url.port, 10) || 443,
      password: url.username,
      'skip-cert-verify': true,
      sni: url.searchParams.get('sni') || url.hostname
    };
  } catch (e) {
    console.error('[HYSTERIA2] 解析失败:', e.message);
    return null;
  }
}

// 解析单个节点
function parseNode(line) {
  line = line.trim();
  if (!line) return null;
  
  if (line.startsWith('vmess://')) return parseVmess(line);
  if (line.startsWith('vless://')) return parseVless(line);
  if (line.startsWith('trojan://')) return parseTrojan(line);
  if (line.startsWith('ss://')) return parseSS(line);
  if (line.startsWith('hysteria2://') || line.startsWith('hy2://')) return parseHysteria2(line);
  
  return null;
}

// ==================== 订阅解析 ====================

function parseSubscription(content) {
  try {
    // 尝试 base64 解码
    let decoded;
    try {
      decoded = Buffer.from(content.trim(), 'base64').toString('utf-8');
      // 检查解码后是否像链接
      if (!decoded.includes('://')) {
        decoded = content;
      }
    } catch {
      decoded = content;
    }
    
    const lines = decoded.split('\n');
    const proxies = [];
    
    for (const line of lines) {
      const proxy = parseNode(line);
      if (proxy) proxies.push(proxy);
    }
    
    return proxies;
  } catch (e) {
    console.error('[SUB] 解析订阅失败:', e.message);
    return [];
  }
}

// 获取订阅（支持主备切换和缓存）
async function fetchSubscription(forceRefresh = false) {
  const now = Date.now();
  
  // 检查缓存
  if (!forceRefresh && cache.data && (now - cache.timestamp) < CACHE_TTL) {
    console.log('[CACHE] 使用缓存数据');
    return { proxies: cache.data, source: cache.source, cached: true };
  }
  
  // 尝试主订阅
  const urls = [
    { url: SUBSCRIPTION_URLS.primary, name: 'primary' },
    { url: SUBSCRIPTION_URLS.fallback, name: 'fallback' }
  ];
  
  for (const { url, name } of urls) {
    try {
      // 只打印来源名，不打印完整地址（含 service/id 密钥）
      console.log(`[SUB] 尝试 ${name} 订阅`);
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'ClashForWindows/0.20.39'
        }
      });
      
      const proxies = parseSubscription(response.data);
      
      if (proxies.length > 0) {
        console.log(`[SUB] ${name} 订阅成功，解析到 ${proxies.length} 个节点`);
        monitor.noteSubResult(true);

        // 更新缓存
        cache = {
          data: proxies,
          timestamp: now,
          source: name
        };
        
        return { proxies, source: name, cached: false };
      }
    } catch (e) {
      console.error(`[SUB] ${name} 订阅失败:`, e.message);
    }
  }
  
  // 主备都失败：可能是账号被终止，回填给监控告警
  monitor.noteSubResult(false);

  // 所有订阅都失败，使用过期缓存
  if (cache.data) {
    console.log('[CACHE] 使用过期缓存');
    return { proxies: cache.data, source: cache.source + ' (stale)', cached: true, stale: true };
  }
  
  throw new Error('所有订阅源都不可用');
}

// ==================== 节点处理 ====================

// 过滤节点
function filterProxies(proxies, include, exclude) {
  return proxies.filter(proxy => {
    const name = proxy.name.toLowerCase();
    
    // 排除关键词
    if (exclude) {
      const excludeWords = exclude.split(',').map(w => w.trim().toLowerCase());
      if (excludeWords.some(word => name.includes(word))) {
        return false;
      }
    }
    
    // 包含关键词
    if (include) {
      const includeWords = include.split(',').map(w => w.trim().toLowerCase());
      if (!includeWords.some(word => name.includes(word))) {
        return false;
      }
    }
    
    return true;
  });
}

// 重命名节点
function renameProxies(proxies, prefix, suffix) {
  return proxies.map(proxy => {
    let name = proxy.name;
    if (prefix) name = prefix + name;
    if (suffix) name = name + suffix;
    proxy.name = name;
    return proxy;
  });
}

// ==================== Clash 配置生成 ====================

// Loyalsoldier 规则集配置
const RULE_PROVIDERS = {
  reject: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt',
    path: './ruleset/reject.yaml',
    interval: 86400
  },
  icloud: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/icloud.txt',
    path: './ruleset/icloud.yaml',
    interval: 86400
  },
  apple: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/apple.txt',
    path: './ruleset/apple.yaml',
    interval: 86400
  },
  google: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/google.txt',
    path: './ruleset/google.yaml',
    interval: 86400
  },
  proxy: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt',
    path: './ruleset/proxy.yaml',
    interval: 86400
  },
  direct: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt',
    path: './ruleset/direct.yaml',
    interval: 86400
  },
  private: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt',
    path: './ruleset/private.yaml',
    interval: 86400
  },
  gfw: {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt',
    path: './ruleset/gfw.yaml',
    interval: 86400
  },
  'tld-not-cn': {
    type: 'http',
    behavior: 'domain',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/tld-not-cn.txt',
    path: './ruleset/tld-not-cn.yaml',
    interval: 86400
  },
  telegramcidr: {
    type: 'http',
    behavior: 'ipcidr',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/telegramcidr.txt',
    path: './ruleset/telegramcidr.yaml',
    interval: 86400
  },
  cncidr: {
    type: 'http',
    behavior: 'ipcidr',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/cncidr.txt',
    path: './ruleset/cncidr.yaml',
    interval: 86400
  },
  lancidr: {
    type: 'http',
    behavior: 'ipcidr',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/lancidr.txt',
    path: './ruleset/lancidr.yaml',
    interval: 86400
  },
  applications: {
    type: 'http',
    behavior: 'classical',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/applications.txt',
    path: './ruleset/applications.yaml',
    interval: 86400
  }
};

// 规则列表（白名单模式）
const RULES = [
  'RULE-SET,applications,DIRECT',
  'DOMAIN,clash.razord.top,DIRECT',
  'DOMAIN,yacd.haishan.me,DIRECT',
  'RULE-SET,private,DIRECT',
  'RULE-SET,reject,REJECT',
  'RULE-SET,icloud,🚀 节点选择',
  'RULE-SET,apple,🚀 节点选择',
  'RULE-SET,google,🚀 节点选择',
  'RULE-SET,proxy,🚀 节点选择',
  'RULE-SET,direct,DIRECT',
  'RULE-SET,lancidr,DIRECT',
  'RULE-SET,cncidr,DIRECT',
  'RULE-SET,telegramcidr,🚀 节点选择',
  'GEOIP,LAN,DIRECT',
  'GEOIP,CN,DIRECT',
  'MATCH,🚀 节点选择'
];

function generateClashConfig(proxies) {
  const proxyNames = proxies.map(p => p.name);

  // 基础配置
  const baseConfig = {
    'mixed-port': 7890,
    'allow-lan': true,
    mode: 'rule',
    'log-level': 'info',
    proxies: proxies,
    'proxy-groups': [
      {
        name: '🚀 节点选择',
        type: 'select',
        proxies: ['♻️ 自动选择', '🔰 手动选择', ...proxyNames]
      },
      {
        name: '♻️ 自动选择',
        type: 'url-test',
        proxies: proxyNames,
        url: 'http://www.gstatic.com/generate_204',
        interval: 300
      },
      {
        name: '🔰 手动选择',
        type: 'select',
        proxies: proxyNames
      }
    ],
    'rule-providers': RULE_PROVIDERS,
    rules: RULES
  };

  return baseConfig;
}

// ==================== API 路由 ====================

// 转换订阅（只走写死的主备订阅，不接受任何外部 URL）
app.get('/convert', checkToken, async (req, res) => {
  const { include, exclude, prefix, suffix, refresh } = req.query;

  // 用量数据若已过期，顺手异步刷新（不影响本次响应速度）
  monitor.refreshIfStale();

  try {
    const result = await fetchSubscription(refresh === '1');
    let proxies = result.proxies;

    if (proxies.length === 0) {
      return res.status(400).json({ error: '未解析到有效节点' });
    }

    // 过滤
    if (include || exclude) {
      proxies = filterProxies(proxies, include, exclude);
    }

    // 重命名
    if (prefix || suffix) {
      proxies = renameProxies(proxies, prefix, suffix);
    }

    if (proxies.length === 0) {
      return res.status(400).json({ error: '过滤后无剩余节点' });
    }

    console.log(`[INFO] 返回 ${proxies.length} 个节点 (来源: ${result.source})`);

    const clashConfig = generateClashConfig(proxies);
    const yaml = YAML.stringify(clashConfig);

    // 添加来源信息作为注释
    const header = `# JMS to Clash v2.2\n# 来源: ${result.source}\n# 节点数: ${proxies.length}\n# 缓存: ${result.cached ? '是' : '否'}\n\n`;

    // Clash 客户端标准头：订阅卡片显示已用流量/总量，配置了 JMS_EXPIRES 时还显示到期日
    const userinfo = monitor.getUserinfoHeader();
    if (userinfo) res.set('subscription-userinfo', userinfo);
    res.set('profile-update-interval', '24');

    res.type('text/yaml').send(header + yaml);
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    res.status(500).json({ error: '订阅获取失败' });
  }
});

// 健康检查（不需要 token，留给监控探活；jms 字段为用量/到期状态，不含任何凭据）
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.2.0',
    jms: monitor.status()
  });
});

// 其余路径一律 404，不泄露任何信息
app.use((req, res) => res.status(404).type('text/plain').send('Not Found'));

// 启动服务
app.listen(PORT, "127.0.0.1", () => {
  console.log('='.repeat(50));
  console.log('JMS to Clash 服务已启动 v2.2');
  console.log('='.repeat(50));
  console.log(`端口: ${PORT}`);
  console.log('');
  console.log('API 接口:');
  console.log('  GET /convert?token=<令牌>   订阅转换（必须带 token）');
  console.log('  GET /health                健康检查');
  console.log('');
  console.log('可选参数:');
  console.log('  include  - 包含关键词（逗号分隔）');
  console.log('  exclude  - 排除关键词（逗号分隔）');
  console.log('  prefix   - 节点名称前缀');
  console.log('  suffix   - 节点名称后缀');
  console.log('  refresh  - =1 强制刷新缓存');
  console.log('');
  console.log(`令牌文件: ${TOKEN_FILE}（已加载 ${loadTokens().length} 个，改文件即生效）`);
  console.log(`监控: 每 ${process.env.USAGE_CHECK_MINUTES || 60} 分钟查用量；到期告警 ${process.env.JMS_EXPIRES ? `已启用（${process.env.JMS_EXPIRES}）` : '未配置 JMS_EXPIRES'}；推送 ${process.env.ALERT_WEBHOOK_URL ? '已配置' : '未配置 ALERT_WEBHOOK_URL（仅记日志）'}`);
  console.log('='.repeat(50));
});
