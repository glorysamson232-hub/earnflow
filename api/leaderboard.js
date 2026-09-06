// api/leaderboard.js
//
// Public endpoint — no secret needed, since a leaderboard is meant to
// be seen by everyone. Only exposes display name and total earned,
// never wallet addresses, telegram IDs, or anything sensitive.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const rows = await supabaseFetch(
      `app_users?select=display_name,total_earned&order=total_earned.desc&limit=20`
    );
    return res.status(200).json({
      leaderboard: rows.map((r, i) => ({
        rank: i + 1,
        displayName: r.display_name || "Anonymous",
        totalEarned: r.total_earned,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
