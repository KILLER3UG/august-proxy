const os = require('os');

const startTime = Date.now();

function getSystemStats() {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
        uptime: Math.floor((Date.now() - startTime) / 1000),
        uptimeHuman: formatDuration(Date.now() - startTime),
        memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
            totalSystem: Math.round(totalMem / 1024 / 1024),
            freeSystem: Math.round(freeMem / 1024 / 1024),
            usagePercent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0
        },
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid
    };
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return days + 'd ' + hours + 'h ' + minutes + 'm';
    if (hours > 0) return hours + 'h ' + minutes + 'm';
    if (minutes > 0) return minutes + 'm ' + (seconds % 60) + 's';
    return seconds + 's';
}

module.exports = { getSystemStats };
