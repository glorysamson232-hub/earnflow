// api/bootstrap.js
//
// Called once when the Mini App opens. Verifies the request really came
// from Telegram (using your bot token), creates the user's row if this
// is their first time, links them to whoever referred them, and returns
// everything the frontend needs to render — so the browser never has to
// be trusted with its own balance/tasks/history.

import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function verifyChannelMembership(chatId, userTelegramId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userTelegramId}`;
  const res = await fetch(url);
  const data = await res.json();
  // If the Telegram API call itself fails (e.g. bot isn't admin in the
  // channel, or the channel ID is misconfigured), don't lock every user
  // out over an admin mistake — only block on a confirmed "not a member".
  if (!data.ok) return true;
  const validStatuses = ["member", "administrator", "creator"];
  return validStatuses.includes(data.result.status);
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json();
}

// Verifies Telegram's signed initData string against your bot token.
// See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return null;

  const userJson = params.get("user");
  if (!userJson) return null;
  return JSON.parse(userJson);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { initData, startParam } = req.body;
    if (!initData) return res.status(400).json({ error: "initData is required" });

    const tgUser = verifyInitData(initData);
    if (!tgUser) {
      return res.status(401).json({ error: "Could not verify Telegram identity" });
    }
    const telegramId = String(tgUser.id);

    // 0. Check the channel-join gate before doing anything else
    const config = (await supabaseFetch(`admin_config?id=eq.1&select=*`))[0];
    if (config.require_channel_join && config.official_channel_id) {
      const isMember = await verifyChannelMembership(config.official_channel_id, telegramId);
      if (!isMember) {
        return res.status(403).json({
          error: "not_joined",
          channelLink: config.official_channel_link || null,
        });
      }
    }

    // 1. Find or create the user
    let users = await supabaseFetch(`app_users?telegram_id=eq.${telegramId}&select=*`);
    let user;
    let isNewUser = false;

    if (users.length) {
      user = users[0];
      // Keep username current in case they changed it since last login
      if (tgUser.username && tgUser.username !== user.telegram_username) {
        const updated = await supabaseFetch(`app_users?id=eq.${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({ telegram_username: tgUser.username }),
        });
        user = updated[0];
      }
    } else {
      isNewUser = true;
      const created = await supabaseFetch(`app_users`, {
        method: "POST",
        body: JSON.stringify({
          telegram_id: telegramId,
          display_name: tgUser.first_name || tgUser.username || "User",
          telegram_username: tgUser.username || null,
        }),
      });
      user = created[0];
    }

    // 2. If this is a new user who arrived via a referral link, link them.
    //    Self-referral (someone using their own start param) is blocked.
    if (isNewUser && startParam && startParam !== telegramId) {
      const referrer = (
        await supabaseFetch(`app_users?telegram_id=eq.${startParam}&select=id`)
      )[0];
      if (referrer) {
        try {
          await supabaseFetch(`referrals`, {
            method: "POST",
            body: JSON.stringify({ referrer_id: referrer.id, referred_id: user.id }),
          });
        } catch (e) {
          // unique constraint on referred_id means this user was already
          // referred once — safe to ignore
        }
      }
    }

    // 3. Pull everything else the frontend needs in one go
    const [tiers, tasks, completions, referrals, withdrawals] = await Promise.all([
      supabaseFetch(`referral_tiers?select=*&order=min_ref.asc`),
      supabaseFetch(`tasks?active=eq.true&select=*`),
      supabaseFetch(`task_completions?user_id=eq.${user.id}&select=task_id`),
      supabaseFetch(`referrals?referrer_id=eq.${user.id}&select=*`),
      supabaseFetch(`withdrawals?user_id=eq.${user.id}&select=*&order=created_at.desc`),
    ]);

    return res.status(200).json({
      user,
      config,
      referralTiers: tiers,
      tasks,
      completedTaskIds: completions.map(c => c.task_id),
      referrals,
      withdrawals,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
      }
      
