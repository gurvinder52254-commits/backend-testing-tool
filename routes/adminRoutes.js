/**
 * ============================================================
 * routes/adminRoutes.js - Admin APIs for Resource Allocation
 * ============================================================
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

// ── Python Process Manager ────────────────────────────────────
// Tracks spawned Python child processes: Map<serviceId, ChildProcess>
const runningProcesses = new Map();

// Base Python script directory (shared playwright browsers here)
const PYTHON_SCRIPT_DIR = path.resolve(__dirname, '..', '..', 'pythone-Playwright');
const PYTHON_EXE = process.env.PYTHON_EXE ||
    'C:\\Users\\sukhs\\AppData\\Local\\Programs\\Python\\Python311\\python.exe';

// Find a free TCP port starting from `from`
function findFreePort(from = 8003) {
    return new Promise((resolve, reject) => {
        let port = from;
        const tryPort = () => {
            const srv = net.createServer();
            srv.once('error', () => { port++; tryPort(); });
            srv.once('listening', () => { srv.close(() => resolve(port)); });
            srv.listen(port, '127.0.0.1');
        };
        tryPort();
    });
}

function spawnPythonService(port, serviceId) {
    const env = {
        ...process.env,
        PYTHON_SERVICE_PORT: String(port),
        PLAYWRIGHT_BROWSERS_PATH: PYTHON_SCRIPT_DIR,
        PYTHONUTF8: '1'
    };
    const child = spawn(PYTHON_EXE, ['main.py'], { cwd: PYTHON_SCRIPT_DIR, env, stdio: 'pipe' });
    child.stdout.on('data', d => process.stdout.write(`[py:${port}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[py:${port}] ${d}`));
    child.on('exit', (code) => {
        console.log(`[py:${port}] exited with code ${code}`);
        runningProcesses.delete(serviceId);
    });
    runningProcesses.set(serviceId, child);
    return child;
}
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
 * List all users with their mapped services (from junction table)
 */
