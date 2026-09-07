// api/admin-adjust-balance.js
//
// Lets you manually credit or debit a user's balance — e.g. compensating
// for a bug, or removing points for abuse. Positive amount adds,
// negative amount removes. Only affects points_balance; total_earned
// is left untouched since this isn't something the user "earned".

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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { key, telegramId, amount } = req.body;
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!telegramId || amount === undefined || amount === null) {
    return res.status(400).json({ error: "telegramId and amount are required" });
  }
  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: "amount must be a non-zero number" });
  }

  try {
    const users = await supabaseFetch(`app_users?telegram_id=eq.${telegramId}&select=*`);
    if (!users.length) return res.status(404).json({ error: "User not found" });
    const user = users[0];

    const newBalance = user.points_balance + delta;
    if (newBalance < 0) {
      return res.status(400).json({ error: "This would take the user's balance below zero" });
    }

    await supabaseFetch(`app_users?id=eq.${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ points_balance: newBalance }),
    });

    return res.status(200).json({ success: true, newBalance });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
                                           }
