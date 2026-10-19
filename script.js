// ==========================================
// Clock Logic (24-hour format)
// ==========================================
// hourCycle 'h23' instead of hour12:false — older V8 resolves hour12:false to
// h24 for en-US and shows midnight as "24:05".
const timeFormat = new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: '2-digit' });
const clockEls = ['time', 'time-red', 'time-green', 'time-blue'].map(id => document.getElementById(id));
const dateEl = document.getElementById('date-text');

// Write only when the text changes: the display changes once a minute, and
// each write repaints the clock card and its blend-mode layers.
function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
}

function updateTime() {
    const now = new Date();
    const timeString = timeFormat.format(now);
    clockEls.forEach(el => setText(el, timeString));
    setText(dateEl, dateFormat.format(now));
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
let lyricLineEls = [];        // rendered synced-lyric line elements, same order as currentSyncedLyrics
let activeLyricIndex = -1;
let lyricsRequestId = 0;      // bumped per track so late responses for an old track are dropped
let currentTrackKey = '';
let weatherUnit = "celsius";

// Only the properties event carries contentType; the thumbnail and timeline
// events don't, so they follow this flag to ignore non-music sessions too.
let mediaIsMusic = true;

window.wallpaperRegisterMediaPropertiesListener((event) => {
    // Only react to music sessions (Spotify, Apple Music, etc.). Browser/video
    // media reports contentType 'video'/'image' — ignore it and leave the
    // current track untouched. Sessions that omit contentType still pass.
    mediaIsMusic = !(event && event.contentType && event.contentType !== 'music');
    if (!mediaIsMusic) return;

    const titleEl = document.getElementById('track-title');
    const artistEl = document.getElementById('track-artist');

    if (event && event.title) {
        titleEl.textContent = event.title;
        artistEl.textContent = event.artist || "Unknown Artist";

        // Key on title + artist so covers / same-named songs still refetch.
        const trackKey = event.title + '\n' + (event.artist || '');
        if (trackKey !== currentTrackKey) {
            currentTrackKey = trackKey;
            fetchLyrics(event.title, event.artist);
        }
    } else {
        currentTrackKey = '';
        lyricsRequestId++; // drop any lyrics request still in flight
        titleEl.textContent = "No Track Playing";
        artistEl.textContent = "Waiting for media...";
        showLyricsMessage('');
        document.getElementById('time-current').textContent = "0:00";
        document.getElementById('time-total').textContent = "0:00";
        document.getElementById('progress-bar').style.width = "0%";
    }
});

// --- Lyrics cache (localStorage-backed, held in memory) ---
const LYRICS_CACHE_KEY = 'lyricsCache';
const LYRICS_CACHE_BUDGET = 4 * 1024 * 1024;      // ~4MB, under CEF's ~5MB localStorage limit
const LYRICS_NEG_TTL = 7 * 24 * 60 * 60 * 1000;   // retry "not found" after 7 days
const LYRICS_SAVE_DELAY = 2000;

// Parsed once on first use and kept in memory; saves are debounced so a track
// change doesn't re-parse and re-serialize the whole (up to 4MB) blob.
let lyricsCache = null;
let lyricsSaveTimer = null;

function lyricsCacheKey(artist, title) {
    return (artist + '|' + title).toLowerCase();
}

function loadLyricsCache() {
    try {
        return JSON.parse(localStorage.getItem(LYRICS_CACHE_KEY)) || {};
    } catch (e) {
        return {};
    }
}

// Returns the cache that was actually persisted (old entries may be evicted).
function saveLyricsCache(cache) {
    let payload = JSON.stringify(cache);
    // UTF-16 strings are ~2 bytes/char. If over budget, drop the oldest third.
    if (payload.length * 2 > LYRICS_CACHE_BUDGET) {
        const entries = Object.entries(cache).sort((a, b) => a[1].at - b[1].at);
        cache = Object.fromEntries(entries.slice(Math.floor(entries.length / 3)));
        payload = JSON.stringify(cache);
    }
    try {
        localStorage.setItem(LYRICS_CACHE_KEY, payload);
    } catch (e) {
        // QuotaExceeded backstop: keep only the newest half and retry once.
        const entries = Object.entries(cache).sort((a, b) => a[1].at - b[1].at);
        cache = Object.fromEntries(entries.slice(Math.floor(entries.length / 2)));
        try { localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(cache)); } catch (e2) {}
    }
    return cache;
}

