# Deployment Steps

## Prerequisites

- Ubuntu 22.04 (or similar). Nginx and PHP 8.1+ (php-fpm) are installed by `deploy.sh`.
- If your PHP-FPM socket path differs (e.g. `php8.2-fpm`), edit `memecoin-dashboard.conf` and replace `php8.1-fpm` with your version, then run `sudo systemctl restart php8.2-fpm` after deploy.

## Upload to Droplet

```bash
scp -r memecoin-dashboard root@YOUR_DROPLET_IP:/root/
```

## SSH and Deploy

```bash
ssh root@YOUR_DROPLET_IP
cd memecoin-dashboard
chmod +x deploy.sh
./deploy.sh
```

## Access Dashboard

```
http://YOUR_DROPLET_IP:8080
```

Replace `YOUR_DROPLET_IP` with your DigitalOcean droplet’s IP address.

---

## Server-Based Token Storage

- The **token list** is stored in `config.json` on the server (`/var/www/memecoin-dashboard/config.json`).
- **Add** and **remove** requests are handled by `api.php` and update `config.json`.
- All devices opening `http://YOUR_IP:8080` see the **same token list** (cross-device sync).
- **Price history** and **timeframe** selections are kept in browser memory only (session-specific, not synced).
