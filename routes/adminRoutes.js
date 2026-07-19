/**
 * ============================================================
 * routes/adminRoutes.js - Admin APIs for Resource Allocation
 * ============================================================
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const crypto = require('crypto');
const SESSION_SECRET = process.env.SESSION_SECRET || 'webtest_secret_default_key_123456';

// Get admin credentials from env, or use defaults
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@webtest.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function generateAdminToken(email) {
    const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    const payloadObj = {
        isAdmin: true,
        email: email,
        expiry: expiry
    };
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
    const hmac = crypto.createHmac('sha256', SESSION_SECRET);
    hmac.update(payload);
    const signature = hmac.digest('base64');
    return `webtest_admin_${payload}.${signature}`;
}

function verifyAdminToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Admin authentication required.' });
    }

    const token = authHeader.split(' ')[1];
    if (!token.startsWith('webtest_admin_')) {
        return res.status(401).json({ success: false, error: 'Invalid admin token format' });
    }

    try {
        const tokenParts = token.substring('webtest_admin_'.length).split('.');
        if (tokenParts.length !== 2) {
            throw new Error('Invalid token structure');
        }
        const [payload, signature] = tokenParts;
        const hmac = crypto.createHmac('sha256', SESSION_SECRET);
        hmac.update(payload);
        const expectedSignature = hmac.digest('base64');

        if (signature !== expectedSignature) {
            throw new Error('Invalid token signature');
        }

        const payloadObj = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
        if (Date.now() > payloadObj.expiry) {
            return res.status(401).json({ success: false, error: 'Admin session expired. Please login again.' });
        }

        req.adminEmail = payloadObj.email;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Invalid or expired admin session token.' });
    }
}

/**
 * POST /api/admin/login
 * Standard email & password sign-in for admin panel
 */
router.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    if (email.toLowerCase() === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
        const token = generateAdminToken(email);
        return res.json({
            success: true,
            token,
            user: {
                email: ADMIN_EMAIL,
                name: 'System Administrator'
            }
        });
    }

    return res.status(401).json({ success: false, error: 'Invalid admin email or password' });
});

// Protect all other endpoints using verifyAdminToken middleware
router.use(verifyAdminToken);

/**
 * GET /api/admin/stats
 * Overview of system statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const usersCount = await pool.query('SELECT COUNT(*)::int as count FROM users');
        const reportsCount = await pool.query('SELECT COUNT(*)::int as count FROM reports');
        const servicesCount = await pool.query('SELECT COUNT(*)::int as count FROM python_services');
        const activeServicesCount = await pool.query("SELECT COUNT(*)::int as count FROM python_services WHERE status = 'active'");
        
        const tierBreakdown = await pool.query(
            'SELECT subscription_tier, COUNT(*)::int as count FROM users GROUP BY subscription_tier'
        );

        res.json({
            success: true,
            stats: {
                totalUsers: usersCount.rows[0].count,
                totalScans: reportsCount.rows[0].count,
                totalPythonServices: servicesCount.rows[0].count,
                activePythonServices: activeServicesCount.rows[0].count,
                tiers: tierBreakdown.rows
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/admin/users
 * List all users with their mapped services
 */
router.get('/users', async (req, res) => {
    try {
        const query = `
            SELECT u.id, u.email, u.name, u.picture, u.credits, u.subscription_tier,
                   ps.service_url as assigned_service_url
            FROM users u
            LEFT JOIN python_services ps ON ps.assigned_user_id = u.id
            ORDER BY u.created_at DESC
        `;
        const result = await pool.query(query);
        res.json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * PATCH /api/admin/users/:userId
 * Update user subscription tier or credits
 */
router.patch('/users/:userId', async (req, res) => {
    const { userId } = req.params;
    const { subscription_tier, credits } = req.body;

    try {
        const fields = [];
        const values = [];
        let index = 1;

        if (subscription_tier !== undefined) {
            fields.push(`subscription_tier = $${index++}`);
            values.push(subscription_tier);
        }
        if (credits !== undefined) {
            fields.push(`credits = $${index++}`);
            values.push(parseInt(credits, 10));
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        values.push(userId);
        const query = `
            UPDATE users 
            SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
            WHERE id = $${index}
            RETURNING *
        `;

        const result = await pool.query(query, values);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/admin/services
 * List all registered Python services
 */
router.get('/services', async (req, res) => {
    try {
        const query = `
            SELECT ps.*, u.email as assigned_user_email, u.name as assigned_user_name
            FROM python_services ps
            LEFT JOIN users u ON ps.assigned_user_id = u.id
            ORDER BY ps.is_dedicated DESC, ps.created_at ASC
        `;
        const result = await pool.query(query);
        res.json({ success: true, services: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/services
 * Register a new Python service instance
 */
router.post('/services', async (req, res) => {
    const { service_url, is_dedicated, assigned_user_id, status } = req.body;

    if (!service_url) {
        return res.status(400).json({ success: false, error: 'service_url is required' });
    }

    try {
        const query = `
            INSERT INTO python_services (service_url, is_dedicated, assigned_user_id, status)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `;
        const values = [
            service_url,
            is_dedicated === true || is_dedicated === 'true',
            assigned_user_id || null,
            status || 'active'
        ];
        const result = await pool.query(query, values);
        res.status(201).json({ success: true, service: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ success: false, error: 'Service URL already registered' });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * PATCH /api/admin/services/:id
 * Update Python service configuration or assignment
 */
router.patch('/services/:id', async (req, res) => {
    const { id } = req.params;
    const { service_url, is_dedicated, assigned_user_id, status } = req.body;

    try {
        const fields = [];
        const values = [];
        let index = 1;

        if (service_url !== undefined) {
            fields.push(`service_url = $${index++}`);
            values.push(service_url);
        }
        if (is_dedicated !== undefined) {
            fields.push(`is_dedicated = $${index++}`);
            values.push(is_dedicated === true || is_dedicated === 'true');
        }
        if (assigned_user_id !== undefined) {
            fields.push(`assigned_user_id = $${index++}`);
            values.push(assigned_user_id || null);
        }
        if (status !== undefined) {
            fields.push(`status = $${index++}`);
            values.push(status);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        values.push(id);
        const query = `
            UPDATE python_services
            SET ${fields.join(', ')}
            WHERE id = $${index}
            RETURNING *
        `;

        const result = await pool.query(query, values);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Service not found' });
        }

        res.json({ success: true, service: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/admin/services/:id
 * Remove a registered Python service
 */
router.delete('/services/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM python_services WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Service not found' });
        }
        res.json({ success: true, message: 'Service deleted successfully', service: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
