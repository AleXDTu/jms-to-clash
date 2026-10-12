# jms-to-clash

JustMySocks 订阅转 Clash 的自托管小工具。跑在你自己的服务器上，把 JMS 的原始订阅
转成 Clash (mihomo) 配置，Clash 客户端直接订阅即可，还能在订阅卡片上看流量剩余和到期日。

```bash
# 客户端里填的订阅长这样
https://your-domain/convert?token=<令牌>
```

## ⚠️ 这是 JMS 专用工具

解析逻辑按 JustMySocks 的实际格式编写：

- 订阅内容：`getsub.php` 返回的 base64 节点列表
- 流量/到期：复用订阅链接同款 `service` + `id` 凭据，调 JMS 官方用量接口 `getbwcounter.php`

**其他机场的订阅格式大概率不一样，不保证能用**，也不打算做成通用转换器
（通用需求请看 [subconverter](https://github.com/tindy2013/subconverter)）。

## 为什么自托管

JMS 官方面板/订阅域名在国内经常被墙，而公共订阅转换服务要经过别人的服务器（你的订阅
凭据会暴露给它）。这个小工具部署在自己的云上之后：

- Clash 客户端直连你自己的服务器拉订阅，**国内可达**
- 转换在你自己的机器上完成，**订阅凭据不经过任何第三方**

## 功能

- **Clash 内直接看流量/到期** — 响应带标准 `subscription-userinfo` 头，
  Clash Verge / FlClash 刷新订阅即显示「已用 / 总量 / 到期日」
- **到期 / 流量告警** — 轮询 JMS 官方用量 API：流量 ≥80% 告警、续费日前 14 天开始提醒；
  年付到期日支持 `MM-DD` 写法每年自动顺延；可推送到 Bark / Server酱 / PushPlus
- **令牌鉴权，fail closed** — 订阅地址必须带有效 token；token 文件读不到或为空时拒绝所有
  请求，绝不退化成裸奔；校验用 `crypto.timingSafeEqual`，失败一律返回 404 不暴露端点
- **多令牌 + 无感轮换** — token 存 `tokens.txt` 改完即生效；`rotate` 加新→改客户端→删旧，
  全程不断流
- **主备订阅 + 缓存兜底** — JMS 主备订阅地址自动切换；5 分钟缓存；上游全挂时回退过期
  缓存而不是直接报错
- **协议** — SS(aes-256-gcm)、VLESS/REALITY（JMS 目前 s3/s4/s5/s801 的形态）；
  另带 vmess / trojan / hysteria2 解析器备用
- **节点过滤重命名** — `include` / `exclude` / `prefix` / `suffix` 查询参数

## 快速开始

```bash
pnpm install

# 必需凭据（在 JMS 后台「Your Subscription」页面可以看到）
export JMS_SERVICE=<你的 service 编号>
export JMS_ID=<你的 id>
export TOKEN_FILE=./tokens.txt
echo "$(openssl rand -hex 32)" > tokens.txt

pnpm start
curl "http://127.0.0.1:3000/convert?token=$(tail -1 tokens.txt)"
```

缺少环境变量或 token 文件为空时服务会直接退出，不带病启动。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `JMS_SERVICE` | ✅ | JMS service 编号 |
| `JMS_ID` | ✅ | JMS 订阅 id |
| `TOKEN_FILE` | ✅ | token 文件路径，一行一个，`#` 注释 |
| `JMS_EXPIRES` | ❌ | 续费日：`2027-08-21` 或 `08-21`（每年循环，年付推荐），用于到期倒计时和订阅卡片的到期显示 |
| `ALERT_WEBHOOK_URL` | ❌ | 告警推送地址，见下 |
| `USAGE_CHECK_MINUTES` | ❌ | 用量轮询间隔，默认 60 分钟 |
| `PORT` | ❌ | 监听端口，默认 3000（只绑 127.0.0.1） |

### 告警推送格式

URL 含 `{title}` / `{body}` 占位符则 GET（自动 URL 编码），否则 POST JSON `{"title":..., "body":...}`：

```
# Bark（iOS）
ALERT_WEBHOOK_URL='https://api.day.app/<key>/{title}/{body}'

# Server酱（微信）
ALERT_WEBHOOK_URL='https://sctapi.ftqq.com/<key>.send?title={title}&desp={body}'

# 自建接收端 / ntfy 网关：直接给 URL，走 POST JSON
ALERT_WEBHOOK_URL='https://your-host/api/alert'
```

## API

### `GET /convert`

| 参数 | 必填 | 说明 |
|------|------|------|
| `token` | ✅ | 访问令牌，校验失败返回 404 |
| `include` / `exclude` | ❌ | 按节点名关键词保留/排除（逗号分隔） |
| `prefix` / `suffix` | ❌ | 节点名称加前缀/后缀 |
| `refresh` | ❌ | `=1` 强制刷新缓存 |

响应头：

```
subscription-userinfo: upload=0; download=1073741824; total=1000000000000; expire=1818892799
profile-update-interval: 24
```

### `GET /health`

健康检查 + 用量/到期状态，不需要 token，不含敏感信息：

```json
{
  "status": "ok",
  "version": "2.3.0",
  "jms": {
    "traffic": { "level": "ok", "pct": "0.1", "usedGb": "1.07", "limitGb": "931.32", "resetDay": 21 },
    "expiry":   { "level": "ok", "date": "2027-08-21", "daysLeft": 362, "recurring": true },
    "usageApi": { "ok": true },
    "subscription": { "consecutiveFailures": 0 }
  }
}
```

其余任何路径一律 404。

## 测试

```bash
pnpm test   # 28 项：阈值判定/告警去重升级恢复/本地 mock 端到端，不依赖外网
```

## 部署

生产部署（云服务器 + nginx 反代 + pm2 + 令牌管理脚本）见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 安全设计

| 措施 | 说明 |
|---|---|
| 无外部可控 URL | 只请求写死的主备订阅地址和 JMS 官方用量 API，杜绝 SSRF |
| 凭据不入源码 | `JMS_SERVICE`/`JMS_ID` 走环境变量，token 走独立文件，均已 gitignore |
| 失败返回 404 | 而非 401/403，不向扫描器暴露端点存在 |
| 日志不含凭据 | 应用日志不打印订阅地址；nginx 用 `$uri` 记录，token 不落盘 |
| 限流 | nginx `limit_req` 10 次/分钟，超限返回 404 |

## 免责声明

仅供个人学习与自用，请遵守当地法律法规。本项目与 JustMySocks 官方无任何关联。

## License

[MIT](LICENSE)
