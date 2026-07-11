# Vertical Media Wallpaper — Project Summary & Architecture Documentation

This document serves as a technical blueprint and architectural guide for the **Vertical Media Wallpaper** project, designed for **Wallpaper Engine** (custom web wallpaper). It provides details on all components, data flow, functions, scripts, and layout schemes so that any coding agent or developer can seamlessly understand and extend the codebase.

---

## 1. System Overview & Architecture

The project consists of two primary layers:
1. **Client-Side Frontend (Wallpaper Engine)**: A web page renderable inside Wallpaper Engine (`index.html`, `style.css`, `script.js`). It displays dynamic widgets (Clock, Weather, Music details, Synced Lyrics, Spotify Next Song, and HW Stats) in a modern, vertical, glassmorphic layout. It also contains an interactive canvas background and responds to user preferences set through Wallpaper Engine's native Properties panel.
2. **Server-Side Backend (Node.js)**: A background-running service (`server.js`) that monitors local system hardware (CPU and GPU load & temperatures) and queries the user's Spotify queue status via Spotify API. The server broadcasts this data to the client-side wallpaper via a local WebSocket channel (`ws://localhost:3985`).

### High-Level Data Flow

```mermaid
graph TD
    subgraph Client-Side (Wallpaper Engine UI)
        UI[index.html & style.css] <--> JS[script.js]
        WE_Prop[Wallpaper Engine Properties] -->|User configs/toggles| JS
        WE_Media[Wallpaper Engine Media Listener] -->|Play/Pause, Title, Art| JS
        LrcLib[LrcLib API] -->|Get synced lyrics| JS
        OpenMeteo[Open-Meteo API] -->|Get weather| JS
    end

    subgraph Backend (Node.js Server)
        WS[ws://localhost:3985] <--> Srv[server.js]
        Spotify_OAuth[Spotify API / Queue] -->|Polls next song| Srv
        Srv_App[Express App /port 8888] -->|Handle OAuth Callback| Spotify_OAuth
        HW_Poll[Hardware Poller] -->|CPU & GPU stats| Srv
        SysInfo[systeminformation] --> HW_Poll
        NvidiaSmi[nvidia-smi] --> HW_Poll
        WMI[LHM / OHM WMI namespaces] --> HW_Poll
    end

    JS <-->|WebSockets| WS
```

---

## 2. Directory & File Structure

```text
wallpaperEngine/
├── assets/                             # Image assets (e.g., gpu_fan.png)
├── index.html                          # Core DOM layout & widget structure
├── style.css                           # Glassmorphic themes, coordinates, animations
├── script.js                          # Client-side core logic, canvas, API clients
├── project.json                        # Wallpaper Engine property configuration definitions
├── PROJECT_SUMMARY.md                  # This file
└── server/
    ├── .env                            # Backend local variables (Spotify keys, tokens)
    ├── package.json                    # Backend dependencies list
    ├── server.js                       # Node.js backend monitoring & Spotify queue server
    ├── diag.js                         # Simple test tool for HW diagnostics
    ├── start-monitor.bat               # Executable batch file to start Node server
    └── start-monitor-hidden.vbs        # VBS launcher script to run backend invisibly
```

---

## 3. Client-Side Functions & Listeners (`script.js`)

All client-side logic lives in `script.js`. It contains event listeners for media updates, Wallpaper Engine custom properties, Canvas backgrounds, and WebSocket updates from the backend.

### 3.1 Media & Spotify Integration
* **`window.wallpaperRegisterMediaPropertiesListener((event) => { ... })`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 37–59)
  * **Description**: Native Wallpaper Engine listener callback that triggers when a media track changes. It updates the UI elements for track title (`#track-title`) and artist (`#track-artist`). If a new track title is detected, it triggers `fetchLyrics` to pull synced lyrics.
* **`async function fetchLyrics(title, artist)`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 61–96)
  * **Parameters**:
    * `title` (string): Title of the currently playing track.
    * `artist` (string): Artist name.
  * **Description**: Queries the public LrcLib API (`https://lrclib.net/api/get`) to search for lyrics. Cleans up common noise in track titles (like brackets or features) before submitting. Parses synced lyrics in `[mm:ss.xx] Lyric Text` format into an array of `{ time: seconds, text: string }` objects stored in the global variable `currentSyncedLyrics`. If synced lyrics are not available, falls back to plain text lyrics.
* **`function renderLyrics(lyrics)`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 98–101)
  * **Parameters**:
    * `lyrics` (Array): Array of lyric objects `{ time, text }`.
  * **Description**: Generates and inserts lyric HTML nodes (`<div class="lyric-line" id="lyric-i">text</div>`) into `#lyrics-content`.
* **`window.wallpaperRegisterMediaTimelineListener((event) => { ... })`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 103–153)
  * **Description**: Native Wallpaper Engine listener callback running continuously as a track plays. It computes and displays track progression details:
    * Updates `#time-current`, `#time-total`, and changes the width of `#progress-bar`.
    * Computes the active lyric line index by comparing the track's current `position` (in seconds) against the timestamps in `currentSyncedLyrics`. It adds the `.active` class to the current line and scrolls the lyrics container `#lyrics-section` smoothly to center the active text.
