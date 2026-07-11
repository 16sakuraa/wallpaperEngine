require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
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
    gpu_temp: 0,
    spotify_next: null,
    claude_usage: null
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
 * Try LibreHardwareMonitor's built-in web server (Options → Remote Web Server → Run).
 * Fetches http://localhost:8085/data.json and walks the sensor tree for the CPU temp.
 * More reliable than WMI on newer LHM builds, which don't always register the namespace.
 */
function findLhmCpuTemp(node, underCpu) {
    if (!node) return 0;
    const isCpuNode = underCpu
        || /cpu\.png/i.test(node.ImageURL || '')
        || /ryzen|intel core|core i\d|xeon|threadripper/i.test(node.Text || '');

    let best = 0;
    let bestScore = -1;

    const visit = (n, inCpu) => {
        if (!n) return;
        if (inCpu && typeof n.Value === 'string' && n.Value.includes('°C')) {
            const temp = parseFloat(n.Value);
            if (!isNaN(temp) && temp > 0 && temp < 150) {
                // Prefer the canonical Ryzen/package sensors over individual cores
                let score = 0;
                if (/tctl\/tdie|tctl|tdie/i.test(n.Text || '')) score = 3;
                else if (/package/i.test(n.Text || '')) score = 2;
                else if (/core/i.test(n.Text || '')) score = 1;
                if (score > bestScore || (score === bestScore && temp > best)) {
                    bestScore = score;
                    best = temp;
                }
            }
        }
        if (Array.isArray(n.Children)) {
            const childInCpu = inCpu
                || /cpu\.png/i.test(n.ImageURL || '')
                || /ryzen|intel core|core i\d|xeon|threadripper/i.test(n.Text || '');
            n.Children.forEach(c => visit(c, childInCpu));
        }
    };

    visit(node, isCpuNode);
    return Math.round(best);
}

async function getCpuTempLhmHttp() {
    try {
        const response = await axios.get('http://localhost:8085/data.json', { timeout: 2000 });
        return findLhmCpuTemp(response.data, false);
    } catch (e) {
        return 0;
    }
}

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

    // 2. LibreHardwareMonitor web server (data.json)
    if (cpuTempSource === 'unknown' || cpuTempSource === 'lhm-http') {
        const httpTemp = await getCpuTempLhmHttp();
        if (httpTemp > 0) {
            if (cpuTempSource === 'unknown') {
                cpuTempSource = 'lhm-http';
                console.log('[HW Monitor] CPU temp source: LibreHardwareMonitor web server');
            }
            return httpTemp;
        }
    }

    // 3. LibreHardwareMonitor WMI
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
        console.log('[HW Monitor]   AMD Ryzen CPUs require LibreHardwareMonitor running as Administrator.');
        console.log('[HW Monitor]   In LHM: Options → Remote Web Server → Run (port 8085).');
        console.log('[HW Monitor]   This server retries automatically every 30 seconds.');
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

// ==========================================
// Spotify API Integration
// ==========================================
const spotifyApp = express();
const SPOTIFY_PORT = 8888;
let spotifyAccessToken = '';
let spotifyTokenExpiry = 0;

function updateEnvFile(key, value) {
    try {
        let envContent = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }
        fs.writeFileSync('.env', envContent.trim());
    } catch (e) {
        console.error('[Spotify] Failed to update .env', e);
    }
}

spotifyApp.get('/login', (req, res) => {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
        return res.send('Please configure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first.');
    }
    const scope = 'user-read-playback-state user-read-currently-playing';
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: process.env.SPOTIFY_CLIENT_ID,
            scope: scope,
            redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
        }));
});

spotifyApp.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    if (!code) {
        return res.send('No code provided');
    }

    try {
        const response = await axios({
            method: 'post',
            url: 'https://accounts.spotify.com/api/token',
            data: querystring.stringify({
                code: code,
                redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
                grant_type: 'authorization_code'
            }),
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + (Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64'))
            }
        });

        process.env.SPOTIFY_REFRESH_TOKEN = response.data.refresh_token;
        updateEnvFile('SPOTIFY_REFRESH_TOKEN', response.data.refresh_token);
        
        spotifyAccessToken = response.data.access_token;
        spotifyTokenExpiry = Date.now() + (response.data.expires_in * 1000);

        res.send('Successfully authenticated with Spotify! You can close this window.');
        
        // Immediately fetch queue
        fetchSpotifyNextSong();
    } catch (error) {
        res.send('Error authenticating with Spotify: ' + (error.response ? JSON.stringify(error.response.data) : error.message));
    }
});

