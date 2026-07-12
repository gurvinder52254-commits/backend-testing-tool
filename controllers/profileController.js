const { pool } = require('../config/db');

/**
 * GET /api/profile/info
 * Retrieves user profile details, database metrics, and subscription credits.
 */
async function getProfileInfo(req, res) {
  const userId = req.userId;

  try {
    // 1. Fetch user credit details
    const userRes = await pool.query(
      'SELECT credits, subscription_tier as "subscriptionTier", subscription_expires_at as "subscriptionExpiresAt" FROM users WHERE id = $1',
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const userData = userRes.rows[0];

    // 2. Fetch reports statistics filtered by plan history limits
    const Report = require('../models/Report');
    const interval = await Report.getHistoryInterval(userId);

    const statsRes = await pool.query(
      `SELECT 
         COUNT(*)::int as "totalScans",
         COUNT(CASE WHEN status = 'complete' THEN 1 END)::int as "completedScans",
         COUNT(CASE WHEN status = 'complete' AND overall_score >= 80 THEN 1 END)::int as "healthyScans",
         COALESCE(ROUND(AVG(overall_score)), 0)::int as "avgScore"
       FROM reports 
       WHERE user_id = $1 AND test_date >= CURRENT_DATE - CAST($2 AS INTERVAL)`,
      [userId, interval]
    );

    const stats = statsRes.rows[0];
    const totalScans = stats.totalScans || 0;
    const completedScans = stats.completedScans || 0;
    const healthyScans = stats.healthyScans || 0;
    const healthyRatio = completedScans > 0 ? Math.round((healthyScans / completedScans) * 100) : 100;

    // Fetch monthScans count (scans in current calendar month)
    const monthScansRes = await pool.query(
      `SELECT COUNT(*)::int as count FROM reports WHERE user_id = $1 AND test_date >= date_trunc('month', CURRENT_DATE)`,
      [userId]
    );
    const currentMonthScans = monthScansRes.rows[0].count || 0;

    // Fetch unique domains count
    const domainsRes = await pool.query(
      `SELECT COUNT(DISTINCT (
        CASE 
          WHEN frontend_url LIKE 'http%' THEN 
            replace(split_part(frontend_url, '/', 3), 'www.', '')
          ELSE 
            replace(frontend_url, 'www.', '')
        END
      ))::int as count FROM reports WHERE user_id = $1`,
      [userId]
    );
    const uniqueDomainsCount = domainsRes.rows[0].count || 0;

    // Fetch total URLs tested (all-time, for Free plan 5-URL ceiling tracking)
    const totalUrlsRes = await pool.query(
      `SELECT COALESCE(SUM(total_pages), 0)::int as count FROM reports WHERE user_id = $1 AND status != 'failed'`,
      [userId]
    );
    const totalUrlsTested = totalUrlsRes.rows[0].count || 0;

    res.json({
      success: true,
      profile: {
        id: userId,
        email: req.userEmail || '',
        name: req.userName || '',
        picture: req.userPicture || '',
        credits: userData.credits,
        subscriptionTier: userData.subscriptionTier,
        subscriptionExpiresAt: userData.subscriptionExpiresAt,
      },
      stats: {
        totalScans,
        completedScans,
        avgScore: stats.avgScore,
        healthyRatio,
        currentMonthScans,
        uniqueDomainsCount,
        totalUrlsTested
      }
    });
  } catch (err) {
    console.error('Error fetching profile info:', err.message);
    res.status(500).json({ success: false, error: 'Server error: ' + err.message });
  }
}

/**
 * GET /api/profile/credits-history
 * Retrieves paginated logs of credit transactions (ledger audit trail).
 */
async function getCreditsHistory(req, res) {
  const userId = req.userId;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const offset = (page - 1) * limit;

  try {
    const countRes = await pool.query(
      'SELECT COUNT(*)::int as count FROM credit_transactions WHERE user_id = $1',
      [userId]
    );
    const totalCount = countRes.rows[0].count;

    const listRes = await pool.query(
      `SELECT id, amount, description, created_at as "createdAt"
       FROM credit_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json({
      success: true,
      transactions: listRes.rows,
      totalCount,
      page,
      limit,
      hasNextPage: page * limit < totalCount,
    });
  } catch (err) {
    console.error('Error fetching credit history:', err.message);
    res.status(500).json({ success: false, error: 'Server error: ' + err.message });
  }
}

/**
 * POST /api/profile/credits/mock-add
 * Mock utility endpoint to buy/add credits or update billing tier for testing.
 */
async function addCreditsMock(req, res) {
  const userId = req.userId;
  const { amount, tier } = req.body || {};

  if (!amount && !tier) {
    return res.status(400).json({ success: false, error: 'amount or tier is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let responseMessage = '';

    if (amount) {
      // 1. Increment user credits
      const updateRes = await client.query(
        'UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits',
        [amount, userId]
      );

      // 2. Log in ledger
      await client.query(
        'INSERT INTO credit_transactions (user_id, amount, description) VALUES ($1, $2, $3)',
        [userId, amount, `Purchased/Added ${amount} mock scan credits`]
      );

      responseMessage = `Successfully added ${amount} credits (New total: ${updateRes.rows[0].credits}).`;
    }

    if (tier) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30-day billing cycle

      await client.query(
        'UPDATE users SET subscription_tier = $1, subscription_expires_at = $2 WHERE id = $3',
        [tier, expiresAt, userId]
      );

      // Log subscription change to ledger
      let creditBonus = 0;
      if (tier === 'Basic') creditBonus = 50;
      else if (tier === 'Pro') creditBonus = 200;
      else if (tier === 'Business') creditBonus = 1000;

      if (creditBonus > 0) {
        await client.query(
          'UPDATE users SET credits = credits + $1 WHERE id = $2',
          [creditBonus, userId]
        );
        await client.query(
          'INSERT INTO credit_transactions (user_id, amount, description) VALUES ($1, $2, $3)',
          [userId, creditBonus, `Upgraded to ${tier} Subscription (Bonus ${creditBonus} credits added)`]
        );
      } else {
        await client.query(
          'INSERT INTO credit_transactions (user_id, amount, description) VALUES ($1, 0, $2)',
          [userId, `Upgraded to ${tier} Subscription (No credit changes)`]
        );
      }

      responseMessage += ` Upgraded to ${tier} tier expiring on ${expiresAt.toDateString()}.`;
    }

    await client.query('COMMIT');
    res.json({ success: true, message: responseMessage.trim() });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error adding mock credits:', err.message);
    res.status(500).json({ success: false, error: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
}

module.exports = {
  getProfileInfo,
  getCreditsHistory,
  addCreditsMock,
};
