// ==========================================
// Clock Logic (24-hour format)
// ==========================================
function updateTime() {
    const timeString = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
    });

    document.getElementById('time').textContent = timeString;
    document.getElementById('time-red').textContent = timeString;
    document.getElementById('time-green').textContent = timeString;
    document.getElementById('time-blue').textContent = timeString;

    const dateString = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: '2-digit'
    });
    document.getElementById('date-text').textContent = dateString;
}

setInterval(updateTime, 1000);
updateTime();

// ==========================================
// Media Integration Logic
// ==========================================
window.wallpaperRegisterMediaPropertiesListener = window.wallpaperRegisterMediaPropertiesListener || function() {};
window.wallpaperRegisterMediaThumbnailListener = window.wallpaperRegisterMediaThumbnailListener || function() {};
window.wallpaperRegisterMediaTimelineListener = window.wallpaperRegisterMediaTimelineListener || function() {};

let currentSyncedLyrics = [];
let weatherUnit = "celsius";

window.wallpaperRegisterMediaPropertiesListener((event) => {
    const titleEl = document.getElementById('track-title');
    const artistEl = document.getElementById('track-artist');
    const lyricsEl = document.getElementById('lyrics-content');

    if (event && event.title) {
        const oldTitle = titleEl.textContent;
        titleEl.textContent = event.title;
        artistEl.textContent = event.artist || "Unknown Artist";

        if (event.title !== oldTitle) {
            fetchLyrics(event.title, event.artist);
        }
    } else {
        titleEl.textContent = "No Track Playing";
        artistEl.textContent = "Waiting for media...";
        lyricsEl.innerHTML = "";
        currentSyncedLyrics = [];
        document.getElementById('time-current').textContent = "0:00";
        document.getElementById('time-total').textContent = "0:00";
        document.getElementById('progress-bar').style.width = "0%";
    }
});

