const { v4: uuidv4 } = require('uuid');

class ScanQueue {
    constructor(concurrencyLimit = 5) {
        this.concurrencyLimit = concurrencyLimit;
        this.activeCount = 0;
        this.queue = [];
        this.jobs = new Map(); // jobId -> jobState
    }

    addJob(taskFn, data) {
        const jobId = uuidv4().substring(0, 8);
        const job = {
            id: jobId,
            taskFn,
            data,
            state: 'queued', // queued, active, completed, failed
            progress: 0,
            result: null,
            error: null,
            createdAt: new Date().toISOString(),
        };
        this.jobs.set(jobId, job);
        this.queue.push(job);
        console.log(`📥 Job ${jobId} added to scan queue. Queue length: ${this.queue.length}`);
        this.processNext();
        return job;
    }

    getJob(jobId) {
        return this.jobs.get(jobId);
    }

    async processNext() {
        if (this.activeCount >= this.concurrencyLimit || this.queue.length === 0) {
            return;
        }

        const job = this.queue.shift();
        job.state = 'active';
        this.activeCount++;
        console.log(`⚙️ Job ${job.id} started processing. Active scans: ${this.activeCount}/${this.concurrencyLimit}`);

        try {
            const result = await job.taskFn(job.data);
            job.state = 'completed';
            job.result = result;
            console.log(`✅ Job ${job.id} completed successfully.`);
        } catch (err) {
            job.state = 'failed';
            job.error = err.message;
            console.error(`❌ Job ${job.id} failed:`, err.message);
        } finally {
            this.activeCount--;
            console.log(`🔄 Job ${job.id} finished. Active scans: ${this.activeCount}/${this.concurrencyLimit}`);
            this.processNext();
        }
    }
}

// Default to 5 concurrent scans (can be overridden via environment variables)
const concurrencyLimit = parseInt(process.env.CONCURRENCY_LIMIT || '5', 10);
const scanQueueInstance = new ScanQueue(concurrencyLimit);

module.exports = scanQueueInstance;
