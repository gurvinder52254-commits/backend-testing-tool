/**
 * ============================================================
 * models/User.js - User Data Model Mapping
 * ============================================================
 */

const { pool } = require('../config/db');

class User {
  /**
   * Upsert Google profile
   */
  static async upsertUser({ id, email, name, picture }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Check if user exists
      const checkRes = await client.query('SELECT 1 FROM users WHERE id = $1', [id]);
      const isNewUser = checkRes.rows.length === 0;

      let user;
      if (isNewUser) {
        // First-time signup: Default to Free Trial plan with 5 scan credits
        const insertQuery = `
          INSERT INTO users (id, email, name, picture, credits, subscription_tier, updated_at)
          VALUES ($1, $2, $3, $4, 5, 'Free', CURRENT_TIMESTAMP)
          RETURNING *;
        `;
        const insertRes = await client.query(insertQuery, [id, email, name, picture]);
        user = insertRes.rows[0];

        // Log initial credit allocation in transactions ledger
        const txQuery = `
          INSERT INTO credit_transactions (user_id, amount, description)
          VALUES ($1, 5, 'Free Trial Plan Activated: 5 initial scan credits added.');
        `;
        await client.query(txQuery, [id]);
      } else {
        // Existing user: Standard profile metadata update
        const updateQuery = `
          UPDATE users
          SET email = $2, name = $3, picture = $4, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *;
        `;
        const updateRes = await client.query(updateQuery, [id, email, name, picture]);
        user = updateRes.rows[0];
      }

      await client.query('COMMIT');
      return user;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

module.exports = User;