async function fetchLyrics(title, artist) {
    const lyricsEl = document.getElementById('lyrics-content');
    lyricsEl.innerHTML = '<div class="lyric-line active">Searching...</div>';
    currentSyncedLyrics = [];
    
    try {
        const cleanTitle = title.split('(')[0].split('-')[0].trim();
        const cleanArtist = (artist || "").split(',')[0].split('feat')[0].trim();

        const response = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(cleanArtist)}&track_name=${encodeURIComponent(cleanTitle)}`);
        
        if (response.ok) {
            const data = await response.json();
            
            if (data.syncedLyrics) {
                currentSyncedLyrics = data.syncedLyrics.split('\n').map(line => {
                    const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
                    if (match) {
                        const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
                        return { time, text: match[3].trim() };
                    }
                    return null;
                }).filter(l => l && l.text);
                renderLyrics(currentSyncedLyrics);
            } else if (data.plainLyrics) {
                lyricsEl.innerHTML = `<div class="lyric-line active">${data.plainLyrics}</div>`;
            } else {
                lyricsEl.innerHTML = '<div class="lyric-line">No lyrics found.</div>';
            }
        } else {
            lyricsEl.innerHTML = '<div class="lyric-line">No lyrics found.</div>';
        }
    } catch (e) {
        lyricsEl.innerHTML = "";
    }
}

function renderLyrics(lyrics) {
    const lyricsEl = document.getElementById('lyrics-content');
    lyricsEl.innerHTML = lyrics.map((l, i) => `<div class="lyric-line" id="lyric-${i}">${l.text}</div>`).join('');
}

window.wallpaperRegisterMediaTimelineListener((event) => {
    // Update Progress Bar
    const currentEl = document.getElementById('time-current');
    const totalEl = document.getElementById('time-total');
    const barEl = document.getElementById('progress-bar');
    
    if (event && event.duration > 0) {
        const formatTime = (timeInSeconds) => {
            const minutes = Math.floor(timeInSeconds / 60);
            const seconds = Math.floor(timeInSeconds % 60).toString().padStart(2, '0');
            return `${minutes}:${seconds}`;
        };
        
        currentEl.textContent = formatTime(event.position);
        totalEl.textContent = formatTime(event.duration);
        
        const progressPct = (event.position / event.duration) * 100;
        barEl.style.width = `${progressPct}%`;
    } else {
        currentEl.textContent = "0:00";
        totalEl.textContent = "0:00";
        barEl.style.width = "0%";
    }

    if (!currentSyncedLyrics.length) return;
    const position = event.position;
    
    let activeIndex = 0;
    for (let i = 0; i < currentSyncedLyrics.length; i++) {
        if (position >= currentSyncedLyrics[i].time) {
            activeIndex = i;
        } else {
            break;
        }
    }

    const lines = document.querySelectorAll('.lyric-line');
    const container = document.getElementById('lyrics-section');
    
    lines.forEach((line, i) => {
        if (i === activeIndex) {
            if (!line.classList.contains('active')) {
                line.classList.add('active');
                const offset = line.offsetTop - (container.offsetHeight / 2) + (line.offsetHeight / 2);
                container.scrollTo({ top: offset, behavior: 'smooth' });
            }
        } else {
            line.classList.remove('active');
        }
    });
});

window.wallpaperRegisterMediaThumbnailListener((event) => {
    const imgElement = document.getElementById('album-art');

    if (event && event.thumbnail) {
        imgElement.style.opacity = 0;
        setTimeout(() => {
            imgElement.src = event.thumbnail;
            imgElement.style.opacity = 1;
        }, 200);
    } else {
        imgElement.style.opacity = 0;
        setTimeout(() => {
            imgElement.src = "assets/default_art.jpg";
            imgElement.style.opacity = 1;
        }, 200);
    }
});

// ==========================================
// Custom Background & Draggable Logic
// ==========================================
const bgLayer = document.getElementById('background-layer');

let bgOffsetX = parseFloat(localStorage.getItem('we_bgOffsetX')) || 50;
let bgOffsetY = parseFloat(localStorage.getItem('we_bgOffsetY')) || 50;
let bgScale = 100;

function updateBackgroundStyle() {
    bgLayer.style.backgroundPosition = `${bgOffsetX}% ${bgOffsetY}%`;
    bgLayer.style.backgroundSize = `${bgScale}%`;
}

updateBackgroundStyle();

// ==========================================
// Wallpaper Engine Property Listener
// ==========================================
window.wallpaperPropertyListener = {
    applyUserProperties: function(properties) {
        // Background Image
        if (properties.bgimage) {
            if (properties.bgimage.value) {
                const imagePath = 'file:///' + properties.bgimage.value;
                bgLayer.style.backgroundImage = `url('${imagePath}')`;
            } else {
                bgLayer.style.backgroundImage = "none";
            }
        }

        // Background Scale
        if (properties.bgscale) {
            bgScale = properties.bgscale.value;
            updateBackgroundStyle();
        }

        // Background Position
        if (properties.bg_x) {
            bgOffsetX = properties.bg_x.value;
            updateBackgroundStyle();
        }
        if (properties.bg_y) {
            bgOffsetY = properties.bg_y.value;
            updateBackgroundStyle();
        }

        // Background Color
        if (properties.bgcolor) {
            const colorParts = properties.bgcolor.value.split(' ');
            const r = Math.ceil(colorParts[0] * 255);
            const g = Math.ceil(colorParts[1] * 255);
            const b = Math.ceil(colorParts[2] * 255);
            document.documentElement.style.setProperty('--bg-color', `rgb(${r}, ${g}, ${b})`);
        }

        // Text Color
        if (properties.textcolor) {
            const colorParts = properties.textcolor.value.split(' ');
            const r = Math.ceil(colorParts[0] * 255);
            const g = Math.ceil(colorParts[1] * 255);
            const b = Math.ceil(colorParts[2] * 255);
            const colorStr = `rgb(${r}, ${g}, ${b})`;
            const subColorStr = `rgba(${r}, ${g}, ${b}, 0.7)`;

            document.documentElement.style.setProperty('--text-color', colorStr);
            document.documentElement.style.setProperty('--text-color-sub', subColorStr);
        }

        // Effect Color
        if (properties.effect_color) {
            const colorParts = properties.effect_color.value.split(' ');
            const r = Math.ceil(colorParts[0] * 255);
            const g = Math.ceil(colorParts[1] * 255);
            const b = Math.ceil(colorParts[2] * 255);
            document.documentElement.style.setProperty('--effect-color', `rgb(${r}, ${g}, ${b})`);
            document.documentElement.style.setProperty('--effect-color-rgb', `${r}, ${g}, ${b}`);
        }

        // Background Video
        if (properties.bgvideo) {
            const videoEl = document.getElementById('background-video');
            if (properties.bgvideo.value) {
                videoEl.src = 'file:///' + properties.bgvideo.value;
                videoEl.style.display = 'block';
                videoEl.play();
                bgLayer.style.opacity = '0'; // Hide image layer if video is present
            } else {
                videoEl.pause();
                videoEl.src = '';
                videoEl.style.display = 'none';
                bgLayer.style.opacity = '1';
            }
        }

        // Clock Position & Size
        if (properties.clock_x) {
            document.documentElement.style.setProperty('--clock-x', properties.clock_x.value + '%');
        }
        if (properties.clock_y) {
            document.documentElement.style.setProperty('--clock-y', properties.clock_y.value + '%');
        }
        if (properties.clock_size) {
            document.documentElement.style.setProperty('--clock-scale', properties.clock_size.value / 100);
        }

        // Music Player Position & Size
        if (properties.music_x) {
            document.documentElement.style.setProperty('--music-x', properties.music_x.value + '%');
        }
        if (properties.music_y) {
            document.documentElement.style.setProperty('--music-y', properties.music_y.value + '%');
        }
        if (properties.music_size) {
            document.documentElement.style.setProperty('--music-scale', properties.music_size.value / 100);
        }

        // Stats Position & Size
        if (properties.stats_x) {
            document.documentElement.style.setProperty('--stats-x', properties.stats_x.value + '%');
        }
        if (properties.stats_y) {
            document.documentElement.style.setProperty('--stats-y', properties.stats_y.value + '%');
        }
        if (properties.stats_size) {
            document.documentElement.style.setProperty('--stats-scale', properties.stats_size.value / 100);
        }

        // Show/Hide Stats
        if (properties.show_stats) {
            document.documentElement.style.setProperty('--stats-display', properties.show_stats.value ? 'flex' : 'none');
        }

        // Show/Hide GPU Fan
        if (properties.show_gpu_fan) {
            document.documentElement.style.setProperty('--gpu-fan-display', properties.show_gpu_fan.value ? 'flex' : 'none');
        }

        // Show/Hide Lyrics
        if (properties.show_lyrics) {
            document.documentElement.style.setProperty('--lyrics-display', properties.show_lyrics.value ? 'flex' : 'none');
        }
        if (properties.lyrics_y) {
            document.documentElement.style.setProperty('--lyrics-y', properties.lyrics_y.value + '%');
        }
        if (properties.lyrics_x) {
            document.documentElement.style.setProperty('--lyrics-x', properties.lyrics_x.value + '%');
        }
        if (properties.lyrics_size) {
            document.documentElement.style.setProperty('--lyrics-width', properties.lyrics_size.value + '%');
        }

        // Drop Shadow
        if (properties.show_shadow || properties.shadow_blur || properties.shadow_opacity) {
            const show = (properties.show_shadow) ? properties.show_shadow.value : true;
            const blur = (properties.shadow_blur) ? properties.shadow_blur.value : 4;
            const opacity = (properties.shadow_opacity) ? properties.shadow_opacity.value : 50;
            
            if (show) {
                const shadowStr = `0 ${blur/2}px ${blur}px rgba(0, 0, 0, ${opacity / 100})`;
                document.documentElement.style.setProperty('--text-shadow', shadowStr);
            } else {
                document.documentElement.style.setProperty('--text-shadow', 'none');
            }
        }

        // Background Effect
        if (properties.bg_effect) {
            window.currentBgEffect = properties.bg_effect.value;
        }

        // Overlay Image
        if (properties.overlayimage) {
            const overlayImg = document.getElementById('overlay-image');
            if (properties.overlayimage.value) {
                overlayImg.src = 'file:///' + properties.overlayimage.value;
            } else {
                overlayImg.src = '';
            }
        }
        if (properties.overlay_x) {
            document.documentElement.style.setProperty('--overlay-x', properties.overlay_x.value + '%');
        }
        if (properties.overlay_y) {
            document.documentElement.style.setProperty('--overlay-y', properties.overlay_y.value + '%');
        }
        if (properties.overlay_size) {
            document.documentElement.style.setProperty('--overlay-scale', properties.overlay_size.value / 100);
        }

        // Weather
        if (properties.show_weather) {
            document.documentElement.style.setProperty('--weather-display', properties.show_weather.value ? 'flex' : 'none');
        }
        if (properties.weather_unit) {
            weatherUnit = properties.weather_unit.value;
            updateWeather();
        }
        if (properties.weather_x) {
            document.documentElement.style.setProperty('--weather-x', properties.weather_x.value + '%');
        }
        if (properties.weather_y) {
            document.documentElement.style.setProperty('--weather-y', properties.weather_y.value + '%');
        }
        if (properties.weather_size) {
            document.documentElement.style.setProperty('--weather-scale', properties.weather_size.value / 100);
        }
    }
};

// ==========================================
// Drag to Move Background
// ==========================================
let isDragging = false;
let startX, startY;
let startOffsetX, startOffsetY;

bgLayer.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startOffsetX = bgOffsetX;
    startOffsetY = bgOffsetY;
});

window.addEventListener('mouseup', () => {
    if (isDragging) {
        isDragging = false;
        localStorage.setItem('we_bgOffsetX', bgOffsetX);
        localStorage.setItem('we_bgOffsetY', bgOffsetY);
    }
});

window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    const deltaXPct = -(deltaX / window.innerWidth) * 100;
    const deltaYPct = -(deltaY / window.innerHeight) * 100;

    bgOffsetX = startOffsetX + (deltaXPct * 1.5);
    bgOffsetY = startOffsetY + (deltaYPct * 1.5);

    updateBackgroundStyle();
});

// ==========================================
// Background Effects Engine (Topo, Grid, Glitch)
// ==========================================
window.currentBgEffect = 'topo';

(function initBackgroundEffects() {
    const canvas = document.getElementById('topo-canvas');
    const ctx = canvas.getContext('2d');
    let time = 0;

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    window.addEventListener('resize', resize);
    resize();

    // --- Topographic Logic ---
    function noise(x, y, t) {
        return (
            Math.sin(x * 0.008 + t * 0.3) * 0.5 +
            Math.sin(y * 0.006 - t * 0.2) * 0.5 +
            Math.sin((x + y) * 0.005 + t * 0.15) * 0.4 +
            Math.sin(x * 0.015 - y * 0.01 + t * 0.1) * 0.3
        );
    }

    function drawTopo() {
        time += 0.008;
        const w = canvas.width;
        const h = canvas.height;
        const step = 8; 
        const levels = 10;
        const levelSpacing = 1.7 / levels;

        const colorRGB = getComputedStyle(document.documentElement).getPropertyValue('--effect-color-rgb').trim();

        ctx.lineWidth = 1;
        for (let level = 0; level < levels; level++) {
            const threshold = -0.85 + level * levelSpacing;
            const alpha = 0.1 + (level % 3) * 0.05;
            ctx.strokeStyle = `rgba(${colorRGB}, ${alpha})`;
            ctx.beginPath();
            let drawing = false;

            for (let y = 0; y < h; y += step) {
                for (let x = 0; x < w; x += step) {
                    const val = noise(x, y, time);
                    const valRight = noise(x + step, y, time);
                    const valDown = noise(x, y + step, time);

                    if ((val - threshold) * (valRight - threshold) < 0) {
                        const t_interp = (threshold - val) / (valRight - val);
                        const cx = x + t_interp * step;
                        if (!drawing) { ctx.moveTo(cx, y); drawing = true; } else { ctx.lineTo(cx, y); }
                    }
                    if ((val - threshold) * (valDown - threshold) < 0) {
                        const t_interp = (threshold - val) / (valDown - val);
                        const cy = y + t_interp * step;
                        if (!drawing) { ctx.moveTo(x, cy); drawing = true; } else { ctx.lineTo(x, cy); }
                    }
                }
                drawing = false;
            }
            ctx.stroke();
        }
    }

    // --- Synthwave Grid Logic ---
    function drawGrid() {
        time += 0.02;
        const w = canvas.width;
        const h = canvas.height;
        const horizon = h * 0.4;
        const gridSize = 50;
        const speed = time * 40;

        const colorRGB = getComputedStyle(document.documentElement).getPropertyValue('--effect-color-rgb').trim();

        ctx.strokeStyle = `rgba(${colorRGB}, 0.25)`;
        ctx.lineWidth = 1;

        // Horizontal lines (perspective)
        for (let i = 0; i < 20; i++) {
            const yOffset = (i * gridSize + (speed % gridSize));
            const y = horizon + (Math.pow(yOffset / h, 2) * h * 1.5);
            if (y > h) continue;
            
            const alpha = Math.max(0, (y - horizon) / (h - horizon)) * 0.5;
            ctx.strokeStyle = `rgba(${colorRGB}, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        // Vertical lines (perspective)
        const verticalCount = 12;
        for (let i = -verticalCount; i <= verticalCount; i++) {
            const xTop = w / 2 + (i * (w / verticalCount) * 0.1);
            const xBottom = w / 2 + (i * w * 0.8);
            
            const alpha = 0.3;
            ctx.strokeStyle = `rgba(${colorRGB}, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(xTop, horizon);
            ctx.lineTo(xBottom, h);
            ctx.stroke();
        }
    }

    // --- VHS Glitch Logic ---
    function drawGlitch() {
        time += 0.05;
        const w = canvas.width;
        const h = canvas.height;

        const colorRGB = getComputedStyle(document.documentElement).getPropertyValue('--effect-color-rgb').trim();

        // Random horizontal scans
        if (Math.random() > 0.8) {
            ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.05})`;
            ctx.fillRect(0, Math.random() * h, w, Math.random() * 10);
        }

        // Subtle static noise
        for (let i = 0; i < 5; i++) {
            const x = Math.random() * w;
            const y = Math.random() * h;
            const size = Math.random() * 2;
            ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.2})`;
            ctx.fillRect(x, y, size, size);
        }

        // Chromatic split lines (occasional)
        if (Math.random() > 0.95) {
            const y = Math.random() * h;
            const offset = Math.random() * 5;
            // Use user color for split lines too
            ctx.fillStyle = `rgba(${colorRGB}, 0.2)`;
            ctx.fillRect(offset, y, w, 2);
            ctx.fillStyle = `rgba(${colorRGB}, 0.2)`;
            ctx.fillRect(-offset, y + 2, w, 2);
        }
    }

    function mainLoop() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (window.currentBgEffect === 'none') {
            // Animation is off, do nothing
        } else {
            switch (window.currentBgEffect) {
                case 'topo':
                    drawTopo();
                    break;
                case 'grid':
                    drawGrid();
                    break;
                case 'glitch':
                    drawGlitch();
                    break;
            }
        }

        requestAnimationFrame(mainLoop);
    }

    mainLoop();
})();

// ==========================================
// Hardware Monitor WebSocket Client
// ==========================================
(function initHWMonitor() {
    const cpuUsageEl = document.getElementById('cpu-usage');
    const cpuTempEl = document.getElementById('cpu-temp');
    const gpuUsageEl = document.getElementById('gpu-usage');
    const gpuTempEl = document.getElementById('gpu-temp');
    const statusEl = document.getElementById('hw-status');

    const WS_URL = 'ws://localhost:3985';
    const RECONNECT_DELAY = 5000; // Try reconnecting every 5 seconds

    let ws = null;
    let reconnectTimer = null;

    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;

        statusEl.textContent = 'Connecting...';
        statusEl.className = 'stat-status';

        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            statusEl.textContent = 'Connected';
            statusEl.className = 'stat-status connected';
            // Hide status text after 3 seconds
            setTimeout(() => {
                if (statusEl.classList.contains('connected')) {
                    statusEl.style.opacity = '0';
                }
            }, 3000);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                cpuUsageEl.textContent = data.cpu_usage + '%';
                cpuTempEl.textContent = (data.cpu_temp > 0) ? data.cpu_temp + '°C' : '--°C';
                gpuUsageEl.textContent = data.gpu_usage + '%';
                gpuTempEl.textContent = (data.gpu_temp > 0) ? data.gpu_temp + '°C' : '--°C';

                // Update GPU Fan Spin Speed
                // Usage 0% -> 5s (slow), Usage 100% -> 0.2s (fast)
                const usage = data.gpu_usage || 0;
                const spinDuration = 5 - (usage / 100) * 4.8; 
                document.documentElement.style.setProperty('--gpu-spin-speed', `${spinDuration.toFixed(2)}s`);
            } catch (e) {
                // Ignore parse errors
            }
        };

        ws.onclose = () => {
            statusEl.textContent = 'Disconnected';
            statusEl.className = 'stat-status error';
            statusEl.style.opacity = '1';
            scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose will fire after this, which handles reconnect
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, RECONNECT_DELAY);
    }

    // Start connection
    connect();
})();

// ==========================================
// Weather Logic (Open-Meteo)
// ==========================================
async function updateWeather() {
    const latitude = 13.7911328;
    const longitude = 100.5761852;
    document.getElementById('weather-city').textContent = "Bangkok, Sutthisan";
    
    try {
        // 2. Weather
        const unit = weatherUnit === 'fahrenheit' ? '&temperature_unit=fahrenheit' : '';
        const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true${unit}`);
        const weatherData = await weatherRes.json();

        if (weatherData.current_weather) {
            const { temperature, weathercode } = weatherData.current_weather;
            document.getElementById('weather-temp').textContent = `${Math.round(temperature)}°`;
            
            const condition = mapWeatherCode(weathercode);
            document.getElementById('weather-desc').textContent = condition.desc;
            document.getElementById('weather-icon-container').textContent = condition.icon;
        }
    } catch (e) {
        document.getElementById('weather-city').textContent = "Weather Error";
    }
}

