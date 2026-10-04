# VPS deployment notes

The application expects its production `.env` at `/root/ringringring/.env` on the PowerRDP VPS.

Recommended PM2 start:

```bash
cd /root/ringringring/IceArena1-main
pm2 delete ringring 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
```

Check the app:

```bash
pm2 status
pm2 logs ringring --lines 50
curl http://127.0.0.1:10000/health
```

The main bot uses `TELEGRAM_BOT_TOKEN`; the separate support bot uses `SUPPORT_BOT_TOKEN`.

The `/start` handler now falls back to `sendMessage` if `WELCOME_IMAGE_URL` cannot be sent as a Telegram photo. This prevents an invalid image-host URL from making `/start` appear to do nothing.

Do not commit the real `.env` or bot tokens to GitHub.
