const { pool } = require('../config/db');

async function seed() {
    const urls = [
        { url: 'http://127.0.0.1:8000', dedicated: false },
        { url: 'http://127.0.0.1:8001', dedicated: false },
        { url: 'http://127.0.0.1:8002', dedicated: false }
    ];
    
    console.log('🌱 Seeding Python services into database...');
    for (const item of urls) {
        try {
            await pool.query(
                `INSERT INTO python_services (service_url, is_dedicated, status) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (service_url) DO NOTHING`,
                [item.url, item.dedicated, 'active']
            );
            console.log(`✅ Registered: ${item.url}`);
        } catch (e) {
            console.error(`❌ Error inserting ${item.url}:`, e.message);
        }
    }
    console.log('Done!');
    process.exit(0);
}

seed();