function mapWeatherCode(code) {
    const codes = {
        0: { desc: "Clear sky", icon: "☀️" },
        1: { desc: "Mainly clear", icon: "🌤️" },
        2: { desc: "Partly cloudy", icon: "⛅" },
        3: { desc: "Overcast", icon: "☁️" },
        45: { desc: "Fog", icon: "🌫️" },
        48: { desc: "Depositing rime fog", icon: "🌫️" },
        51: { desc: "Drizzle: Light", icon: "🌦️" },
        53: { desc: "Drizzle: Moderate", icon: "🌦️" },
        55: { desc: "Drizzle: Dense", icon: "🌦️" },
        61: { desc: "Rain: Slight", icon: "🌧️" },
        63: { desc: "Rain: Moderate", icon: "🌧️" },
        65: { desc: "Rain: Heavy", icon: "🌧️" },
        71: { desc: "Snow fall: Slight", icon: "❄️" },
        73: { desc: "Snow fall: Moderate", icon: "❄️" },
        75: { desc: "Snow fall: Heavy", icon: "❄️" },
        80: { desc: "Rain showers: Slight", icon: "🌦️" },
        81: { desc: "Rain showers: Moderate", icon: "🌦️" },
        82: { desc: "Rain showers: Violent", icon: "🌧️" },
        95: { desc: "Thunderstorm: Slight or moderate", icon: "⛈️" },
        96: { desc: "Thunderstorm with slight hail", icon: "⛈️" },
        99: { desc: "Thunderstorm with heavy hail", icon: "⛈️" }
    };
    return codes[code] || { desc: "Unknown", icon: "🌡️" };
}

// Update weather every 30 minutes
setInterval(updateWeather, 30 * 60 * 1000);
updateWeather();
