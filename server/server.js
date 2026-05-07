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
// CPU Temperature via multiple fallbacks
// ==========================================
let cpuTempSource = 'unknown';

/**
 * Try LibreHardwareMonitor WMI namespace.
 * LHM must be running with "Remote Web Server" or WMI enabled.
 * This is the most reliable way to get AMD Ryzen CPU temps.
 */
function getCpuTempLHM() {
    try {
        const output = execSync(
            'powershell -NoProfile -Command "Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop | Where-Object { $_.SensorType -eq \'Temperature\' -and $_.Name -match \'CPU|Core|Tctl|Tdie\' } | Sort-Object -Property Value -Descending | Select-Object -First 1 -ExpandProperty Value"',
            { timeout: 5000, stdio: 'pipe' }
        ).toString().trim();

        const temp = parseFloat(output);
        if (!isNaN(temp) && temp > 0 && temp < 150) {
            return Math.round(temp);
        }
    } catch (e) {
        // LHM not running or WMI not available
    }
    return 0;
}

/**
 * Try OpenHardwareMonitor WMI namespace (older alternative to LHM).
 */
function getCpuTempOHM() {
    try {
        const output = execSync(
            'powershell -NoProfile -Command "Get-CimInstance -Namespace root/OpenHardwareMonitor -ClassName Sensor -ErrorAction Stop | Where-Object { $_.SensorType -eq \'Temperature\' -and $_.Name -match \'CPU|Core\' } | Sort-Object -Property Value -Descending | Select-Object -First 1 -ExpandProperty Value"',
            { timeout: 5000, stdio: 'pipe' }
        ).toString().trim();

        const temp = parseFloat(output);
        if (!isNaN(temp) && temp > 0 && temp < 150) {
            return Math.round(temp);
        }
    } catch (e) {
        // OHM not running
    }
    return 0;
}

/**
 * Try ACPI thermal zone (works on some Intel systems).
 */
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

/**
 * Get CPU temperature, trying multiple sources in order of reliability.
 * Caches which source works to avoid retrying failed sources every poll.
 */
async function getCpuTemp() {
    // 1. systeminformation (works if LHM/OHM is running, or on some Intel systems)
    if (cpuTempSource === 'unknown' || cpuTempSource === 'si') {
        try {
            const cpuTemp = await si.cpuTemperature();
            if (cpuTemp.main && cpuTemp.main > 0) {
                if (cpuTempSource === 'unknown') {
                    cpuTempSource = 'si';
                    console.log('[HW Monitor] CPU temp source: systeminformation');
                }
                return Math.round(cpuTemp.main);
            }
        } catch (e) { /* continue */ }
    }

    // 2. LibreHardwareMonitor WMI
    if (cpuTempSource === 'unknown' || cpuTempSource === 'lhm') {
        const lhmTemp = getCpuTempLHM();
        if (lhmTemp > 0) {
            if (cpuTempSource === 'unknown') {
                cpuTempSource = 'lhm';
                console.log('[HW Monitor] CPU temp source: LibreHardwareMonitor WMI');
            }
            return lhmTemp;
        }
    }

    // 3. OpenHardwareMonitor WMI
    if (cpuTempSource === 'unknown' || cpuTempSource === 'ohm') {
        const ohmTemp = getCpuTempOHM();
        if (ohmTemp > 0) {
            if (cpuTempSource === 'unknown') {
                cpuTempSource = 'ohm';
                console.log('[HW Monitor] CPU temp source: OpenHardwareMonitor WMI');
            }
            return ohmTemp;
        }
    }

    // 4. ACPI WMI (legacy fallback)
    if (cpuTempSource === 'unknown' || cpuTempSource === 'wmi') {
        const wmiTemp = getCpuTempWmi();
        if (wmiTemp > 0) {
            if (cpuTempSource === 'unknown') {
                cpuTempSource = 'wmi';
                console.log('[HW Monitor] CPU temp source: ACPI WMI');
            }
            return wmiTemp;
        }
    }

    // Nothing worked
    if (cpuTempSource === 'unknown') {
        cpuTempSource = 'none';
        console.log('[HW Monitor] ⚠ No CPU temperature source available.');
        console.log('[HW Monitor]   AMD Ryzen CPUs require LibreHardwareMonitor running in the background.');
        console.log('[HW Monitor]   Download: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases');
        console.log('[HW Monitor]   Run LHM as Administrator, then restart this server.');
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

        // CPU temp: try multiple sources
        latestData.cpu_temp = await getCpuTemp();

        // Periodically retry finding a source if none was found
        if (cpuTempSource === 'none' && Date.now() % 30000 < POLL_INTERVAL_MS) {
            cpuTempSource = 'unknown'; // Reset to retry
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
