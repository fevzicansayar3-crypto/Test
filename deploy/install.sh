#!/usr/bin/env bash
# VDS kurulum betiği (Ubuntu/Debian). root olarak, repo klasörünün içinden çalıştır:
#   sudo bash deploy/install.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/oyun

[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştır"; exit 1; }
. /etc/os-release
echo "== Sistem: $PRETTY_NAME"
command -v apt >/dev/null || { echo "Bu betik apt (Debian/Ubuntu) bekliyor."; exit 1; }
if [ ! -f "$SRC/public/index.html" ]; then
  echo "UYARI: public/index.html yok, geçici bekleme sayfası kullanılıyor."
  cp "$SRC/deploy/placeholder.html" "$SRC/public/index.html"
fi

echo "== Paketler"
export DEBIAN_FRONTEND=noninteractive
apt update && apt -y upgrade
apt install -y curl ca-certificates ufw fail2ban

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "== Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
node -v && npm -v

echo "== Eski python http.server (3000) varsa durdur"
for u in $(systemctl list-units --type=service --no-legend --plain | awk '{print $1}'); do
  if systemctl cat "$u" 2>/dev/null | grep -q 'http.server.*3000'; then
    echo "   $u durduruluyor"; systemctl disable --now "$u" || true
  fi
done
pkill -f 'python3? -m http.server 3000' || true

echo "== Kullanıcı ve dosyalar"
id oyun >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin oyun
mkdir -p "$APP/public" "$APP/data"
install -m 644 "$SRC/package.json" "$SRC/package-lock.json" "$SRC/server.js" "$APP/"
cp -r "$SRC/public/." "$APP/public/"
node "$SRC/scripts/patch-index.js" "$APP/public/index.html"
chown -R oyun:oyun "$APP"
cd "$APP" && sudo -u oyun npm ci --omit=dev

echo "== systemd"
install -m 644 "$SRC/deploy/oyun.service" /etc/systemd/system/oyun.service
systemctl daemon-reload
systemctl enable oyun
systemctl restart oyun
sleep 2
systemctl status oyun --no-pager || true

echo "== Güvenlik duvarı (önce 22!)"
ufw allow 22/tcp
ufw allow 3000/tcp
ufw --force enable
ufw status verbose
systemctl enable --now fail2ban

echo "== Testler"
curl -sI http://127.0.0.1:3000/ | head -3
curl -s http://127.0.0.1:3000/api/lb; echo
ss -tulpn | grep 3000 || true
IP=$(curl -s -4 https://ifconfig.me || hostname -I | awk '{print $1}')
echo
echo "Kurulum bitti: http://$IP:3000"
echo "UNUTMA: VDS panelinde ayrı güvenlik duvarı varsa 3000/TCP aç; 'passwd' ile root şifresini değiştir."