spotifyApp.listen(SPOTIFY_PORT, () => {
    console.log(`[Spotify] Auth server running on http://127.0.0.1:${SPOTIFY_PORT}`);
    if (!process.env.SPOTIFY_REFRESH_TOKEN) {
        console.log(`[Spotify] PLEASE LOG IN: http://127.0.0.1:${SPOTIFY_PORT}/login`);
    } else {
        console.log(`[Spotify] Refresh token found, ready to fetch queue.`);
        fetchSpotifyNextSong(); // Initial fetch
    }
});

async function refreshSpotifyToken() {
    if (!process.env.SPOTIFY_REFRESH_TOKEN || !process.env.SPOTIFY_CLIENT_ID) return false;
    
    try {
        const response = await axios({
            method: 'post',
            url: 'https://accounts.spotify.com/api/token',
            data: querystring.stringify({
                grant_type: 'refresh_token',
                refresh_token: process.env.SPOTIFY_REFRESH_TOKEN
            }),
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + (Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64'))
            }
        });

        spotifyAccessToken = response.data.access_token;
        spotifyTokenExpiry = Date.now() + (response.data.expires_in * 1000);
        return true;
    } catch (error) {
        console.error('[Spotify] Error refreshing token:', error.response ? error.response.data : error.message);
        return false;
    }
}

async function fetchSpotifyNextSong() {
    if (!process.env.SPOTIFY_REFRESH_TOKEN) return;

    if (!spotifyAccessToken || Date.now() >= spotifyTokenExpiry - 60000) {
        const refreshed = await refreshSpotifyToken();
        if (!refreshed) return;
    }

    try {
        const response = await axios({
            method: 'get',
            url: 'https://api.spotify.com/v1/me/player/queue',
            headers: { 'Authorization': 'Bearer ' + spotifyAccessToken }
        });

        if (response.data && response.data.queue && response.data.queue.length > 0) {
            const nextTrack = response.data.queue[0];
            latestData.spotify_next = {
                title: nextTrack.name,
                artist: nextTrack.artists.map(a => a.name).join(', '),
                art: nextTrack.album.images.length > 0 ? nextTrack.album.images[0].url : ''
            };
        } else {
            latestData.spotify_next = null;
        }
    } catch (error) {
        if (error.response && error.response.status !== 404 && error.response.status !== 204) {
             console.error('[Spotify] Error fetching queue:', error.response.data);
        }
        latestData.spotify_next = null;
    }
}

setInterval(fetchSpotifyNextSong, 5000); // Fetch queue every 5 seconds

// ==========================================
// Claude Code Usage (rate limit) Integration
// ==========================================
// Reads the Claude Code CLI OAuth token from ~/.claude/.credentials.json
// (created by running `claude` in a terminal and logging in with /login),
// then polls the same usage endpoint that Claude Code's /usage command uses.
// A token can also be supplied directly via CLAUDE_OAUTH_TOKEN in .env.
const CLAUDE_CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code public OAuth client
const CLAUDE_POLL_INTERVAL_MS = 300000; // 5 min — the endpoint rate-limits aggressive polling
const CLAUDE_STALE_MS = 3600000;        // keep showing last data for up to 1h through outages

let claudeNoTokenWarned = false;
let claudeBackoffUntil = 0;

function readClaudeCredentials() {
    try {
        return JSON.parse(fs.readFileSync(CLAUDE_CREDS_PATH, 'utf8'));
    } catch (e) {
        return null;
    }
}

async function refreshClaudeToken(creds) {
    const oauth = creds && creds.claudeAiOauth;
    if (!oauth || !oauth.refreshToken) return null;

    try {
        const response = await axios.post(CLAUDE_TOKEN_URL, {
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: CLAUDE_CLIENT_ID
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });

        const data = response.data;
        creds.claudeAiOauth = {
            ...oauth,
            accessToken: data.access_token,
            refreshToken: data.refresh_token || oauth.refreshToken,
            expiresAt: Date.now() + (data.expires_in * 1000)
        };
        // Write back so Claude Code keeps working with the rotated token
        fs.writeFileSync(CLAUDE_CREDS_PATH, JSON.stringify(creds, null, 2));
        console.log('[Claude] Refreshed OAuth token.');
        return creds.claudeAiOauth.accessToken;
    } catch (e) {
        console.error('[Claude] Token refresh failed:', e.response ? e.response.status : e.message);
        return null;
    }
}

