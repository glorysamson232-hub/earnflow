// api/request-withdrawal.js
//
// Runs server-side on Vercel. This is the only place allowed to move
// points out of a user's available balance — the frontend just calls
// this and shows whatever it's told back.

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
  return res.json();
}

// Checks whether "now" falls inside the admin's configured withdrawal window
function withinWithdrawalWindow(config) {
  const now = new Date();
  const dayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const todayCode = dayCodes[now.getUTCDay()]; // adjust to your users' timezone if needed
  if (!config.withdrawal_days.includes(todayCode)) return false;

  const [openH, openM] = config.withdrawal_open.split(":").map(Number);
  const [closeH, closeM] = config.withdrawal_close.split(":").map(Number);
  const curMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  return curMinutes >= openMinutes && curMinutes <= closeMinutes;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { telegramId, method, walletAddress, points } = req.body;
    if (!telegramId || !method || !walletAddress || !points) {
      return res.status(400).json({ error: "telegramId, method, walletAddress, and points are required" });
    }
    if (!["USDT", "TON"].includes(method)) {
      return res.status(400).json({ error: "method must be USDT or TON" });
    }

    const requestedPoints = Number(points);
    if (!Number.isFinite(requestedPoints) || requestedPoints <= 0) {
      return res.status(400).json({ error: "Invalid points amount" });
    }

    // 1. Load user, config
    const users = await supabaseFetch(`app_users?telegram_id=eq.${telegramId}&select=*`);
    if (!users.length) return res.status(404).json({ error: "User not found" });
    const user = users[0];

    const config = (await supabaseFetch(`admin_config?id=eq.1&select=*`))[0];

    // 2. Eligibility checks — every one of these mirrors the spec
    if (user.is_flagged) {
      return res.status(403).json({ error: "Account is suspended or flagged for review" });
    }
    if (method === "USDT" && !config.method_usdt_enabled) {
      return res.status(400).json({ error: "USDT withdrawals are currently disabled" });
    }
    if (method === "TON" && !config.method_ton_enabled) {
      return res.status(400).json({ error: "TON withdrawals are currently disabled" });
    }
    if (!withinWithdrawalWindow(config)) {
      return res.status(400).json({
        error: `Withdrawals are currently closed. Please return during the next withdrawal period (${config.withdrawal_open}–${config.withdrawal_close}).`,
      });
    }
    if (requestedPoints < config.min_withdrawal) {
      return res.status(400).json({ error: `Minimum withdrawal is ${config.min_withdrawal} points` });
    }
    if (requestedPoints > config.max_withdrawal) {
      return res.status(400).json({ error: `Maximum withdrawal is ${config.max_withdrawal} points` });
    }
    if (requestedPoints > user.points_balance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // 3. Daily limit — count today's withdrawals for this user
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todaysWithdrawals = await supabaseFetch(
      `withdrawals?user_id=eq.${user.id}&created_at=gte.${startOfDay.toISOString()}&select=id`
    );
    if (todaysWithdrawals.length >= config.withdrawals_per_day) {
      return res.status(400).json({ error: `Daily withdrawal limit of ${config.withdrawals_per_day} reached` });
    }

    // 4. Compute fee and net amount server-side — never trust a client value
    const usdValue = requestedPoints / config.points_per_dollar;
    const fee = usdValue * (config.withdrawal_fee_percent / 100);
    const netAmount = usdValue - fee;

    // 5. Create the withdrawal request AND reserve the balance in one go.
    //    Balance is deducted immediately so the same points can't be
    //    used for a second withdrawal request.
    const withdrawal = await supabaseFetch(`withdrawals`, {
      method: "POST",
      body: JSON.stringify({
        user_id: user.id,
        method,
        points: requestedPoints,
        usd_value: usdValue,
        fee,
        net_amount: netAmount,
        wallet_address: walletAddress,
        status: "Pending",
      }),
    });

    await supabaseFetch(`app_users?id=eq.${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        points_balance: user.points_balance - requestedPoints,
        pending_withdrawal: user.pending_withdrawal + requestedPoints,
        [method === "USDT" ? "wallet_usdt" : "wallet_ton"]: walletAddress,
      }),
    });

    return res.status(200).json({
      success: true,
      withdrawal: withdrawal[0],
      usdValue,
      fee,
      netAmount,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
  }
  
