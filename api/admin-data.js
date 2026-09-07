// api/admin-data.js
//
// Powers the admin panel. GET loads live settings from Supabase;
// POST saves changes back. Protected by ADMIN_SECRET — the same
// secret in your admin URL (?key=...) doubles as the API password,
// so only someone with that link can read or change anything here.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

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
  // DELETE with no return=representation still returns JSON-parseable body here
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  const key = req.method === "GET" ? req.query.key : (req.body && req.body.key);
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const [config, tiers, tasks] = await Promise.all([
        supabaseFetch(`admin_config?id=eq.1&select=*`).then(r => r[0]),
        supabaseFetch(`referral_tiers?select=*&order=min_ref.asc`),
        supabaseFetch(`tasks?select=*&order=created_at.asc`),
      ]);
      return res.status(200).json({ config, tiers, tasks });
    }

    if (req.method === "POST") {
      const { config, tiers, tasks } = req.body;

      // 1. Update the single admin_config row
      if (config) {
        await supabaseFetch(`admin_config?id=eq.1`, {
          method: "PATCH",
          body: JSON.stringify({
            points_per_dollar: config.pointsPerDollar,
            referral_qualification_tasks: config.referralQualificationTasks,
            referral_system_enabled: config.referralSystemEnabled,
            min_withdrawal: config.minWithdrawal,
            max_withdrawal: config.maxWithdrawal,
            withdrawal_fee_percent: config.withdrawalFeePercent,
            withdrawals_per_day: config.withdrawalsPerDay,
            withdrawal_days: config.withdrawalDays,
            withdrawal_open: config.withdrawalOpen,
            withdrawal_close: config.withdrawalClose,
            method_usdt_enabled: config.methodUSDT,
            method_ton_enabled: config.methodTON,
            min_referrals_for_withdrawal: config.minReferralsForWithdrawal,
          }),
        });
      }

      // 2. Sync referral tiers: delete removed, update existing, insert new
      if (tiers) {
        const existing = await supabaseFetch(`referral_tiers?select=id`);
        const keepIds = tiers.filter(t => t.id).map(t => t.id);
        const toDelete = existing.filter(e => !keepIds.includes(e.id));
        for (const row of toDelete) {
          await supabaseFetch(`referral_tiers?id=eq.${row.id}`, { method: "DELETE" });
        }
        for (const t of tiers) {
          const body = JSON.stringify({ min_ref: t.minRef, max_ref: t.maxRef, reward: t.reward });
          if (t.id) {
            await supabaseFetch(`referral_tiers?id=eq.${t.id}`, { method: "PATCH", body });
          } else {
            await supabaseFetch(`referral_tiers`, { method: "POST", body });
          }
        }
      }

      // 3. Sync tasks the same way
      if (tasks) {
        const existing = await supabaseFetch(`tasks?select=id`);
        const keepIds = tasks.filter(t => t.id).map(t => t.id);
        const toDelete = existing.filter(e => !keepIds.includes(e.id));
        for (const row of toDelete) {
          await supabaseFetch(`tasks?id=eq.${row.id}`, { method: "DELETE" });
        }
        for (const t of tasks) {
          const body = JSON.stringify({
            name: t.name, description: t.description, link: t.link,
            reward: t.reward, active: t.active,
            verification_type: t.verificationType || "self_report",
            telegram_chat_id: t.telegramChatId || null,
          });
          if (t.id) {
            await supabaseFetch(`tasks?id=eq.${t.id}`, { method: "PATCH", body });
          } else {
            await supabaseFetch(`tasks`, { method: "POST", body });
          }
        }
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
