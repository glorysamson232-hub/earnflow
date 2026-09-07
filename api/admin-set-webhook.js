// api/admin-set-webhook.js
//
// Registers your bot's webhook with Telegram automatically, using the
// token already stored safely in Vercel's environment variables — no
// need to type or paste it into a browser address bar.

const ADMIN_SECRET = process.env.ADMIN_SECRET;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const APP_URL = process.env.APP_URL;

export default async function handler(req, res) {
  const key = req.method === "GET" ? req.query.key : (req.body && req.body.key);
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!BOT_TOKEN || !WEBHOOK_SECRET || !APP_URL) {
    return res.status(400).json({
      error: "Missing one of TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, or APP_URL in Vercel env vars",
    });
  }

  try {
    if (req.method === "GET") {
      // Just check current status
      const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
      const info = await infoRes.json();
      return res.status(200).json(info);
    }

    if (req.method === "POST") {
      const webhookUrl = `${APP_URL}/api/telegram-webhook`;
      const setRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, secret_token: WEBHOOK_SECRET }),
      });
      const result = await setRes.json();
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
