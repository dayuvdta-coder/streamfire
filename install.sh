#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_URL="${REPO_URL:-https://github.com/broman0x/streamfire.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/streamfire}"
SERVICE_NAME="${SERVICE_NAME:-streamfire}"
APP_USER="${APP_USER:-streamfire}"
INSTALL_CHROMIUM="${INSTALL_CHROMIUM:-0}"

log_info() {
  echo -e "${GREEN}$1${NC}"
}

log_warn() {
  echo -e "${YELLOW}$1${NC}"
}

log_error() {
  echo -e "${RED}$1${NC}" >&2
}

if [ "${EUID}" -ne 0 ]; then
  log_error "Please run this script as root (sudo)."
  exit 1
fi

PKG_MANAGER=""

detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    PKG_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG_MANAGER="yum"
  elif command -v pacman >/dev/null 2>&1; then
    PKG_MANAGER="pacman"
  else
    log_error "Unsupported Linux distribution. Install Node.js 20+, npm, ffmpeg, yt-dlp, git, and curl manually."
    exit 1
  fi
}

install_base_packages() {
  log_info "Installing base packages..."

  case "$PKG_MANAGER" in
  apt)
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl git ffmpeg yt-dlp gnupg openssl
    ;;
  dnf)
    dnf install -y ca-certificates curl git ffmpeg yt-dlp openssl
    ;;
  yum)
    yum install -y ca-certificates curl git ffmpeg yt-dlp openssl
    ;;
  pacman)
    pacman -Sy --noconfirm ca-certificates curl git ffmpeg yt-dlp openssl
    ;;
  esac
}

node_major_version() {
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

ensure_nodejs() {
  local current_major=""
  current_major="$(node_major_version || true)"
  if [ -n "$current_major" ] && [ "$current_major" -ge 20 ]; then
    log_info "Node.js v$current_major detected."
    return
  fi

  log_info "Installing Node.js 20..."
  case "$PKG_MANAGER" in
  apt)
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
    ;;
  dnf)
    dnf module reset -y nodejs || true
    dnf module enable -y nodejs:20 || true
    dnf install -y nodejs npm
    ;;
  yum)
    yum install -y nodejs npm
    ;;
  pacman)
    pacman -Sy --noconfirm nodejs npm
    ;;
  esac

  current_major="$(node_major_version || true)"
  if [ -z "$current_major" ] || [ "$current_major" -lt 20 ]; then
    log_error "Node.js 20+ is required. Current version: ${current_major:-not found}"
    exit 1
  fi
}

ensure_app_user() {
  if id -u "$APP_USER" >/dev/null 2>&1; then
    return
  fi

  local nologin_shell="/usr/sbin/nologin"
  if [ ! -x "$nologin_shell" ]; then
    nologin_shell="/bin/false"
  fi

  useradd --system --create-home --shell "$nologin_shell" "$APP_USER"
}

sync_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log_info "Updating existing installation..."
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    git -C "$INSTALL_DIR" checkout -q "$REPO_BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$REPO_BRANCH"
  elif [ -d "$INSTALL_DIR" ]; then
    log_error "$INSTALL_DIR exists but is not a git repository."
    log_error "Remove it manually or set INSTALL_DIR to a different path."
    exit 1
  else
    log_info "Cloning repository..."
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
}

install_node_modules() {
  log_info "Installing production dependencies..."
  cd "$INSTALL_DIR"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped_value

  escaped_value="$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')"
  if grep -q "^${key}=" .env; then
    sed -i "s/^${key}=.*/${key}=${escaped_value}/" .env
  else
    printf '%s=%s\n' "$key" "$value" >>.env
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    tr -dc 'A-Za-z0-9' </dev/urandom | head -c 64
  fi
}

configure_env() {
  cd "$INSTALL_DIR"
  if [ ! -f .env ]; then
    cp .env.example .env
  fi

  local public_ip=""
  public_ip="$(curl -4fsSL https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$public_ip" ]; then
    public_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [ -z "$public_ip" ]; then
    public_ip="127.0.0.1"
  fi

  set_env_value "NODE_ENV" "production"
  set_env_value "PUBLIC_IP" "$public_ip"
  set_env_value "HTTP_REQUEST_LOGS" "0"
  set_env_value "FFMPEG_PATH" "/usr/bin/ffmpeg"

  local current_secret=""
  current_secret="$(grep '^SESSION_SECRET=' .env | head -n1 | cut -d= -f2- || true)"
  if [ -z "${current_secret}" ]; then
    set_env_value "SESSION_SECRET" "$(generate_secret)"
  fi

  mkdir -p db logs public/uploads
  chown -R "$APP_USER":"$APP_USER" db logs public/uploads .env
}

install_optional_browser() {
  cd "$INSTALL_DIR"

  if [ "$INSTALL_CHROMIUM" != "1" ]; then
    log_warn "Skipping Playwright Chromium download (lighter VPS mode)."
    log_warn "If you need Instagram browser automation, run:"
    log_warn "  sudo -u $APP_USER bash -lc 'cd $INSTALL_DIR && PLAYWRIGHT_BROWSERS_PATH=$INSTALL_DIR/.cache/ms-playwright npx playwright install chromium'"
    return
  fi

  log_info "Installing Playwright Chromium..."
  su -s /bin/bash -c "cd '$INSTALL_DIR' && PLAYWRIGHT_BROWSERS_PATH='$INSTALL_DIR/.cache/ms-playwright' npx playwright install chromium" "$APP_USER"
  set_env_value "PLAYWRIGHT_BROWSERS_PATH" "$INSTALL_DIR/.cache/ms-playwright"
  chown -R "$APP_USER":"$APP_USER" "$INSTALL_DIR/.cache"
}

install_service() {
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"

  cat >"$service_file" <<EOF
[Unit]
Description=StreamFire Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
Environment=NODE_ENV=production
Environment=PATH=/usr/bin:/usr/local/bin
ExecStart=/usr/bin/env node app.js
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$INSTALL_DIR/db $INSTALL_DIR/logs $INSTALL_DIR/public/uploads

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
}

install_uninstall_script() {
  cat >/usr/local/bin/streamfire-uninstall <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [ "\${EUID}" -ne 0 ]; then
  echo "Please run as root (sudo)."
  exit 1
fi

systemctl stop $SERVICE_NAME 2>/dev/null || true
systemctl disable $SERVICE_NAME 2>/dev/null || true
rm -f /etc/systemd/system/$SERVICE_NAME.service
systemctl daemon-reload
rm -rf $INSTALL_DIR
rm -f /usr/local/bin/streamfire-uninstall
echo "StreamFire uninstalled."
EOF

  chmod +x /usr/local/bin/streamfire-uninstall
}

show_result() {
  local public_ip=""
  public_ip="$(grep '^PUBLIC_IP=' "$INSTALL_DIR/.env" | head -n1 | cut -d= -f2- || true)"
  local port=""
  port="$(grep '^PORT=' "$INSTALL_DIR/.env" | head -n1 | cut -d= -f2- || true)"
  if [ -z "$port" ]; then
    port="7575"
  fi

  log_info "StreamFire installed successfully."
  echo "Dashboard: http://${public_ip}:${port}"
  echo "Service: sudo systemctl status $SERVICE_NAME"
  echo "Uninstall: sudo streamfire-uninstall"
}

main() {
  detect_pkg_manager
  install_base_packages
  ensure_nodejs
  ensure_app_user
  sync_repo
  install_node_modules
  configure_env
  install_optional_browser
  install_service
  install_uninstall_script
  show_result
}

main "$@"
