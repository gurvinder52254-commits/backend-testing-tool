/**
 * ============================================================
 * models/Report.js - Report Data Model Mapping
 * ============================================================
 */

const { pool } = require('../config/db');

class Report {
  /**
   * Insert or update a scan report
   */
  static async upsertReport({
    testId,
    userId,
    frontendUrl,
    backendUrl,
    testDate,
    overallScore,
    totalPages,
    status,
    reportData
  }) {
    const query = `
      INSERT INTO reports (
        test_id, user_id, frontend_url, backend_url, test_date, 
        overall_score, total_pages, status, report_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (test_id) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          frontend_url = EXCLUDED.frontend_url,
          backend_url = EXCLUDED.backend_url,
          test_date = EXCLUDED.test_date,
          overall_score = EXCLUDED.overall_score,
          total_pages = EXCLUDED.total_pages,
          status = EXCLUDED.status,
          report_data = EXCLUDED.report_data
      RETURNING *;
    `;
    const res = await pool.query(query, [
      testId,
      userId,
      frontendUrl,
      backendUrl,
      testDate,
      overallScore,
      totalPages,
      status,
      JSON.stringify(reportData)
    ]);
    return res.rows[0];
  }

  /**
   * Helper to retrieve historical retention interval for a user based on tier
   */
  static async getHistoryInterval(userId) {
    try {
      const userRes = await pool.query('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
      const tier = userRes.rows[0]?.subscription_tier || 'Free';
      if (tier === 'Basic') return '30 days';
      if (tier === 'Pro') return '90 days';
      if (tier === 'Business') return '365 days';
      return '7 days'; // Free Trial
    } catch (e) {
      return '7 days';
    }
  }

  /**
   * Find all reports belonging to a user matching plan retention limits
   */
  static async findByUserId(userId) {
    const interval = await this.getHistoryInterval(userId);
    const query = `
      SELECT test_id as "testId", true as "hasReport", user_id as "userId",
             frontend_url as "frontendUrl", test_date as "testDate", 
             overall_score as "overallScore", total_pages as "totalPages", status
      FROM reports
      WHERE user_id = $1 AND test_date >= CURRENT_DATE - CAST($2 AS INTERVAL)
      ORDER BY test_date DESC;
    `;
    const res = await pool.query(query, [userId, interval]);
    return res.rows;
  }

  /**
   * Find reports with LIMIT/OFFSET pagination matching plan retention limits
   */
  static async findByUserIdPaginated(userId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const interval = await this.getHistoryInterval(userId);
    const query = `
      SELECT test_id as "testId", true as "hasReport", user_id as "userId",
             frontend_url as "frontendUrl", test_date as "testDate",
             overall_score as "overallScore", total_pages as "totalPages", status
      FROM reports
      WHERE user_id = $1 AND test_date >= CURRENT_DATE - CAST($2 AS INTERVAL)
      ORDER BY test_date DESC
      LIMIT $3 OFFSET $4;
    `;
    const res = await pool.query(query, [userId, interval, limit, offset]);
    return res.rows;
  }

  /**
   * Count total reports for a user within plan retention limits
   */
  static async countByUserId(userId) {
    const interval = await this.getHistoryInterval(userId);
    const query = `
      SELECT COUNT(*)::int as count 
      FROM reports 
      WHERE user_id = $1 AND test_date >= CURRENT_DATE - CAST($2 AS INTERVAL);
    `;
    const res = await pool.query(query, [userId, interval]);
    return res.rows[0].count;
  }

  /**
   * Find single report by ID and user — returns full report_data
   */
  static async findById(testId, userId) {
    const query = `
      SELECT report_data
      FROM reports
      WHERE test_id = $1 AND user_id = $2;
    `;
    const res = await pool.query(query, [testId, userId]);
    if (res.rows.length === 0) return null;
    return res.rows[0].report_data;
  }

  /**
   * Find only the pages array for a report with pagination
   * Returns a slice of report_data->pages with total count
   */
  static async findPagesByTestId(testId, userId, page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    // Extract total count of pages and a paginated slice from the JSONB pages array
    const query = `
      SELECT
        jsonb_array_length(report_data->'pages') as "totalPages",
        (
          SELECT jsonb_agg(elem)
          FROM (
            SELECT elem
            FROM jsonb_array_elements(report_data->'pages') WITH ORDINALITY AS t(elem, idx)
            ORDER BY idx
            LIMIT $3 OFFSET $4
          ) sub
        ) as pages
      FROM reports
      WHERE test_id = $1 AND user_id = $2;
    `;
    const res = await pool.query(query, [testId, userId, limit, offset]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }
}

module.exports = Report;
