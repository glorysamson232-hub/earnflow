// api/complete-task.js
//
// This runs on Vercel's server, not in the browser — so it's the only
// place allowed to actually credit points. The frontend calls this
// endpoint instead of touching the database directly.

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { telegramId, taskId } = req.body;
    if (!telegramId || !taskId) {
      return res.status(400).json({ error: "telegramId and taskId are required" });
    }

    // 1. Look up the user
    const users = await supabaseFetch(`app_users?telegram_id=eq.${telegramId}&select=*`);
    if (!users.length) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = users[0];

    if (user.is_flagged) {
      return res.status(403).json({ error: "Account is flagged for review" });
    }

    // 2. Look up the task and confirm it's active
    const tasks = await supabaseFetch(`tasks?id=eq.${taskId}&active=eq.true&select=*`);
    if (!tasks.length) {
      return res.status(404).json({ error: "Task not found or inactive" });
    }
    const task = tasks[0];

    // 3. Check it hasn't already been completed (DB also enforces this
    //    with a unique constraint, but we check first for a clean error)
    const existing = await supabaseFetch(
      `task_completions?user_id=eq.${user.id}&task_id=eq.${taskId}&select=id`
    );
    if (existing.length) {
      return res.status(409).json({ error: "Task already completed" });
    }

    // 4. Record the completion
    await supabaseFetch(`task_completions`, {
      method: "POST",
      body: JSON.stringify({ user_id: user.id, task_id: taskId }),
    });

    // 5. Credit the points (server-computed, never trust a client-sent amount)
    const newBalance = user.points_balance + task.reward;
    const newTotalEarned = user.total_earned + task.reward;
    await supabaseFetch(`app_users?id=eq.${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        points_balance: newBalance,
        total_earned: newTotalEarned,
      }),
    });

    // 6. If this user was referred by someone, bump the referrer's
    //    qualification progress and pay out if they just qualified.
    const referralRows = await supabaseFetch(
      `referrals?referred_id=eq.${user.id}&qualified=eq.false&select=*`
    );
    if (referralRows.length) {
      const referral = referralRows[0];

      const config = (await supabaseFetch(`admin_config?id=eq.1&select=*`))[0];
      const tasksCompleted = referral.tasks_completed + 1;
      const nowQualifies = tasksCompleted >= config.referral_qualification_tasks;

      if (nowQualifies) {
        // Work out which commission tier the referrer is currently on
        const qualifiedCountRows = await supabaseFetch(
          `referrals?referrer_id=eq.${referral.referrer_id}&qualified=eq.true&select=id`
        );
        const nextTierPosition = qualifiedCountRows.length + 1;
        const tiers = await supabaseFetch(
          `referral_tiers?min_ref=lte.${nextTierPosition}&max_ref=gte.${nextTierPosition}&select=*`
        );
        const reward = tiers.length ? tiers[0].reward : 0;

        await supabaseFetch(`referrals?id=eq.${referral.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            tasks_completed: tasksCompleted,
            qualified: true,
            qualified_at: new Date().toISOString(),
          }),
        });

        const referrer = (
          await supabaseFetch(`app_users?id=eq.${referral.referrer_id}&select=*`)
        )[0];
        await supabaseFetch(`app_users?id=eq.${referral.referrer_id}`, {
          method: "PATCH",
          body: JSON.stringify({
            points_balance: referrer.points_balance + reward,
            total_earned: referrer.total_earned + reward,
            total_referral_earnings: referrer.total_referral_earnings + reward,
          }),
        });
      } else {
        await supabaseFetch(`referrals?id=eq.${referral.id}`, {
          method: "PATCH",
          body: JSON.stringify({ tasks_completed: tasksCompleted }),
        });
      }
    }

    return res.status(200).json({
      success: true,
      pointsEarned: task.reward,
      newBalance,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
