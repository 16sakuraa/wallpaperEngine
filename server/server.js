const WebSocket = require('ws');
const si = require('systeminformation');
const { execSync } = require('child_process');

const PORT = 3985;
const POLL_INTERVAL_MS = 2000;

const wss = new WebSocket.Server({ port: PORT });

console.log(`[HW Monitor] WebSocket server running on ws://localhost:${PORT}`);
console.log(`[HW Monitor] Polling hardware every ${POLL_INTERVAL_MS / 1000}s`);
console.log('[HW Monitor] Press Ctrl+C to stop.\n');

let latestData = {
    cpu_usage: 0,
    cpu_temp: 0,
    gpu_usage: 0,
    gpu_temp: 0
};

wss.on('connection', (ws) => {
    console.log('[HW Monitor] Wallpaper connected.');
    ws.send(JSON.stringify(latestData));
    ws.on('close', () => {
        console.log('[HW Monitor] Wallpaper disconnected.');
    });
});

function broadcast(data) {
    const json = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(json);
        }
    });
}

// ==========================================
// NVIDIA GPU via nvidia-smi (more reliable)
// ==========================================
let nvidiaSmiPath = null;
let nvidiaSmiChecked = false;

function findNvidiaSmi() {
    if (nvidiaSmiChecked) return nvidiaSmiPath;
    nvidiaSmiChecked = true;

    const paths = [
        'nvidia-smi',
        'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
        'C:\\Windows\\System32\\nvidia-smi.exe'
    ];

    for (const p of paths) {
        try {
            execSync(`"${p}" --query-gpu=temperature.gpu --format=csv,noheader,nounits`, {
                timeout: 3000,
                stdio: 'pipe'
            });
            nvidiaSmiPath = p;
            console.log(`[HW Monitor] Found nvidia-smi at: ${p}`);
            return p;
        } catch (e) {
            // Try next path
        }
    }

    console.log('[HW Monitor] nvidia-smi not found. GPU data may be limited.');
    return null;
}

function getNvidiaGpuData() {
    const smiPath = findNvidiaSmi();
    if (!smiPath) return null;

    try {
        const output = execSync(
            `"${smiPath}" --query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader,nounits`,
            { timeout: 3000, stdio: 'pipe' }
        ).toString().trim();

        // If there are multiple GPUs, take the first one that has data (usually the discrete one)
        const lines = output.split('\n');
        for (const line of lines) {
            const parts = line.split(',').map(s => parseInt(s.trim(), 10));
            if (!isNaN(parts[0]) && parts[0] > 0) {
                return {
                    temp: parts[0],
                    util: isNaN(parts[1]) ? 0 : parts[1]
                };
            }
        }
    } catch (e) {
        // Ignore errors
    }
    return null;
}

// ==========================================
// CPU Temperature via WMI (run as best-effort)
// ==========================================
function getCpuTempWmi() {
    try {
        const output = execSync(
            'wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature 2>nul',
            { timeout: 3000, stdio: 'pipe' }
        ).toString().trim();

        // Parse the output — skip the header line, grab the first number
        const lines = output.split('\n').map(l => l.trim()).filter(l => /^\d+$/.test(l));
        if (lines.length > 0) {
            const rawValue = parseInt(lines[0], 10);
            // WMI returns tenths of Kelvin — convert to Celsius
            const celsius = Math.round((rawValue / 10) - 273.15);
            if (celsius > 0 && celsius < 150) return celsius;
        }
    } catch (e) {
        // WMI not available
    }
    return 0;
}

// ==========================================
// Poll hardware data
// ==========================================
async function pollHardware() {
    try {
        // CPU usage via systeminformation (this always works)
        const cpuLoad = await si.currentLoad();
        latestData.cpu_usage = Math.round(cpuLoad.currentLoad || 0);

        // CPU temp: try systeminformation first, fall back to WMI
        const cpuTemp = await si.cpuTemperature();
        if (cpuTemp.main && cpuTemp.main > 0) {
            latestData.cpu_temp = Math.round(cpuTemp.main);
        } else {
            latestData.cpu_temp = getCpuTempWmi();
        }

        // GPU: use nvidia-smi directly
        const gpuData = getNvidiaGpuData();
        if (gpuData) {
            latestData.gpu_temp = gpuData.temp;
            latestData.gpu_usage = gpuData.util;
        } else {
            // Fallback to systeminformation if nvidia-smi fails
            const siGpu = await si.graphics();
            const validGpu = siGpu.controllers.find(c => c.temperatureGpu > 0 || c.utilizationGpu > 0);
            if (validGpu) {
                latestData.gpu_temp = Math.round(validGpu.temperatureGpu || 0);
                latestData.gpu_usage = Math.round(validGpu.utilizationGpu || 0);
            }
        }

        broadcast(latestData);

    } catch (err) {
        console.error('[HW Monitor] Error polling hardware:', err.message);
    }
}

setInterval(pollHardware, POLL_INTERVAL_MS);
pollHardware();

process.on('SIGINT', () => {
    console.log('\n[HW Monitor] Shutting down...');
    wss.close();
    process.exit(0);
});
