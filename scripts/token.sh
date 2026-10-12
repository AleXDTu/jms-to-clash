#!/usr/bin/env bash
#
# jms-to-clash 访问令牌管理
#
# 用法:
#   ./scripts/token.sh list              列出云上现有 token（脱敏）
#   ./scripts/token.sh add [备注]        生成新 token 并启用
#   ./scripts/token.sh revoke <前缀>     按前缀吊销某个 token
#   ./scripts/token.sh rotate [备注]     一键轮换（加新 -> 你改客户端 -> 删旧）
#
# 本脚本不含任何令牌，可安全提交进 git。令牌只存在于云上的 tokens.txt。
# 服务器地址等部署信息在 scripts/deploy.env（gitignored）。

set -euo pipefail

# ==================== 配置 ====================
# 服务器信息从 scripts/deploy.env 读取（gitignored，不入库），格式：
#   DEPLOY_SSH="user@your-server-ip"
#   DEPLOY_DIR="/home/user/projects/jms-to-clash"
#   PUBLIC_URL="https://your-domain"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/deploy.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

: "${DEPLOY_SSH:?缺少配置：请创建 scripts/deploy.env 并设置 DEPLOY_SSH=\"user@服务器IP\"}"
: "${DEPLOY_DIR:?缺少配置：请在 scripts/deploy.env 设置 DEPLOY_DIR=\"部署目录\"}"
: "${PUBLIC_URL:?缺少配置：请在 scripts/deploy.env 设置 PUBLIC_URL=\"https://你的域名\"}"

HOST="$DEPLOY_SSH"
REMOTE_DIR="$DEPLOY_DIR"
BASE_URL="$PUBLIC_URL"

TOKEN_FILE="$REMOTE_DIR/tokens.txt"
BACKUP_FILE="$REMOTE_DIR/tokens.txt.bak"
RELOAD_WAIT=6   # 服务端 token 缓存 5s，等 6s 确保生效

# ==================== 工具 ====================
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { red "错误: $*" >&2; exit 1; }

# 直连，绕开本机可能设置的代理环境变量
curl_direct() {
  env -u http_proxy -u https_proxy -u all_proxy \
      -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      curl "$@"
}

# 拉取远端全部有效 token（排除注释和空行）
remote_tokens() {
  ssh -o BatchMode=yes "$HOST" \
    "grep -vE '^\s*(#|$)' '$TOKEN_FILE' 2>/dev/null | sed 's/[[:space:]]*$//'" || true
}