* **`window.wallpaperRegisterMediaThumbnailListener((event) => { ... })`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 155–171)
  * **Description**: Native Wallpaper Engine listener callback for track artwork. It reads the base64-encoded thumbnail representation in `event.thumbnail` and applies a crossfade opacity transition when updating the image source of `#album-art`. Falls back to a default asset if no art is found.

### 3.2 Time & Layout Styling
* **`function updateTime()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 4–22)
  * **Description**: Updates the clock elements (`#time`, `#time-red`, `#time-green`, `#time-blue` for the chromatic aberration layer effect) and date string (`#date-text`). Runs every second.
* **`function updateBackgroundStyle()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 182–185)
  * **Description**: Applies current background positioning offsets (`bgOffsetX`, `bgOffsetY`) and background scale percentage (`bgScale`) to the style properties of `#background-layer`.
* **`window.wallpaperPropertyListener = { applyUserProperties: function(properties) { ... } }`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 192–404)
  * **Description**: Main Wallpaper Engine property hook. It captures options changed in the customization UI (such as custom background image/video paths, custom CSS variable values for card positions, toggle settings for displaying modules, temperature unit choice, text drop-shadow levels, and the background visual effect mode). Updates CSS variables prefixed with `--` on the document root.

### 3.3 Canvas Animation Backgrounds
* **`initBackgroundEffects()` (Self-invoking / IIFE)**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 447–614)
  * **Description**: Initializes an animation loop on `#topo-canvas`. It manages canvas resizing to fit the window and switches between three visual states depending on the current global `window.currentBgEffect`:
    * **`noise(x, y, t)`**: Helper mathematical function mapping sine/cosine equations to simulate 3D Perlin-like wave patterns over time.
    * **`drawTopo()`**: Generates animated topographic lines by evaluating threshold contours from `noise()` coordinates and drawing path strokes colored according to the user's color selection.
    * **`drawGrid()`**: Renders a pseudo-3D synthwave grid scrolling forward into perspective relative to a horizon point.
    * **`drawGlitch()`**: Draws raw static, horizontal shifts, and random red/green/blue split lines to resemble a VHS glitch feed.
    * **`mainLoop()`**: The central animation ticker executing via `requestAnimationFrame`.

### 3.4 Hardware Monitoring Client
* **`initHWMonitor()` (Self-invoking / IIFE)**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 619–710)
  * **Description**: Manages a persistent WebSocket connection to `ws://localhost:3985`.
    * **`connect()`**: Opens the WebSocket channel. Defines callback hooks:
      * `onmessage`: Deserializes the system data packet. Updates CPU and GPU metrics text elements, computes circular SVG progress offsets (`#cpu-circle` and `#gpu-circle` with a circumference of ~264), alters the animation duration of the rotating GPU fan (`--gpu-spin-speed` scaling from 5s down to 0.2s relative to GPU load), and parses the upcoming Spotify track data (`spotify_next`) to update `#next-track-title`, `#next-track-artist`, and `#next-album-art`.
      * `onclose` & `onerror`: Triggers `scheduleReconnect()`.
    * **`scheduleReconnect()`**: Triggers a recursive call to `connect()` after 5 seconds if a connection drop is detected.

### 3.5 Weather Module
* **`async function updateWeather()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 715–737)
  * **Description**: Periodically fetches weather details from the Open-Meteo API for coordinates hardcoded to Bangkok, Sutthisan (`13.7911328, 100.5761852`). The temperature query parameter adjusts according to the user's unit settings (Celsius vs Fahrenheit). Updates `#weather-temp`, description text, and icon container.
* **`function mapWeatherCode(code)`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\script.js` (lines 739–764)
  * **Parameters**:
    * `code` (number): Numeric WMO weather code from Open-Meteo.
  * **Description**: Translates WMO weather codes into plain English text descriptions (e.g. "Clear sky", "Partly cloudy", "Rain showers") and attaches corresponding emoji symbols.

---

## 4. Backend Functions & Scripts (`server/server.js`)

The backend script is built with Node.js and acts as a central hub for hardware metrics harvesting and Spotify queue polling. It hosts the WebSocket service on port `3985` and a local Express OAuth callback on port `8888`.

### 4.1 System Monitor Server & Fallback Architecture
* **`broadcast(data)`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 35–42)
  * **Description**: Serializes and pushes a JSON string package containing the latest metric values (`cpu_usage`, `cpu_temp`, `gpu_usage`, `gpu_temp`, and `spotify_next`) to all active WebSocket clients.
* **`findNvidiaSmi()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 50–76)
  * **Description**: Finds the system installation path for `nvidia-smi.exe` by checking default Windows installation locations. If found, returns the path; if not, indicates that alternative GPU detection fallbacks should be used.