async function getClaudeToken() {
    if (process.env.CLAUDE_OAUTH_TOKEN) return process.env.CLAUDE_OAUTH_TOKEN;

    const creds = readClaudeCredentials();
    const oauth = creds && creds.claudeAiOauth;
    if (!oauth || !oauth.accessToken) {
        if (!claudeNoTokenWarned) {
            claudeNoTokenWarned = true;
            console.log('[Claude] No OAuth token found.');
            console.log('[Claude]   Run `claude` in a terminal and log in with /login,');
            console.log('[Claude]   or set CLAUDE_OAUTH_TOKEN in .env.');
        }
        return null;
    }

    // Refresh if the token expires within 5 minutes
    if (oauth.expiresAt && Date.now() >= oauth.expiresAt - 300000) {
        const refreshed = await refreshClaudeToken(creds);
        if (refreshed) return refreshed;
        // Fall through — Claude Code itself may have refreshed the file since
        const reread = readClaudeCredentials();
        if (reread && reread.claudeAiOauth && reread.claudeAiOauth.expiresAt > Date.now()) {
            return reread.claudeAiOauth.accessToken;
        }
        return null;
    }

    return oauth.accessToken;
}

function normalizeClaudeWindow(w) {
    if (!w || typeof w.utilization !== 'number') return null;
    return {
        pct: Math.max(0, Math.min(100, Math.round(w.utilization))),
        resets_at: w.resets_at || null
    };
}

function normalizeClaudeLimit(l, label) {
    if (!l || typeof l.percent !== 'number') return null;
    return {
        pct: Math.max(0, Math.min(100, Math.round(l.percent))),
        resets_at: l.resets_at || null,
        label: label || null
    };
}

function claudeHasFreshData() {
    return latestData.claude_usage && latestData.claude_usage.ok
        && (Date.now() - latestData.claude_usage.updated_at) < CLAUDE_STALE_MS;
}

async function fetchClaudeUsage() {
    if (Date.now() < claudeBackoffUntil) return;

    const token = await getClaudeToken();
    if (!token) {
        if (!claudeHasFreshData()) {
            latestData.claude_usage = { ok: false, error: 'no_token' };
        }
        return;
    }

    try {
        const response = await axios.get(CLAUDE_USAGE_URL, {
            headers: {
                'Authorization': 'Bearer ' + token,
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        const d = response.data || {};

        // Prefer the richer `limits` array (has per-model scoped limits);
        // fall back to the flat five_hour/seven_day fields.
        const limits = Array.isArray(d.limits) ? d.limits : [];
        const sessionLimit = limits.find(l => l.kind === 'session');
        const weeklyLimit = limits.find(l => l.kind === 'weekly_all');
        const scopedLimit = limits.find(l => l.kind === 'weekly_scoped');
        const scopedLabel = scopedLimit && scopedLimit.scope && scopedLimit.scope.model
            ? scopedLimit.scope.model.display_name : null;

        latestData.claude_usage = {
            ok: true,
            session: normalizeClaudeLimit(sessionLimit) || normalizeClaudeWindow(d.five_hour),
            weekly: normalizeClaudeLimit(weeklyLimit) || normalizeClaudeWindow(d.seven_day),
            weekly_scoped: normalizeClaudeLimit(scopedLimit, scopedLabel) || normalizeClaudeWindow(d.seven_day_opus),
            updated_at: Date.now()
        };
    } catch (e) {
        const status = e.response ? e.response.status : null;
        console.error('[Claude] Usage fetch failed:', status || e.message);

        if (status === 429) {
            // Respect Retry-After if present, otherwise back off 15 minutes
            const retryAfter = e.response && parseInt(e.response.headers['retry-after'], 10);
            claudeBackoffUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 900000);
            console.error('[Claude] Rate limited — backing off until ' + new Date(claudeBackoffUntil).toLocaleTimeString());
        }

        // Only surface the error if we have no recent data to keep showing
        if (!claudeHasFreshData()) {
            latestData.claude_usage = { ok: false, error: status === 401 ? 'unauthorized' : 'fetch_failed' };
        }
    }
}

setInterval(fetchClaudeUsage, CLAUDE_POLL_INTERVAL_MS);
fetchClaudeUsage();