# 脱敏：8f3a9c2e…4b21
mask() {
  local t="$1"
  if [ ${#t} -le 14 ]; then echo "$t"; else
    printf '%s…%s\n' "${t:0:8}" "${t: -4}"
  fi
}

# 校验 token 能否正常取到订阅
verify_token() {
  local t="$1"
  curl_direct -s -o /dev/null -m 20 -w '%{http_code}' "$BASE_URL/convert?token=$t"
}

require_remote_file() {
  ssh -o BatchMode=yes "$HOST" "test -f '$TOKEN_FILE'" \
    || die "远端 $TOKEN_FILE 不存在。首次部署请先在云上创建该文件。"
}

# ==================== 子命令 ====================

cmd_list() {
  require_remote_file
  local tokens count
  tokens="$(remote_tokens)"
  count="$(printf '%s\n' "$tokens" | grep -c . || true)"

  if [ "$count" -eq 0 ]; then
    red "云上没有任何有效 token —— 服务当前会拒绝所有请求（fail closed）"
    return 1
  fi

  echo "云上共 $count 个有效 token:"
  local i=1
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    printf '  %d) %s\n' "$i" "$(mask "$t")"
    i=$((i + 1))
  done <<< "$tokens"

  echo
  echo "（仅显示首 8 位和末 4 位，避免完整令牌留在终端记录里）"
}

cmd_add() {
  require_remote_file
  local note="${1:-}"
  local new comment code
  new="$(openssl rand -hex 32)"
  comment="# 添加于 $(date '+%F %T')${note:+ - $note}"

  ssh -o BatchMode=yes "$HOST" \
    "printf '%s\n%s\n' '$comment' '$new' >> '$TOKEN_FILE' && chmod 600 '$TOKEN_FILE'"

  ylw "已写入，等待服务端热重载（${RELOAD_WAIT}s）..."
  sleep "$RELOAD_WAIT"

  code="$(verify_token "$new")"
  if [ "$code" != "200" ]; then
    die "新 token 验证失败（HTTP ${code}）。请检查服务状态：ssh $HOST 'pm2 logs jms-to-clash --lines 30'"
  fi

  grn "验证通过（HTTP 200）"
  echo
  echo "新订阅地址（填进 Clash 客户端）:"
  echo "  $BASE_URL/convert?token=$new"
}

# 按前缀吊销。核心安全约束：绝不允许把 token 删空
cmd_revoke() {
  local prefix="${1:-}"
  [ -n "$prefix" ] || die "用法: $0 revoke <token前缀>"
  [ ${#prefix} -ge 6 ] || die "前缀太短（至少 6 位），避免误删"

  require_remote_file
  local tokens total matched matched_count remain
  tokens="$(remote_tokens)"
  total="$(printf '%s\n' "$tokens" | grep -c . || true)"
  matched="$(printf '%s\n' "$tokens" | grep "^$prefix" || true)"
  matched_count="$(printf '%s\n' "$matched" | grep -c . || true)"

  [ "$matched_count" -gt 0 ] || die "没有匹配 '$prefix' 的 token"

  if [ "$matched_count" -gt 1 ]; then
    red "前缀 '$prefix' 匹配到 $matched_count 个 token，请用更长的前缀区分:"
    while IFS= read -r t; do [ -n "$t" ] && echo "  $(mask "$t")"; done <<< "$matched"
    exit 1
  fi

  remain=$((total - matched_count))
  if [ "$remain" -lt 1 ]; then
    red "拒绝执行：删除后将没有任何可用 token"
    red "服务是 fail closed 的，token 清空会导致订阅服务立刻全部瘫痪。"
    ylw "如需更换，请先 '$0 add' 添加新 token，再吊销旧的。"
    exit 1
  fi

  echo "将吊销: $(mask "$matched")"
  echo "吊销后剩余: $remain 个"

  # 备份 -> 删除令牌行 -> 落盘前再确认一次非空（双保险）-> 复查
  ssh -o BatchMode=yes "$HOST" "
    set -e
    cp '$TOKEN_FILE' '$BACKUP_FILE'
    grep -v '^$prefix' '$TOKEN_FILE' > '$TOKEN_FILE.new'
    if ! grep -vE '^[[:space:]]*(#|\$)' '$TOKEN_FILE.new' | grep -q .; then
      rm -f '$TOKEN_FILE.new'
      exit 9
    fi
    mv '$TOKEN_FILE.new' '$TOKEN_FILE'
    chmod 600 '$TOKEN_FILE'
  " || {
    local rc=$?
    [ "$rc" -eq 9 ] && die "远端复查发现删除后将无可用 token，已中止，文件未改动"
    die "远端操作失败（退出码 ${rc}），备份在 ${BACKUP_FILE}，文件未改动"
  }

  local after
  after="$(remote_tokens | grep -c . || true)"
  if [ "$after" -ne "$remain" ]; then
    red "复查异常：预期剩余 ${remain}，实际 ${after}。正在回滚..."
    ssh -o BatchMode=yes "$HOST" "cp '$BACKUP_FILE' '$TOKEN_FILE' && chmod 600 '$TOKEN_FILE'"
    die "已回滚到修改前状态"
  fi

  grn "已吊销，当前剩余 $after 个 token（备份: ${BACKUP_FILE}）"
}

cmd_rotate() {
  require_remote_file
  local note="${1:-}"
  local before new code

  before="$(remote_tokens | grep -c . || true)"
  [ "$before" -gt 0 ] || die "云上当前没有有效 token，请先用 add"

  # --- 1/4 添加新 token ---
  new="$(openssl rand -hex 32)"
  ssh -o BatchMode=yes "$HOST" \
    "printf '# 轮换于 %s%s\n%s\n' '$(date '+%F %T')' '${note:+ - $note}' '$new' >> '$TOKEN_FILE' && chmod 600 '$TOKEN_FILE'"
  grn "[1/4] 新 token 已添加，当前 $((before + 1)) 个同时有效"
  echo "      新订阅地址: $BASE_URL/convert?token=$new"

  # --- 2/4 验证 ---
  sleep "$RELOAD_WAIT"
  code="$(verify_token "$new")"
  [ "$code" = "200" ] || die "[2/4] 新 token 验证失败（HTTP ${code}），旧 token 未受影响，请排查后重试"
  grn "[2/4] 验证新 token: 200 OK"

  # --- 3/4 等你改完客户端 ---
  echo
  ylw "[3/4] 请现在把各设备的订阅地址改成上面那个，旧地址此刻仍然可用。"
  ylw "      改完后按回车继续删除旧 token；Ctrl-C 可随时中止（中止不影响任何现有 token）"
  read -r _

  # --- 4/4 删除除新 token 外的所有 ---
  local stamp
  stamp="# 轮换于 $(date '+%F %T')${note:+ - $note}"
  ssh -o BatchMode=yes "$HOST" "
    set -e
    cp '$TOKEN_FILE' '$BACKUP_FILE'
    printf '%s\n%s\n' '$stamp' '$new' > '$TOKEN_FILE.new'
    mv '$TOKEN_FILE.new' '$TOKEN_FILE'
    chmod 600 '$TOKEN_FILE'
  " || die "删除旧 token 失败，备份在 ${BACKUP_FILE}"

  sleep "$RELOAD_WAIT"
  code="$(verify_token "$new")"
  [ "$code" = "200" ] || {
    red "轮换后验证失败（HTTP ${code}），正在回滚..."
    ssh -o BatchMode=yes "$HOST" "cp '$BACKUP_FILE' '$TOKEN_FILE' && chmod 600 '$TOKEN_FILE'"
    die "已回滚"
  }

  grn "[4/4] 已删除 $before 个旧 token，当前仅新 token 有效"
}

# ==================== 入口 ====================
case "${1:-}" in
  list)   cmd_list ;;
  add)    cmd_add "${2:-}" ;;
  revoke) cmd_revoke "${2:-}" ;;
  rotate) cmd_rotate "${2:-}" ;;
  *)
    cat <<EOF
jms-to-clash 访问令牌管理

  $0 list              列出云上现有 token（脱敏显示）
  $0 add [备注]        生成新 token 并启用，打印完整订阅地址
  $0 revoke <前缀>     按前缀吊销某个 token（不允许删到一个不剩）
  $0 rotate [备注]     一键轮换：加新 -> 你改客户端 -> 回车后删旧

令牌只存在于云上 ${TOKEN_FILE}，本脚本不含任何令牌。
EOF
    exit 1
    ;;
esac
