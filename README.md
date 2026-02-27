<p align="center">
  <a href="https://github.com/broman0x/streamfire">
    <img src="public/img/logo.png" alt="StreamFire Logo" width="200"/>
  </a>
</p>

<p align="center">
  <a href="https://github.com/broman0x/streamfire/stargazers"><img src="https://img.shields.io/github/stars/broman0x/streamfire?style=social" alt="GitHub Stars"></a>
  <a href="https://github.com/broman0x/streamfire/network"><img src="https://img.shields.io/github/forks/broman0x/streamfire?style=social" alt="GitHub Forks"></a>
  <a href="https://github.com/broman0x/streamfire/issues"><img src="https://img.shields.io/github/issues/broman0x/streamfire?color=red" alt="Issues"></a>
  <a href="https://github.com/broman0x/streamfire/pulls"><img src="https://img.shields.io/github/issues-pr/broman0x/streamfire?color=green" alt="Pull Requests"></a>
  <a href="https://github.com/broman0x/streamfire/blob/main/LICENSE"><img src="https://img.shields.io/github/license/broman0x/streamfire?color=blue" alt="License"></a>
  <br>
  <img src="https://img.shields.io/static/v1?label=Node.js&message=%3E%3D20&color=brightgreen&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/FFmpeg-Required-ff0000?logo=ffmpeg" alt="FFmpeg">
</p>

<h1 align="center">🔥StreamFire</h1>

<p align="center">
  <strong>Panel Live Streaming 24/7 Pribadi — Paling Ringan, Paling Stabil, Paling Murah!</strong>
</p>

<p align="center">
  <b>StreamFire</b> adalah panel kontrol live streaming <b>self-hosted</b> yang dirancang khusus agar kamu bisa streaming 24/7 tanpa harus nyalain PC/laptop terus. Cuma butuh VPS murah (Rp30.000/bulan pun cukup!), upload video MP4, atur loop, lalu stream ke YouTube, Twitch, Facebook, TikTok, atau RTMP manapun.
</p>

<details open>

## Fitur Unggulan

- Dasbor modern & responsif (HP & PC)
- Support resolusi 360p → 1080p 60FPS (preset siap pakai)
- Jalan lancar di VPS termurah (1 Core, 1 GB RAM!)
- Real-time monitoring CPU, RAM, Disk
- Auto-loop 24/7
- Menggunakan FFmpeg sistem → anti crash & memory leak
- Support multi-platform: YouTube, Twitch, Facebook, TikTok, Custom RTMP
- Integrasi panel Instagram Live (cookie login + setup key + start/go/end live)

## Integrasi Instagram Live

Panel Instagram Live sekarang ada langsung di Dashboard:

1. Isi cookie Instagram lalu klik `Login via Cookie`.
2. Isi judul + audience lalu klik `Setup Live (Get Key)` untuk ambil `streamUrl/streamKey` dari Instagram Live Producer.
3. Pilih video yang sudah di-upload di StreamFire, atur resolusi/FPS/bitrate, lalu klik `Start IG Stream`.
4. Saat ingest sudah stabil, klik `Go Live`.
5. Untuk mengakhiri siaran klik `End Live`.

Catatan:
- Butuh dependency `playwright` (sudah ditambahkan di `package.json`).
- Mode install default dibuat ringan (browser Playwright tidak di-download otomatis).
- Jika butuh IG automation penuh, install browser Playwright:
  ```bash
  sudo -u streamfire bash -lc 'cd /opt/streamfire && PLAYWRIGHT_BROWSERS_PATH=/opt/streamfire/.cache/ms-playwright npx playwright install chromium'
  ```

## Quick Install (Sekali Deploy - Rekomendasi VPS)
Jalankan 1 command ini di VPS (Ubuntu/Debian):

```bash
curl -fsSL https://raw.githubusercontent.com/broman0x/streamfire/main/install.sh | sudo bash
```

Script ini otomatis:
- install dependency sistem (FFmpeg + Node.js 20),
- clone/update repo ke `/opt/streamfire`,
- install dependency production (`npm ci --omit=dev`),
- setup `.env` otomatis (`NODE_ENV=production`, `SESSION_SECRET`, `PUBLIC_IP`),
- register service `systemd` (`streamfire`) dengan auto-restart.

Kalau mau sekalian install browser Playwright (untuk fitur IG):
```bash
curl -fsSL https://raw.githubusercontent.com/broman0x/streamfire/main/install.sh | sudo env INSTALL_CHROMIUM=1 bash
```

## Manual Install
Jika ingin install manual:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install ffmpeg git curl -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs -y
git clone https://github.com/broman0x/streamfire.git
cd streamfire
cp .env.example .env
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund
NODE_ENV=production npm start
```

## Edit .env (Opsional)
```bash
PORT=7575
PUBLIC_IP=IP_VPS_KAMU
NODE_ENV=production
SESSION_SECRET=isi_random_panjang
```
Kalau env tidak diisi, app tetap jalan dengan default runtime otomatis:
- `SESSION_SECRET` di-generate otomatis saat boot.
- `DB_PATH` fallback ke `./db/streamfire.db`.
- `UPLOAD_PATH` fallback ke `./public/uploads`.

## Deploy via Docker (Alternatif)
```bash
cp .env.example .env
docker compose up -d --build
```

## Deploy Railway (Zero Config)
1. Push repo ke GitHub.
2. Di Railway: `New Project` -> `Deploy from GitHub Repo`.
3. Pilih repo ini, deploy (Dockerfile otomatis dipakai).

Tanpa set env pun app sudah bisa jalan.
Catatan:
- Tanpa volume persistent, data upload + SQLite akan reset saat redeploy/restart container.
- Kalau mau data tetap aman, baru tambahkan volume ke `/app/db` dan `/app/public/uploads`.

## Dashboard
```bash
Dashboard: http://IP_VPS_KAMU:7575
```

## Reverse Proxy (Nginx + HTTPS Gratis) – Rekomendasi!
Kalau mau pakai domain + HTTPS gratis:
```bash
sudo apt install nginx certbot python3-certbot-nginx -y
sudo certbot --nginx -d streamfire.kamu.com
```

## Donasi & Support
Proyek ini 100% gratis & open source. Kalau kamu suka & terbantu, boleh traktir kopi biar gua semangat update terus ☕
## Donate 
- https://sociabuzz.com/broman/tribe

## USDT/BNB (BEP20) 
```bash
0x1566b42493fa3faa98a7644dae9bd3c94cf671a5
```

## Kontribusi
Ingin berkontribusi? Silakan!
1. Fork repositori ini.
2. Buat branch baru untuk fitur/fix kamu.
3. Commit perubahan kamu.
4. Push ke branch tersebut.
5. Buat Pull Request.

Jika menemukan bug atau punya ide fitur baru, jangan ragu untuk membuat **Issue** baru!

## © Lisensi
Licensed MIT License 
