// api/broadcast.js
//
// Sends a message to every user who has opened your bot. Protected by
// the same admin secret as the rest of the admin panel. Sends are
// batched concurrently, and users who've blocked the bot are skipped
// without failing the whole broadcast.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json();
}

async function sendTelegramMessage(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const data = await res.json();
  return data.ok;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { key, message } = req.body;
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const users = await supabaseFetch(`app_users?select=telegram_id`);

    // Send in batches so we don't fire thousands of requests at once
    // or run past the serverless function's time limit.
    const BATCH_SIZE = 25;
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(u => sendTelegramMessage(u.telegram_id, message))
      );
      results.forEach(r => {
        if (r.status === "fulfilled" && r.value) sent++;
        else failed++;
      });
    }

    return res.status(200).json({ success: true, totalUsers: users.length, sent, failed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
      }
