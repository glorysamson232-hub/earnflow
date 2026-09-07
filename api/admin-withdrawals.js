// api/admin-withdrawals.js
//
// GET: returns all withdrawal requests with full wallet addresses (not
// masked — admin needs the real address to actually pay out) and the
// requesting user's Telegram ID.
// POST: approve or reject a specific withdrawal. Rejecting refunds the
// reserved points back to the user's spendable balance.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function notifyUser(telegramId, text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramId, parse_mode: "HTML", text }),
    });
  } catch (e) {
    console.error("Failed to notify user:", e);
  }
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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const key = req.query.key;
      if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Pull withdrawals with the owning user's telegram_id/display_name
      // via Supabase's embedded resource syntax
      const withdrawals = await supabaseFetch(
        `withdrawals?select=*,app_users(telegram_id,display_name)&order=created_at.desc`
      );
      return res.status(200).json({ withdrawals });
    }

    if (req.method === "POST") {
      const { key, withdrawalId, action } = req.body;
      if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!withdrawalId || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "withdrawalId and a valid action are required" });
      }

      const rows = await supabaseFetch(`withdrawals?id=eq.${withdrawalId}&select=*`);
      if (!rows.length) return res.status(404).json({ error: "Withdrawal not found" });
      const withdrawal = rows[0];

      if (withdrawal.status !== "Pending" && withdrawal.status !== "Under Review") {
        return res.status(400).json({ error: `Already ${withdrawal.status}` });
      }

      const userRows = await supabaseFetch(`app_users?id=eq.${withdrawal.user_id}&select=*`);
      const user = userRows[0];

      if (action === "approve") {
        await supabaseFetch(`withdrawals?id=eq.${withdrawalId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "Paid", updated_at: new Date().toISOString() }),
        });
        await supabaseFetch(`app_users?id=eq.${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            pending_withdrawal: Math.max(0, user.pending_withdrawal - withdrawal.points),
            total_withdrawn: user.total_withdrawn + withdrawal.points,
          }),
        });
        await notifyUser(
          user.telegram_id,
          `✅ <b>Withdrawal approved</b>\n\n` +
          `${withdrawal.points.toLocaleString()} pts ($${Number(withdrawal.net_amount).toFixed(3)} net) has been sent to your ${withdrawal.method} wallet.\n` +
          `<code>${withdrawal.wallet_address}</code>`
        );
      } else {
        // Reject: refund the reserved points back to the user's spendable balance
        await supabaseFetch(`withdrawals?id=eq.${withdrawalId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "Rejected", updated_at: new Date().toISOString() }),
        });
        await supabaseFetch(`app_users?id=eq.${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            pending_withdrawal: Math.max(0, user.pending_withdrawal - withdrawal.points),
            points_balance: user.points_balance + withdrawal.points,
          }),
        });
        await notifyUser(
          user.telegram_id,
          `❌ <b>Withdrawal rejected</b>\n\n` +
          `Your request for ${withdrawal.points.toLocaleString()} pts via ${withdrawal.method} was rejected and the points have been refunded to your balance.`
        );
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
                                         }
