# jms-to-clash 部署运维文档

> 本文件是通用部署指南，占位符请替换为你自己的值。
> 实际部署信息（服务器 IP / 域名 / 用户名）只保存在本地的
> `docs/DEPLOY.local.md` 与 `scripts/deploy.env`（均已 gitignore，不入库）。
> 接口文档见上级 `README.md`。

---

## 服务器信息

| 项目 | 值 |
|---|---|
| 公网 IP | `<your-server-ip>` |
| 登录用户 | `deploy`（普通用户，有免密 sudo）|
| SSH | `ssh deploy@<your-server-ip>`（仅公钥，禁密码/禁 root）|

## 部署位置

| 项目 | 路径 |
|---|---|
| 项目目录 | `/home/deploy/projects/jms-to-clash/` |
| 进程管理 | **pm2**（进程名 `jms-to-clash`，由 `ecosystem.config.js` 启动）|
| Node 版本 | v24.x（nvm 管理，路径 `/home/deploy/.nvm/...`）|

## 运行架构

```
Clash 客户端
    │
    │  https://jms.example.com/convert?token=<令牌>
    ▼
Nginx (443, HTTPS)  ──→  限流 10r/m + 日志脱敏
    │
    ▼
Nginx (127.0.0.1:8080)  ──→  Node app (127.0.0.1:3000, pm2 托管)
                                  │
                                  ├──→  JMS 订阅源（主备，jmssub.net / jjsubmarines.com）
                                  └──→  JMS 用量 API（justmysocks6.net / justmysocks.net，
                                        同 service+id 凭据，每小时轮询，到期/流量告警）
```

- **三层反代**：HTTPS 域名 → 内网 nginx(8080) → node(3000)
- 所有应用端口仅监听 `127.0.0.1`，公网仅通过 443 访问

## 关键配置文件（云上）

| 文件 | 作用 | 是否敏感 |
|---|---|---|
| `~/projects/jms-to-clash/src/index.js` | 应用源码 | |
| `~/projects/jms-to-clash/ecosystem.config.js` | pm2 配置，含 `JMS_SERVICE` / `JMS_ID` | **是**，600，gitignore |
| `~/projects/jms-to-clash/tokens.txt` | 访问令牌，一行一个 | **是**，600，gitignore |
| `/etc/nginx/conf.d/00-jms-limits.conf` | 日志脱敏格式 + 限流区定义（http 块内） | |
| `/etc/nginx/conf.d/jms.example.com.conf` | HTTPS 反代到 8080（certbot 管理 SSL） | |
| `/etc/nginx/conf.d/jms.conf` | 内层反代 8080 → 3000 | |
| `/var/log/nginx/jms.access.log` | 本服务专用日志（不含 query string） | |

## 订阅地址

```
https://jms.example.com/convert?token=<令牌>
```

- 必须带有效 token，否则返回 404
- 默认 5 分钟缓存，强制刷新加 `&refresh=1`
- 有效路径只有 `/convert` 和 `/health`，其余一律 404

## 到期 / 流量告警（v2.2+）

流量监控（用量 API 轮询 + 超阈值告警 + 订阅源连续失败兜底告警）随服务自动生效，
用现有 `JMS_SERVICE` / `JMS_ID` 凭据，无需额外配置。

两项可选增强，配置在**云上**的 `ecosystem.config.js` 的 `env` 里（该文件含密钥，不入库）：

| 变量 | 说明 |
|---|---|
| `JMS_EXPIRES` | 续费日 `YYYY-MM-DD`，或 `MM-DD` 每年循环（年付推荐），到期倒计时告警 |
| `ALERT_WEBHOOK_URL` | 推送地址（Bark/Server酱/PushPlus 模板或 POST JSON 接收端），格式见 README |
| `USAGE_CHECK_MINUTES` | 轮询间隔，默认 60 |

改完必须 `pm2 delete jms-to-clash && pm2 start ecosystem.config.js && pm2 save`
（`pm2 restart` 不重载 env）。

用量 API 走面板镜像域名（`justmysocks6.net` 主 / `justmysocks.net` 备），国内服务器直连
可达；若 JMS 更换镜像域名，改 `src/monitor.js` 顶部 `DEFAULT_USAGE_URLS` 后重新部署。

---

## 部署流程

### 1. 本地开发

```bash
pnpm install

export JMS_SERVICE=<service 编号>
export JMS_ID=<id>
export TOKEN_FILE=./tokens.txt
echo "$(openssl rand -hex 32)" > tokens.txt   # 本地测试用，勿提交

pnpm start
curl "http://127.0.0.1:3000/convert?token=$(tail -1 tokens.txt)"
curl http://127.0.0.1:3000/health
```

