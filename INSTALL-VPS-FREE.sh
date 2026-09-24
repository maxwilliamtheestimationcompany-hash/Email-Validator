#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="/opt/email-validator"
APP_PORT="3093"
SERVICE_NAME="email-validator"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${EUID}" -ne 0 ]]; then echo "Run: sudo bash INSTALL-VPS-FREE.sh"; exit 1; fi
DOMAIN="${1:-}"
SMTP_HELO="${DOMAIN:-$(hostname -f 2>/dev/null || hostname)}"
[[ "$SMTP_HELO" == *.* ]] || SMTP_HELO="verify.local"
SMTP_FROM="verify@${DOMAIN:-example.com}"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates gnupg nginx dnsutils netcat-openbsd rsync
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])' 2>/dev/null || echo 0)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
mkdir -p "$APP_DIR"
rsync -a --delete --exclude='.env' --exclude='node_modules' --exclude='*.zip' "$SOURCE_DIR/" "$APP_DIR/"
cd "$APP_DIR"
npm install --omit=dev
if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -f "$SOURCE_DIR/.env" ]]; then cp "$SOURCE_DIR/.env" "$APP_DIR/.env";
  else cp "$APP_DIR/.env.example" "$APP_DIR/.env"; fi
fi
chmod 600 "$APP_DIR/.env"
NODE_BIN="$(command -v node)"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Email Validator Advanced v6.4 Validect
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3
User=www-data
Group=www-data
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF
chown -R www-data:www-data "$APP_DIR"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
SERVER_NAME="${DOMAIN:-_}"
cat > /etc/nginx/sites-available/email-verifier <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $SERVER_NAME;
  client_max_body_size 12m;
  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
  }
}
EOF
ln -sfn /etc/nginx/sites-available/email-verifier /etc/nginx/sites-enabled/email-verifier
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
IP="$(hostname -I | awk '{print $1}')"
echo
echo "DONE: Email Validator v6.4 Validect is running."
echo "Open: http://${DOMAIN:-$IP}"
echo "Configure RAPIDAPI_KEY in $APP_DIR/.env. Protect the site with authentication before public access."