function getLyricsCache() {
    if (!lyricsCache) lyricsCache = loadLyricsCache();
    return lyricsCache;
}

function scheduleLyricsCacheSave() {
    if (lyricsSaveTimer) return;
    lyricsSaveTimer = setTimeout(() => {
        lyricsSaveTimer = null;
        lyricsCache = saveLyricsCache(lyricsCache);
    }, LYRICS_SAVE_DELAY);
}

function getCachedLyrics(key) {
    const entry = getLyricsCache()[key];
    if (!entry) return null;
    if (entry.none && Date.now() - entry.at > LYRICS_NEG_TTL) return null; // expired negative → refetch
    // Refresh recency for LRU in memory only; it's persisted with the next new entry.
    entry.at = Date.now();
    return entry;
}

function setCachedLyrics(key, entry) {
    entry.at = Date.now();
    getLyricsCache()[key] = entry;
    scheduleLyricsCacheSave();
}

function parseSyncedLyrics(raw) {
    return raw.split('\n').map(line => {
        const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
        if (match) {
            const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
            return { time, text: match[3].trim() };
        }
        return null;
    }).filter(l => l && l.text);
}

// "Song (feat. X)", "Song [Live]", "Song - Remastered 2011" → "Song", while
// hyphenated titles like "Anti-Hero" stay intact.
function cleanTrackTitle(title) {
    const cleaned = title.replace(/\s*[(\[].*$/, '').replace(/\s+[-–—]\s+.*$/, '').trim();
    return cleaned || title.trim();
}

// Primary artist: cut at a comma or a standalone "feat."/"ft." ("Defeater" stays whole).
function primaryArtist(artist) {
    return artist.split(',')[0].split(/\s+(?:feat\.?|ft\.|featuring)\s+/i)[0].trim();
}

// Shows one non-synced block (status text or plain lyrics). Uses textContent:
// lrclib is crowd-sourced, so lyrics are untrusted text, never HTML.
function showLyricsMessage(text, active = false, plain = false) {
    const lyricsEl = document.getElementById('lyrics-content');
    currentSyncedLyrics = [];
    lyricLineEls = [];
    activeLyricIndex = -1;
    if (!text) {
        lyricsEl.replaceChildren();
        return;
    }
    const div = document.createElement('div');
    div.className = 'lyric-line' + (active ? ' active' : '') + (plain ? ' plain' : '');
    div.textContent = text;
    lyricsEl.replaceChildren(div);
}

function applyLyrics(data) {
    if (data.syncedLyrics) {
        currentSyncedLyrics = parseSyncedLyrics(data.syncedLyrics);
        renderLyrics(currentSyncedLyrics);
    } else if (data.plainLyrics) {
        showLyricsMessage(data.plainLyrics, true, true);
    } else {
        showLyricsMessage('No lyrics found.');
    }
}

async function fetchLyrics(title, artist) {
    const requestId = ++lyricsRequestId;
    currentSyncedLyrics = [];

    const cleanTitle = cleanTrackTitle(title);
    const fullArtist = (artist || "").trim();
    const cleanArtist = primaryArtist(fullArtist);
    const key = lyricsCacheKey(cleanArtist, cleanTitle);

    // Cache hit — apply instantly, no network call.
    const cached = getCachedLyrics(key);
    if (cached) {
        if (cached.none) {
            showLyricsMessage('No lyrics found.');
        } else {
            applyLyrics(cached);
        }
        return;
    }

    showLyricsMessage('Searching...', true);

    // Primary artist first; a name that contains a comma ("Tyler, The Creator")
    // gets a second try with the full artist string.
    const artistCandidates = cleanArtist === fullArtist ? [cleanArtist] : [cleanArtist, fullArtist];

    try {
        let result = 'miss'; // 'found' | 'miss' (definitive, cacheable) | 'error' (transient)
        let data = null;
        for (const candidate of artistCandidates) {
            const response = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(candidate)}&track_name=${encodeURIComponent(cleanTitle)}`);
            if (requestId !== lyricsRequestId) return; // track changed while waiting
            if (response.status === 404) continue;      // not in lrclib under this artist name
            if (!response.ok) {
                result = 'error';
                break;
            }
            data = await response.json();
            if (requestId !== lyricsRequestId) return;
            result = (data.syncedLyrics || data.plainLyrics) ? 'found' : 'miss';
            break;
        }

        if (result === 'found') {
            const entry = { syncedLyrics: data.syncedLyrics || null, plainLyrics: data.plainLyrics || null };
            setCachedLyrics(key, entry);
            applyLyrics(entry);
        } else {
            // Cache definitive misses so replays don't re-hit the API; a transient
            // server error leaves the cache alone.
            if (result === 'miss') setCachedLyrics(key, { none: true });
            showLyricsMessage('No lyrics found.');
        }
    } catch (e) {
        // Network failure — leave cache untouched so it retries next time.
        if (requestId === lyricsRequestId) showLyricsMessage('');
    }
}

function renderLyrics(lyrics) {
    const lyricsEl = document.getElementById('lyrics-content');
    lyricLineEls = lyrics.map(l => {
        const div = document.createElement('div');
        div.className = 'lyric-line';
        div.textContent = l.text;
        return div;
    });
    activeLyricIndex = -1;
    lyricsEl.replaceChildren(...lyricLineEls);
    cancelAnimationFrame(lyricsScrollRaf);
    document.getElementById('lyrics-section').scrollTop = 0;
}

window.wallpaperRegisterMediaTimelineListener((event) => {
    if (!mediaIsMusic) return;

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
        
        setText(currentEl, formatTime(event.position));
        setText(totalEl, formatTime(event.duration));

        const progressPct = (event.position / event.duration) * 100;
        barEl.style.width = `${progressPct}%`;
    } else {
        setText(currentEl, "0:00");
        setText(totalEl, "0:00");
        barEl.style.width = "0%";
    }

    if (!event || !currentSyncedLyrics.length) return;
    const position = event.position;

    // Last line whose timestamp has passed; -1 before the first line starts.
    let activeIndex = -1;
    for (let i = 0; i < currentSyncedLyrics.length; i++) {
        if (position >= currentSyncedLyrics[i].time) {
            activeIndex = i;
        } else {
            break;
        }
    }
    if (activeIndex === activeLyricIndex) return;

    if (activeLyricIndex >= 0) lyricLineEls[activeLyricIndex].classList.remove('active');
    activeLyricIndex = activeIndex;
    if (activeIndex < 0) return;

    const line = lyricLineEls[activeIndex];
    const container = document.getElementById('lyrics-section');
    line.classList.add('active');
    const offset = line.offsetTop - (container.offsetHeight / 2) + (line.offsetHeight / 2);
    scrollLyricsTo(container, offset);
});

// Eases the lyrics scroll in 12 steps over 0.4 s (~30 updates/s). Native smooth
// scrolling animates at the display's full refresh rate, and every step
// re-blurs the lyrics card.
const LYRICS_SCROLL_MS = 400;
const LYRICS_SCROLL_STEPS = 12;
let lyricsScrollRaf = 0;

function scrollLyricsTo(container, top) {
    cancelAnimationFrame(lyricsScrollRaf);
    const start = container.scrollTop;
    const distance = top - start;
    const t0 = performance.now();
    let lastStep = 0;

    function tick(now) {
        const step = Math.min(Math.floor((now - t0) / LYRICS_SCROLL_MS * LYRICS_SCROLL_STEPS) + 1, LYRICS_SCROLL_STEPS);
        if (step !== lastStep) {
            lastStep = step;
            const progress = 1 - Math.pow(1 - step / LYRICS_SCROLL_STEPS, 3); // ease-out cubic
            container.scrollTop = start + distance * progress;
        }
        lyricsScrollRaf = step < LYRICS_SCROLL_STEPS ? requestAnimationFrame(tick) : 0;
    }
    lyricsScrollRaf = requestAnimationFrame(tick);
}

let albumArtSrc = '';
let albumArtToken = 0;

window.wallpaperRegisterMediaThumbnailListener((event) => {
    if (!mediaIsMusic) return;

    const imgElement = document.getElementById('album-art');
    const src = (event && event.thumbnail) ? event.thumbnail : "assets/default_art.jpg";
    if (src === albumArtSrc) return; // same artwork re-sent (e.g. pause/resume) — skip the fade and re-decode
    albumArtSrc = src;

    const token = ++albumArtToken;
    imgElement.style.opacity = 0;
    setTimeout(() => {
        if (token !== albumArtToken) return; // a newer thumbnail arrived during the fade
        imgElement.src = src;
        imgElement.style.opacity = 1;
    }, 200);
});

// ==========================================
// Custom Background & Draggable Logic
// ==========================================
const bgLayer = document.getElementById('background-layer');

// A dragged position is saved per axis. WE re-sends bg_x/bg_y with the first
// property batch on load, so that batch keeps a saved drag; moving a slider
// later replaces it.
function loadBgOffset(key) {
    const value = parseFloat(localStorage.getItem(key));
    return Number.isFinite(value) ? value : null;
}
const savedBgOffsetX = loadBgOffset('we_bgOffsetX');
const savedBgOffsetY = loadBgOffset('we_bgOffsetY');
let bgOffsetX = savedBgOffsetX ?? 50;
let bgOffsetY = savedBgOffsetY ?? 50;
let bgScale = 100;
let userPropertiesApplied = false;

function updateBackgroundStyle() {
    bgLayer.style.backgroundPosition = `${bgOffsetX}% ${bgOffsetY}%`;
    bgLayer.style.backgroundSize = `${bgScale}%`;
}

updateBackgroundStyle();

// Clock custom color state — when disabled, the clock falls back to the
// universal text color through the CSS var defaults
let clockUseCustomColor = false;
let clockCustomColor = 'rgb(255, 255, 255)';
let clockCustomColorSub = 'rgba(255, 255, 255, 0.7)';

function applyClockColor() {
    if (clockUseCustomColor) {
        document.documentElement.style.setProperty('--clock-color', clockCustomColor);
        document.documentElement.style.setProperty('--clock-color-sub', clockCustomColorSub);
    } else {
        document.documentElement.style.setProperty('--clock-color', 'var(--text-color)');
        document.documentElement.style.setProperty('--clock-color-sub', 'var(--text-color-sub)');
    }
}

// ==========================================
// Wallpaper Engine Property Listener
// ==========================================
// Drop shadow state — WE sends only the changed property, so keep all three
let shadowShow = true;
let shadowBlur = 4;
let shadowOpacity = 50;

window.wallpaperPropertyListener = {
    // WE's FPS limit isn't applied to requestAnimationFrame for web wallpapers;
    // the background effects loop enforces it.
    applyGeneralProperties: function(properties) {
        if (properties.fps) {
            bgEffects.setFps(properties.fps);
        }
    },

    applyUserProperties: function(properties) {
        const firstApply = !userPropertiesApplied;
        userPropertiesApplied = true;

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

        // Background Position (a saved drag wins over the load-time values)
        if (properties.bg_x && !(firstApply && savedBgOffsetX !== null)) {
            bgOffsetX = properties.bg_x.value;
            if (!firstApply) localStorage.removeItem('we_bgOffsetX');
            updateBackgroundStyle();
        }
        if (properties.bg_y && !(firstApply && savedBgOffsetY !== null)) {
            bgOffsetY = properties.bg_y.value;
            if (!firstApply) localStorage.removeItem('we_bgOffsetY');
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
            bgEffects.setColor(`${r}, ${g}, ${b}`);
        }

        // Circle Color
        if (properties.circle_color) {
            const colorParts = properties.circle_color.value.split(' ');
            const r = Math.ceil(colorParts[0] * 255);
            const g = Math.ceil(colorParts[1] * 255);
            const b = Math.ceil(colorParts[2] * 255);
            document.documentElement.style.setProperty('--circle-color', `rgb(${r}, ${g}, ${b})`);
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

        // Clock Font Weight
        if (properties.clock_weight) {
            document.documentElement.style.setProperty('--clock-weight', properties.clock_weight.value);
        }

        // Clock Custom Color
        if (properties.clock_use_custom_color) {
            clockUseCustomColor = properties.clock_use_custom_color.value;
            applyClockColor();
        }
        if (properties.clock_color) {
            const colorParts = properties.clock_color.value.split(' ');
            const r = Math.ceil(colorParts[0] * 255);
            const g = Math.ceil(colorParts[1] * 255);
            const b = Math.ceil(colorParts[2] * 255);
            clockCustomColor = `rgb(${r}, ${g}, ${b})`;
            clockCustomColorSub = `rgba(${r}, ${g}, ${b}, 0.7)`;
            applyClockColor();
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

        // Show/Hide Next Song
        if (properties.show_next_song) {
            document.documentElement.style.setProperty('--next-song-display', properties.show_next_song.value ? 'flex' : 'none');
        }
        if (properties.next_song_x) {
            document.documentElement.style.setProperty('--next-song-x', properties.next_song_x.value + '%');
        }
        if (properties.next_song_y) {
            document.documentElement.style.setProperty('--next-song-y', properties.next_song_y.value + '%');
        }
        if (properties.next_song_size) {
            document.documentElement.style.setProperty('--next-song-scale', properties.next_song_size.value / 100);
        }

        // Show/Hide Claude Usage
        if (properties.show_claude) {
            document.documentElement.style.setProperty('--claude-display', properties.show_claude.value ? 'flex' : 'none');
        }
        if (properties.claude_x) {
            document.documentElement.style.setProperty('--claude-x', properties.claude_x.value + '%');
        }
        if (properties.claude_y) {
            document.documentElement.style.setProperty('--claude-y', properties.claude_y.value + '%');
        }
        if (properties.claude_size) {
            document.documentElement.style.setProperty('--claude-scale', properties.claude_size.value / 100);
        }

        // Drop Shadow
        if (properties.show_shadow || properties.shadow_blur || properties.shadow_opacity) {
            if (properties.show_shadow) shadowShow = properties.show_shadow.value;
            if (properties.shadow_blur) shadowBlur = properties.shadow_blur.value;
            if (properties.shadow_opacity) shadowOpacity = properties.shadow_opacity.value;

            if (shadowShow) {
                const shadowStr = `0 ${shadowBlur/2}px ${shadowBlur}px rgba(0, 0, 0, ${shadowOpacity / 100})`;
                document.documentElement.style.setProperty('--text-shadow', shadowStr);
            } else {
                document.documentElement.style.setProperty('--text-shadow', 'none');
            }
        }

        // Background Effect
        if (properties.bg_effect) {
            bgEffects.setEffect(properties.bg_effect.value);
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
        // Refetch only when the unit actually changes; the startup fetch already
        // covers the default, so the load-time batch doesn't double-fetch.
        if (properties.weather_unit && properties.weather_unit.value !== weatherUnit) {
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
// The loop only runs while an effect is active: an idle loop that clears the
// full-screen canvas every frame still forces Chromium to recomposite the page
// (and re-blur every glass card) at the display's refresh rate.
const bgEffects = (function initBackgroundEffects() {
    const canvas = document.getElementById('topo-canvas');
    const ctx = canvas.getContext('2d');

    // Animation speeds in units per second (the old per-frame steps at 60 fps),
    // so speed no longer depends on refresh rate or the FPS limit.
    const TOPO_SPEED = 0.48;
    const GRID_SPEED = 1.2;
    const TOPO_STEP = 8;

    let effect = 'topo';
    let colorRGB = '60, 180, 200'; // matches --effect-color-rgb in style.css
    let fps = 30;                  // replaced by WE's limit via applyGeneralProperties
    let time = 0;
    let rafId = 0;
    let lastTick = 0;              // previous requestAnimationFrame timestamp
    let lastDraw = 0;              // timestamp of the last drawn frame
    let frameBudget = 0;           // seconds accumulated toward the next drawn frame

    // Topo noise field, sampled once per grid vertex per frame and shared by
    // every contour level (it used to be re-evaluated ~30x per vertex).
    let fieldCols = 0;
    let fieldRows = 0;
    let field = new Float64Array(0);

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        fieldCols = Math.ceil(canvas.width / TOPO_STEP) + 1;
        fieldRows = Math.ceil(canvas.height / TOPO_STEP) + 1;
        field = new Float64Array(fieldCols * fieldRows);
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

    function drawTopo(dt) {
        time += dt * TOPO_SPEED;
        const w = canvas.width;
        const h = canvas.height;
        const step = TOPO_STEP;
        const levels = 10;
        const levelSpacing = 1.7 / levels;
        const cols = fieldCols;

        for (let r = 0; r < fieldRows; r++) {
            for (let c = 0; c < cols; c++) {
                field[r * cols + c] = noise(c * step, r * step, time);
            }
        }

        ctx.lineWidth = 1;
        for (let level = 0; level < levels; level++) {
            const threshold = -0.85 + level * levelSpacing;
            const alpha = 0.1 + (level % 3) * 0.05;
            ctx.strokeStyle = `rgba(${colorRGB}, ${alpha})`;
            ctx.beginPath();

            for (let r = 0, y = 0; y < h; r++, y += step) {
                let drawing = false;
                const row = r * cols;
                for (let c = 0, x = 0; x < w; c++, x += step) {
                    const val = field[row + c];
                    const valRight = field[row + c + 1];
                    const valDown = field[row + cols + c];

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
            }
            ctx.stroke();
        }
    }

    // --- Synthwave Grid Logic ---
    function drawGrid(dt) {
        time += dt * GRID_SPEED;
        const w = canvas.width;
        const h = canvas.height;
        const horizon = h * 0.4;
        const gridSize = 50;
        const speed = time * 40;

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
        ctx.strokeStyle = `rgba(${colorRGB}, 0.3)`;
        for (let i = -verticalCount; i <= verticalCount; i++) {
            const xTop = w / 2 + (i * (w / verticalCount) * 0.1);
            const xBottom = w / 2 + (i * w * 0.8);

            ctx.beginPath();
            ctx.moveTo(xTop, horizon);
            ctx.lineTo(xBottom, h);
            ctx.stroke();
        }
    }

    // --- VHS Glitch Logic ---
    function drawGlitch(dt) {
        const w = canvas.width;
        const h = canvas.height;
        // Event chances were tuned per frame at 60 fps; scale by elapsed time
        // so they happen as often per second at any frame rate.
        const frames60 = dt * 60;

        // Random horizontal scans
        if (Math.random() < 0.2 * frames60) {
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
        if (Math.random() < 0.05 * frames60) {
            const y = Math.random() * h;
            const offset = Math.random() * 5;
            // Use user color for split lines too
            ctx.fillStyle = `rgba(${colorRGB}, 0.2)`;
            ctx.fillRect(offset, y, w, 2);
            ctx.fillRect(-offset, y + 2, w, 2);
        }
    }

    const drawers = { topo: drawTopo, grid: drawGrid, glitch: drawGlitch };

    function frame(now) {
        rafId = requestAnimationFrame(frame);

        // FPS limit: accumulate real time and draw once a frame interval has passed.
        const interval = 1 / fps;
        frameBudget += lastTick ? (now - lastTick) / 1000 : interval;
        lastTick = now;
        if (frameBudget < interval) return;
        frameBudget = Math.min(frameBudget - interval, interval);

        // Clamp so a stall (pause, hidden window) doesn't jump the animation.
        const dt = lastDraw ? Math.min((now - lastDraw) / 1000, 0.1) : interval;
        lastDraw = now;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawers[effect](dt);
    }

    function start() {
        if (rafId) return;
        lastTick = 0;
        lastDraw = 0;
        frameBudget = 0;
        rafId = requestAnimationFrame(frame);
    }

    function stop() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function setEffect(next) {
        effect = next;
        if (drawers[effect]) start(); else stop(); // 'none' (or unknown) → no loop at all
    }

    function setColor(rgb) {
        colorRGB = rgb;
    }

    function setFps(value) {
        if (value > 0) fps = value;
    }

    setEffect(effect);
    return { setEffect, setColor, setFps };
})();

// ==========================================
// Claude Usage Panel
// ==========================================
function formatClaudeReset(resetsAt) {
    if (!resetsAt) return '';
    const reset = new Date(resetsAt);
    if (isNaN(reset.getTime())) return '';

    const diffMs = reset.getTime() - Date.now();
    if (diffMs <= 0) return 'resetting...';

    // Within 24h: show clock time; further out: show weekday + time
    const timeStr = reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffMs < 24 * 60 * 60 * 1000) {
        return 'resets ' + timeStr;
    }
    const dayStr = reset.toLocaleDateString([], { weekday: 'short' });
    return 'resets ' + dayStr + ' ' + timeStr;
}

function setClaudeBar(prefix, windowData) {
    const pctEl = document.getElementById(`claude-${prefix}-pct`);
    const barEl = document.getElementById(`claude-${prefix}-bar`);
    const resetEl = document.getElementById(`claude-${prefix}-reset`);
    if (!pctEl || !barEl || !resetEl) return;

    if (!windowData) {
        setText(pctEl, '--%');
        barEl.style.width = '0%';
        setText(resetEl, ' ');
        return;
    }

    setText(pctEl, windowData.pct + '%');
    barEl.style.width = windowData.pct + '%';
    barEl.classList.toggle('crit', windowData.pct >= 90);
    barEl.classList.toggle('warn', windowData.pct >= 70 && windowData.pct < 90);
    setText(resetEl, formatClaudeReset(windowData.resets_at) || ' ');
}

function updateClaudeUsage(usage) {
    const statusEl = document.getElementById('claude-status');
    const opusRow = document.getElementById('claude-opus-row');
    if (!statusEl) return;

    if (!usage) return; // Server hasn't polled yet — keep placeholders

    if (!usage.ok) {
        statusEl.style.display = 'block';
        statusEl.textContent = usage.error === 'no_token'
            ? 'Not connected — log in to Claude Code CLI'
            : 'Usage unavailable';
        return;
    }

    statusEl.style.display = 'none';
    setClaudeBar('session', usage.session);
    setClaudeBar('weekly', usage.weekly);

    const scoped = usage.weekly_scoped || usage.weekly_opus;
    if (scoped) {
        opusRow.style.display = 'flex';
        const labelEl = opusRow.querySelector('.claude-bar-label');
        if (labelEl) {
            labelEl.textContent = scoped.label ? 'Weekly (' + scoped.label + ')' : 'Weekly (Model)';
        }
        setClaudeBar('opus', scoped);
    } else {
        opusRow.style.display = 'none';
    }
}

// ==========================================
// Hardware Monitor WebSocket Client
// ==========================================
(function initHWMonitor() {
    const cpuUsageEl = document.getElementById('cpu-usage');
    const cpuTempEl = document.getElementById('cpu-temp');
    const gpuUsageEl = document.getElementById('gpu-usage');
    const gpuTempEl = document.getElementById('gpu-temp');
    const cpuCircleEl = document.getElementById('cpu-circle');
    const gpuCircleEl = document.getElementById('gpu-circle');
    const gpuFanEl = document.getElementById('gpu-fan');
    const nextTitleEl = document.getElementById('next-track-title');
    const nextArtistEl = document.getElementById('next-track-artist');
    const nextArtEl = document.getElementById('next-album-art');
    const EMPTY_NEXT_ART = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'><rect width='300' height='300' fill='%231a1a2e'/></svg>";

    // Last values written, so the 2 s updates only touch what changed
    let lastCpuUsage = null;
    let lastGpuUsage = null;
    let lastSpinSpeed = '';
    let lastNextArt = '';

    const WS_URL = 'ws://localhost:3985';
    const RECONNECT_DELAY = 5000; // Try reconnecting every 5 seconds

    let ws = null;
    let reconnectTimer = null;

    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;

        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            // Silently connected
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                const cpuUsage = data.cpu_usage || 0;
                const gpuUsage = data.gpu_usage || 0;
                
                setText(cpuUsageEl, cpuUsage + '%');
                setText(cpuTempEl, (data.cpu_temp > 0) ? data.cpu_temp + '°C' : '--°C');
                setText(gpuUsageEl, gpuUsage + '%');
                setText(gpuTempEl, (data.gpu_temp > 0) ? data.gpu_temp + '°C' : '--°C');

                // Update circle progress bars
                // circumference = 2 * Math.PI * 42 ≈ 263.89
                const maxDash = 264;
                if (cpuUsage !== lastCpuUsage) {
                    lastCpuUsage = cpuUsage;
                    cpuCircleEl.style.strokeDashoffset = maxDash - (cpuUsage / 100) * maxDash;
                }
                if (gpuUsage !== lastGpuUsage) {
                    lastGpuUsage = gpuUsage;
                    gpuCircleEl.style.strokeDashoffset = maxDash - (gpuUsage / 100) * maxDash;
                }

                // Update GPU Fan Spin Speed
                // Usage 0% -> 5s (slow), Usage 100% -> 0.2s (fast). Quantized to 10%
                // steps (each duration change makes the running spin jump) and set
                // on the fan itself — on :root it re-styled the whole document.
                const spinSpeed = (5 - Math.round(gpuUsage / 10) * 0.48).toFixed(2) + 's';
                if (spinSpeed !== lastSpinSpeed) {
                    lastSpinSpeed = spinSpeed;
                    gpuFanEl.style.setProperty('--gpu-spin-speed', spinSpeed);
                }

                // Update Spotify Next Song
                let nextArt = EMPTY_NEXT_ART;
                if (data.spotify_next) {
                    setText(nextTitleEl, data.spotify_next.title);
                    setText(nextArtistEl, data.spotify_next.artist);
                    nextArt = data.spotify_next.art || "assets/default_art.jpg";
                } else {
                    setText(nextTitleEl, "End of Queue");
                    setText(nextArtistEl, "No next song");
                }
                if (nextArt !== lastNextArt) {
                    lastNextArt = nextArt;
                    nextArtEl.src = nextArt;
                }

                // Update Claude Usage
                updateClaudeUsage(data.claude_usage);
            } catch (e) {
                // Ignore parse errors
            }
        };

        ws.onclose = () => {
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
let weatherRequestId = 0;

async function updateWeather() {
    const requestId = ++weatherRequestId;
    const latitude = 13.7911328;
    const longitude = 100.5761852;
    document.getElementById('weather-city').textContent = "Bangkok, Sutthisan";

    try {
        // 2. Weather
        const unit = weatherUnit === 'fahrenheit' ? '&temperature_unit=fahrenheit' : '';
        const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true${unit}`);
        const weatherData = await weatherRes.json();
        if (requestId !== weatherRequestId) return; // a newer request (e.g. unit change) superseded this one

        if (weatherData.current_weather) {
            const { temperature, weathercode } = weatherData.current_weather;
            document.getElementById('weather-temp').textContent = `${Math.round(temperature)}°`;
            
            const condition = mapWeatherCode(weathercode);
            document.getElementById('weather-desc').textContent = condition.desc;
            document.getElementById('weather-icon-container').textContent = condition.icon;
        }
    } catch (e) {
        if (requestId === weatherRequestId) document.getElementById('weather-city').textContent = "Weather Error";
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