router.get('/users', async (req, res) => {
    try {
        const query = `
            SELECT u.id, u.email, u.name, u.picture, u.credits, u.subscription_tier,
                   ps.service_url as assigned_service_url
            FROM users u
            LEFT JOIN python_services ps ON ps.id = u.assigned_service_id
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
 * List all registered Python services with assigned users array + default flags
 */
router.get('/services', async (req, res) => {
    try {
        const query = `
            SELECT ps.*,
                   COALESCE(
                     (
                       SELECT json_agg(json_build_object('user_id', u.id, 'email', u.email, 'name', u.name))
                       FROM users u
                       WHERE u.assigned_service_id = ps.id
                     ), '[]'
                   ) as assigned_users
            FROM python_services ps
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

/**
 * GET /api/admin/services/health
 * Live-ping every registered Python service and return real-time status
 */
router.get('/services/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, service_url FROM python_services ORDER BY created_at ASC');
        const services = result.rows;

        const pingService = (url) => new Promise((resolve) => {
            const healthUrl = url.replace(/\/$/, '') + '/api/health';
            const lib = healthUrl.startsWith('https') ? https : http;
            const timeout = setTimeout(() => resolve({ url, alive: false, latencyMs: null }), 5000);
            const start = Date.now();
            try {
                const req = lib.get(healthUrl, (r) => {
                    clearTimeout(timeout);
                    resolve({ url, alive: r.statusCode < 500, latencyMs: Date.now() - start });
                    r.resume();
                });
                req.on('error', () => { clearTimeout(timeout); resolve({ url, alive: false, latencyMs: null }); });
            } catch (_) {
                clearTimeout(timeout);
                resolve({ url, alive: false, latencyMs: null });
            }
        });

        const results = await Promise.all(services.map(s => pingService(s.service_url).then(r => ({ id: s.id, ...r }))));
        res.json({ success: true, health: results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/users/:userId/assign-service
 * Directly assign a dedicated Python service to a user from the User Allocations tab
 */
router.post('/users/:userId/assign-service', async (req, res) => {
    const { userId } = req.params;
    const { service_id } = req.body; // python_services.id

    try {
        if (service_id) {
            // Assign the service directly to the user
            const userUpdate = await pool.query(
                'UPDATE users SET assigned_service_id = $1 WHERE id = $2 RETURNING *',
                [service_id, userId]
            );
            if (userUpdate.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }
            return res.json({ success: true, message: 'Service assigned to user', user: userUpdate.rows[0] });
        }

        // service_id is null/empty => reset user to shared pool
        await pool.query('UPDATE users SET assigned_service_id = NULL WHERE id = $1', [userId]);
        res.json({ success: true, message: 'User reset to shared pool' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/services/:id/set-default
 * Mark a service as the default for 'free' or 'paid' tier.
 * Body: { tier: 'free' | 'paid' }
 * Only one service can be default per tier at a time.
 */
router.post('/services/:id/set-default', async (req, res) => {
    const { id } = req.params;
    const { tier } = req.body; // 'free' or 'paid'

    if (!['free', 'paid'].includes(tier)) {
        return res.status(400).json({ success: false, error: "tier must be 'free' or 'paid'" });
    }

    const col = tier === 'free' ? 'is_default_free' : 'is_default_paid';
    try {
        // Clear existing default for that tier
        await pool.query(`UPDATE python_services SET ${col} = FALSE`);
        // Set new default
        const result = await pool.query(
            `UPDATE python_services SET ${col} = TRUE WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Service not found' });
        }
        res.json({ success: true, message: `Service set as default for ${tier} users`, service: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/services/:id/add-user
 * Add a user to this service via the many-to-many junction table
 * Body: { user_id: string }
 */
router.post('/services/:id/add-user', async (req, res) => {
    const { id } = req.params;
    const { user_id } = req.body;

    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });

    try {
        await pool.query(
            `INSERT INTO service_user_assignments (service_id, user_id)
             VALUES ($1, $2) ON CONFLICT (service_id, user_id) DO NOTHING`,
            [id, user_id]
        );
        res.json({ success: true, message: 'User added to service' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/admin/services/:id/remove-user/:userId
 * Remove a specific user from a service (junction table)
 */
router.delete('/services/:id/remove-user/:userId', async (req, res) => {
    const { id, userId } = req.params;
    try {
        await pool.query(
            'DELETE FROM service_user_assignments WHERE service_id = $1 AND user_id = $2',
            [id, userId]
        );
        res.json({ success: true, message: 'User removed from service' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/services/create
 * Spawn a brand-new Python service on the next free port and register it in the DB
 */
router.post('/services/create', async (req, res) => {
    try {
        const { is_dedicated = false, assigned_user_id = null, label = '' } = req.body;

        // Find next free port (skip 8000-8002 which are the manual ones)
        const port = await findFreePort(8003);
        const serviceUrl = `http://127.0.0.1:${port}`;

        // Register in DB first
        const dbResult = await pool.query(
            `INSERT INTO python_services (service_url, is_dedicated, assigned_user_id, status)
             VALUES ($1, $2, $3, 'starting') RETURNING *`,
            [serviceUrl, is_dedicated, assigned_user_id || null]
        );
        const service = dbResult.rows[0];

        // Spawn the Python process
        spawnPythonService(port, service.id);

        // Give it 3 seconds to start, then mark active
        setTimeout(async () => {
            try {
                await pool.query(
                    `UPDATE python_services SET status = 'active' WHERE id = $1`,
                    [service.id]
                );
            } catch (_) {}
        }, 3000);

        res.status(201).json({
            success: true,
            message: `Python service started on port ${port}`,
            service: { ...service, status: 'starting', port }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/services/:id/stop
 * Stop (kill) a running Python service process
 */
router.post('/services/:id/stop', async (req, res) => {
    const { id } = req.params;
    try {
        const child = runningProcesses.get(parseInt(id));
        if (child) {
            child.kill('SIGTERM');
            runningProcesses.delete(parseInt(id));
        }
        await pool.query(`UPDATE python_services SET status = 'inactive' WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Service stopped' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/services/:id/restart
 * Restart a Python service (kill old, spawn new on same port)
 */
router.post('/services/:id/restart', async (req, res) => {
    const { id } = req.params;
    try {
        // Get the service URL/port
        const svcRes = await pool.query('SELECT * FROM python_services WHERE id = $1', [id]);
        if (svcRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Service not found' });

        const svc = svcRes.rows[0];
        const urlMatch = svc.service_url.match(/:(\d+)$/);
        if (!urlMatch) return res.status(400).json({ success: false, error: 'Cannot parse port from URL' });

        const port = parseInt(urlMatch[1]);

        // Kill existing
        const existing = runningProcesses.get(parseInt(id));
        if (existing) { existing.kill('SIGTERM'); runningProcesses.delete(parseInt(id)); }

        // Wait briefly then respawn
        await pool.query(`UPDATE python_services SET status = 'starting' WHERE id = $1`, [id]);
        setTimeout(() => {
            spawnPythonService(port, parseInt(id));
            setTimeout(async () => {
                try { await pool.query(`UPDATE python_services SET status = 'active' WHERE id = $1`, [id]); } catch (_) {}
            }, 3000);
        }, 1000);

        res.json({ success: true, message: `Restarting service on port ${port}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/admin/services/processes
 * List which service IDs have active spawned processes
 */
router.get('/services/processes', async (req, res) => {
    const activeIds = [...runningProcesses.keys()];
    res.json({ success: true, activeProcessIds: activeIds });
});

module.exports = router;