### 2. 推送到云上

```bash
# 必须排除敏感/本地文件，否则会覆盖掉云上的真实配置
rsync -az -e ssh \
  --exclude='node_modules' \
  --exclude='tokens.txt' \
  --exclude='tokens.txt.bak' \
  --exclude='ecosystem.config.js' \
  --exclude='scripts/deploy.env' \
  --exclude='docs/*.local.md' \
  --exclude='.git' \
  --exclude='*.bak.*' \
  --exclude='.DS_Store' \
  ./ deploy@<your-server-ip>:~/projects/jms-to-clash/

# 只改了源码：重启即可
ssh deploy@<your-server-ip> 'export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH; pm2 restart jms-to-clash'
```

> ⚠️ 改了 `ecosystem.config.js` 里的环境变量时，`pm2 restart` **不会**重新加载 env，
> 必须 `pm2 delete jms-to-clash && pm2 start ecosystem.config.js && pm2 save`。
> 改 `tokens.txt` 则完全不用重启，5 秒内自动生效。

### 3. 首次部署（新服务器）

```bash
ssh deploy@<your-server-ip>
cd ~/projects/jms-to-clash

cp ecosystem.config.example.js ecosystem.config.js
vi ecosystem.config.js          # 填 JMS_SERVICE / JMS_ID
chmod 600 ecosystem.config.js

printf '# 首次启用\n%s\n' "$(openssl rand -hex 32)" > tokens.txt
chmod 600 tokens.txt

pnpm install
pm2 start ecosystem.config.js && pm2 save
```

本地另需创建 `scripts/deploy.env`（供 `scripts/token.sh` 使用）：

```bash
cat > scripts/deploy.env <<'EOF'
DEPLOY_SSH="deploy@<your-server-ip>"
DEPLOY_DIR="/home/deploy/projects/jms-to-clash"
PUBLIC_URL="https://jms.example.com"
EOF
```

### 4. 验证

```bash
T='<令牌>'
B=https://jms.example.com

curl -s -o /dev/null -w '%{http_code}\n' "$B/convert"           # 404
curl -s -o /dev/null -w '%{http_code}\n' "$B/convert?token=$T"  # 200
curl -s -o /dev/null -w '%{http_code}\n' "$B/health"            # 200

# /health 里的 jms 字段应能看到真实用量（traffic.source 有值、pct 正常）
curl -s "$B/health" | python3 -m json.tool

# /convert 响应头应含 subscription-userinfo（Clash 刷新订阅即显示流量剩余）
curl -sSI "$B/convert?token=$T" | grep -i subscription-userinfo

ssh deploy@<your-server-ip> 'sudo grep -c "token=" /var/log/nginx/jms.access.log'   # 0
ssh deploy@<your-server-ip> 'export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH; pm2 logs jms-to-clash --lines 30'
```

---

## 令牌管理

日常用本地脚本，不用手工 SSH（先按上文创建 `scripts/deploy.env`）：

```bash
./scripts/token.sh list              # 列出（脱敏）
./scripts/token.sh add [备注]        # 加一个，打印完整订阅地址
./scripts/token.sh revoke <前缀>     # 吊销某个
./scripts/token.sh rotate [备注]     # 一键轮换
```

**轮换为什么不会断**：支持多令牌并存，`rotate` 会先加新的（此时新旧都有效），
等你把各设备的订阅地址改完、按回车后，才删掉旧的。全程不重启服务。

**紧急吊销**（令牌已泄露）：

```bash
./scripts/token.sh add "应急"        # 先加新的
./scripts/token.sh revoke <旧前缀>   # 再删旧的
```

> ⚠️ 服务是 fail closed 的，`tokens.txt` 为空会导致订阅服务全部瘫痪。
> 脚本内置防删空检查，手工编辑该文件时务必留意。

## 常用运维命令

```bash
ssh deploy@<your-server-ip>
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH

pm2 list                    # 查看进程
pm2 restart jms-to-clash    # 重启（不重载 env）
pm2 logs jms-to-clash       # 实时日志
pm2 logs jms-to-clash --err # 只看错误

sudo nginx -t                            # 改 nginx 后必须先测语法
sudo systemctl reload nginx              # 平滑重载
sudo tail -f /var/log/nginx/jms.access.log
```

## pm2 持久化提醒

pm2 默认重启服务器后不会自动拉起。若尚未配置开机自启：

```bash
pm2 save
pm2 startup                 # 按提示执行输出的 sudo 命令
```
