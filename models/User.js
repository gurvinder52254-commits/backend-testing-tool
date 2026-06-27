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
    const query = `
      INSERT INTO users (id, email, name, picture, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          name = EXCLUDED.name,
          picture = EXCLUDED.picture,
          updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const res = await pool.query(query, [id, email, name, picture]);
    return res.rows[0];
  }
}

module.exports = User;
