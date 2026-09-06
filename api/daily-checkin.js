// api/daily-checkin.js
//
// Claims the daily check-in reward. The 24-hour cooldown is enforced
// here on the server using the database's own timestamp comparison —
// never trust a client-sent "it's been 24 hours" claim.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: "telegramId is required" });

    const users = await supabaseFetch(`app_users?telegram_id=eq.${telegramId}&select=*`);
    if (!users.length) return res.status(404).json({ error: "User not found" });
    const user = users[0];

    const config = (await supabaseFetch(`admin_config?id=eq.1&select=*`))[0];
    if (!config.daily_checkin_enabled) {
      return res.status(400).json({ error: "Daily check-in is currently disabled" });
    }
    if (user.is_flagged) {
      return res.status(403).json({ error: "Account is flagged for review" });
    }

    const now = new Date();
    const last = user.last_checkin_at ? new Date(user.last_checkin_at) : null;
    const hoursSinceLast = last ? (now - last) / (1000 * 60 * 60) : Infinity;

    if (hoursSinceLast < 24) {
      const nextClaimAt = new Date(last.getTime() + 24 * 60 * 60 * 1000);
      return res.status(400).json({
        error: "Already checked in — come back later",
        nextClaimAt: nextClaimAt.toISOString(),
      });
    }

    // Streak continues if they checked in within the last 48 hours,
    // otherwise it resets to 1 (missed a day).
    const newStreak = hoursSinceLast <= 48 ? user.checkin_streak + 1 : 1;
    const reward = config.daily_checkin_reward;

    await supabaseFetch(`app_users?id=eq.${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        points_balance: user.points_balance + reward,
        total_earned: user.total_earned + reward,
        last_checkin_at: now.toISOString(),
        checkin_streak: newStreak,
      }),
    });

    return res.status(200).json({
      success: true,
      pointsEarned: reward,
      streak: newStreak,
      nextClaimAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
  
