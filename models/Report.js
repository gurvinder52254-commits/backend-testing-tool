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
   * Find all reports belonging to a user
   */
  static async findByUserId(userId) {
    const query = `
      SELECT test_id as "testId", true as "hasReport", user_id as "userId",
             frontend_url as "frontendUrl", test_date as "testDate", 
             overall_score as "overallScore", total_pages as "totalPages", status
      FROM reports
      WHERE user_id = $1
      ORDER BY test_date DESC;
    `;
    const res = await pool.query(query, [userId]);
    return res.rows;
  }

  /**
   * Find single report by ID and user
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
}

module.exports = Report;