* **`getNvidiaGpuData()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 78–103)
  * **Description**: Executes `nvidia-smi` using a synchronous child process call to poll query strings for GPU temperature and utilization stats (`--query-gpu=temperature.gpu,utilization.gpu`). Returns parsed integer fields.
* **`getCpuTempLHM()`**, **`getCpuTempOHM()`**, and **`getCpuTempWmi()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 115–174)
  * **Description**: Native fallback hooks executing PowerShell scripts to query CPU temperature sensors from WMI namespaces:
    * **`getCpuTempLHM()`**: Queries the `root/LibreHardwareMonitor` namespace. Ideal for AMD Ryzen processors.
    * **`getCpuTempOHM()`**: Queries the `root/OpenHardwareMonitor` namespace.
    * **`getCpuTempWmi()`**: Queries `MSAcpi_ThermalZoneTemperature` under `root/wmi`. Returns values in tenths of Kelvin and converts them to Celsius. Fits older Intel setups.
* **`async function getCpuTemp()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 180–241)
  * **Description**: Attempts queries sequentially through systeminformation and the WMI temperature wrappers. Once a successful temperature source is verified, it locks in that method (`cpuTempSource`) to avoid running failed PowerShell queries repeatedly, which can consume CPU resources.
* **`async function pollHardware()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 246–280)
  * **Description**: Core system loop running every 2 seconds (`POLL_INTERVAL_MS`). Collects overall CPU load from `systeminformation.currentLoad()`, queries CPU temperature, attempts GPU metric polling via `getNvidiaGpuData()`, and falls back to `systeminformation.graphics()` if `nvidia-smi` is unavailable. Calls `broadcast()` to push stats to clients.

### 4.2 Spotify API Client
The backend spins up an Express server on port `8888` to manage user authorization credentials for Spotify Web API endpoints.
* **`/login` Express Route**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 314–326)
  * **Description**: Directs the user's browser to the Spotify Account authorization gateway. Uses scopes `user-read-playback-state` and `user-read-currently-playing`.
* **`/callback` Express Route**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 328–362)
  * **Description**: Processes authorization codes sent back by Spotify. Performs a POST exchange request for `access_token` and `refresh_token`. Safely records the refresh token to local `.env` variables via `updateEnvFile()`.
* **`function updateEnvFile(key, value)`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 299–312)
  * **Description**: Writes environment updates inline back to the local config file `.env` without overwriting unrelated fields.
* **`async function refreshSpotifyToken()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 374–398)
  * **Description**: Periodically exchanges the local `refresh_token` for a fresh `access_token` when expiration draws near (every hour).
* **`async function fetchSpotifyNextSong()`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\server.js` (lines 400–431)
  * **Description**: Calls the Spotify queue endpoint (`https://api.spotify.com/v1/me/player/queue`). Identifies the first upcoming track element in the queue list and writes its metadata (title, artist, high-res cover art link) to `latestData.spotify_next`. Polled once every 5 seconds.

### 4.3 Diagnostics & Launcher Scripts
* **`diag.js`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\diag.js`
  * **Description**: A short troubleshooting script that prints CPU temperature and active graphics controller objects to console standard output. Run it via `node server/diag.js`.
* **`start-monitor.bat`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\start-monitor.bat`
  * **Description**: Command shell batch file that moves execution context to the local script root and invokes the Node runtime on `server.js`.
* **`start-monitor-hidden.vbs`**
  * **Path**: `c:\Users\Oat\Work\wallpaperEngine\server\start-monitor-hidden.vbs`
  * **Description**: VBScript file that runs `start-monitor.bat` in a background shell with hidden windows (`0`), enabling the monitor to run silently in the background when the user boots their system.

---

## 5. UI Customization & Configuration Settings (`project.json`)

The `project.json` file dictates custom input fields rendered by Wallpaper Engine. Key customization elements configured here are:
* **Background Customization**:
  * `bgimage`: Background image file selector.
  * `bgvideo`: Background MP4 video file selector.
  * `bgcolor`: Hex/RGB solid fallback color.
  * `bgscale` / `bg_x` / `bg_y`: Position and scaling factor of the background image.
  * `bg_effect`: Visual animation choice (`none` / `topo` / `grid` / `glitch`).
* **Visual Styling & Themes**:
  * `effect_color`: Line color parameter for background canvas visual effects.
  * `circle_color`: Progress line color parameter for hardware stats circles.
  * `textcolor`: Main layout font colors.
  * `show_shadow` / `shadow_blur` / `shadow_opacity`: Drop-shadow styling levels.
* **Component Transforms**:
  * Coordinates and scaling fields for:
    * Clock (`clock_x`, `clock_y`, `clock_size`)
    * Music Player (`music_x`, `music_y`, `music_size`)
    * HW Stats (`stats_x`, `stats_y`, `stats_size`)
    * Lyrics (`lyrics_x`, `lyrics_y`, `lyrics_size`)
    * Next Song card (`next_song_x`, `next_song_y`, `next_song_size`)
    * Weather (`weather_x`, `weather_y`, `weather_size`)
* **Component Display Switches**:
  * Toggles (`show_stats`, `show_gpu_fan`, `show_lyrics`, `show_next_song`, `show_weather`) to enable or disable individual widgets.
  * `weather_unit`: Drop-down selector to switch weather temperature calculations between Celsius and Fahrenheit.
