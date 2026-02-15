#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root${NC}"
  exit 1
fi

echo -e "${GREEN}Installing dependencies...${NC}"

if command -v apt-get &> /dev/null; then
    apt-get update -qq
    apt-get install -y -qq nodejs npm ffmpeg git curl
elif command -v dnf &> /dev/null; then
    dnf install -y nodejs npm ffmpeg git curl
elif command -v yum &> /dev/null; then
    yum install -y nodejs npm ffmpeg git curl
elif command -v pacman &> /dev/null; then
    pacman -Sy --noconfirm nodejs npm ffmpeg git curl
else
    echo -e "${RED}Package manager not found. Please install nodejs, npm, ffmpeg, git, curl manually.${NC}"
    exit 1
fi

INSTALL_DIR="/opt/streamfire"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${Green}Updating existing installation...${NC}"
    cd "$INSTALL_DIR"
    git pull
else
    git clone https://github.com/broman0x/streamfire.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

npm install --silent

if [ ! -f .env ]; then
    cp .env.example .env
fi

PUBLIC_IP=$(curl -s ifconfig.me || echo "YOUR_SERVER_IP")
if grep -q "PUBLIC_IP=" .env; then
    sed -i "s/PUBLIC_IP=.*/PUBLIC_IP=$PUBLIC_IP/" .env
else
    echo "PUBLIC_IP=$PUBLIC_IP" >> .env
fi

SERVICE_FILE="/etc/systemd/system/streamfire.service"
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=StreamFire Service
After=network.target

[Service]
ExecStart=/usr/bin/npm start
WorkingDirectory=$INSTALL_DIR
Restart=always
User=root
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable streamfire
systemctl restart streamfire

cat <<EOF > /usr/local/bin/streamfire-uninstall
#!/bin/bash
if [ "\$EUID" -ne 0 ]; then
  echo "Please run as root"
  exit 1
fi
systemctl stop streamfire
systemctl disable streamfire
rm /etc/systemd/system/streamfire.service
systemctl daemon-reload
rm -rf $INSTALL_DIR
rm /usr/local/bin/streamfire-uninstall
echo "StreamFire uninstalled successfully."
EOF

chmod +x /usr/local/bin/streamfire-uninstall

echo -e "${GREEN}StreamFire installed successfully!${NC}"
echo -e "Dashboard: http://$PUBLIC_IP:7575"
echo -e "Uninstall command: sudo streamfire-uninstall"
