# Bütün Dilleri Öğreniyoruz — VDS sunucusu

Tek Node.js süreci, 3000 portunda: statik oyun dosyası + sıralama API'si (`/api/lb`) + canlı oda WebSocket'i (`/ws`).
`public/shim.js`, oyunun kullandığı `window.claude.use("room" | "db" | "user")` arayüzünü bu sunucuya bağlar.

## Kurulum (VDS üzerinde, root)

```bash
apt update && apt install -y git
git clone -b claude/vigilant-cray-9qsf65 https://github.com/fevzicansayar3-crypto/Test.git /root/oyun-src
cd /root/oyun-src
# Oyun dosyasını public/index.html olarak koy (ör. scp index.html root@SUNUCU:/root/oyun-src/public/)
bash deploy/install.sh
```

`install.sh` şunları yapar: sistemi günceller, Node.js 20 kurar, `oyun` kullanıcısını açar, dosyaları `/opt/oyun`'a kopyalar,
`index.html`'e shim'i ekler ve davet `BASE` adresini düzeltir, systemd servisini başlatır, ufw ile 22 ve 3000'i açar, fail2ban'ı açar.

## Faydalı komutlar

| İş | Komut |
|---|---|
| Yeniden başlat | `systemctl restart oyun` |
| Loglar | `journalctl -u oyun -f` |
| Durdur | `systemctl stop oyun` |
| Oyunu güncelle | yeni dosyayı `/opt/oyun/public/index.html` yap, sonra `node /root/oyun-src/scripts/patch-index.js /opt/oyun/public/index.html` |

## Geliştirme

```bash
npm ci
npm test        # sunucu + oda testleri
PORT=3000 npm start
```

## Güvenlik

- VDS panelinde ayrı bir güvenlik duvarı varsa **3000/TCP**'yi orada da aç.
- Root şifresi bir sohbette paylaşıldı: `passwd` ile **hemen değiştir**.
- SSH anahtarına geç; anahtarla girişin çalıştığını test ettikten sonra `/etc/ssh/sshd_config` içinde
  `PermitRootLogin prohibit-password` ve `PasswordAuthentication no` yapıp `systemctl reload ssh`.
