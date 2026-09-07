// api/admin-stats.js
//
// Quick overview numbers for the admin panel: how many users the app
// has, and how much has actually been paid out so far.

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
      "Prefer": options.headers && options.headers["Prefer"] ? options.headers["Prefer"] : "count=exact",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  const countHeader = res.headers.get("content-range"); // e.g. "0-0/123"
  const total = countHeader ? Number(countHeader.split("/")[1]) : null;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { body, total };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const key = req.query.key;
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { total: totalUsers } = await supabaseFetch(
      `app_users?select=id&limit=1`,
      { headers: { "Prefer": "count=exact" } }
    );

    const paidWithdrawals = (await supabaseFetch(
      `withdrawals?status=eq.Paid&select=points,net_amount`
    )).body;

    const totalPaidPoints = paidWithdrawals.reduce((sum, w) => sum + w.points, 0);
    const totalPaidUsd = paidWithdrawals.reduce((sum, w) => sum + Number(w.net_amount), 0);

    return res.status(200).json({
      totalUsers,
      totalPaidPoints,
      totalPaidUsd,
      totalPaidCount: paidWithdrawals.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
