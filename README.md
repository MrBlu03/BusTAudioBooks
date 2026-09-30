# 🎧 BusTAudio — Premium Stremio Audiobook & Comics Addon

A powerful, high-performance Stremio addon that finds audiobooks and resolves **direct playable / downloadable streams through your TorBox account**. 

Every user installs the addon with their own TorBox API key embedded into the install URL, ensuring zero shared server state, private quota usage, and no centralized database.

---

## ⚡ Key Features

- **⚡ Instant vs Uncached Detection**: Automatically queries TorBox for cached torrents in real time and floats them to the top tagged with `⚡ Instant`.
- **📚 Smart Series Cataloging & Dual-Order Seasons**:
  - Automatically identifies book series and groups books together under a clean series overview.
  - **Season 1 (Release / Publication Order)**: Experience the series in the sequence the author published them.
  - **Season 2 (Chronological Story Order)**: Follow the in-universe narrative timeline.
  - Eliminates duplicate torrent releases and groups multiple parts/files seamlessly.
- **🎨 Rich Metadata & Chapters**: Enriches titles with high-resolution cover art, comprehensive synopses, author bios, genres, and duration via Audnexus, Google Books, and Open Library.
- **🎯 Intelligent Search**: Built-in query normalization (e.g., expanding `starwars` or `spiderman`), typo tolerance, fuzzy title matching, and noise stripping.
- **🌟 Personalized Recommendations (Nuvio Integration)**:
  - Synchronizes with your Nuvio reading library.
  - Automatically generates a dynamic "Recommended For You" catalog with smart series fallbacks.
- **📱 Companion Mobile App & Comics Reader**:
  - Fully compatible with the [BusTAudioBooks Mobile App](https://github.com/AFK-Goblin/BusTAudioBooks-App).
  - Background offline downloads, lock-screen controls, sleep timer, persistent playback speed, and chapter seeking.
  - Dedicated **Comics** tab supporting `.cbz`, `.cbr`, and `.pdf` archives with a built-in vertical reader.
- **🔒 Privacy & Security by Design**:
  - Zero hardcoded credentials or keys in version control.
  - TorBox API keys live exclusively in each user's personal install URL.
  - Optional access token gate (`ACCESS_TOKENS`) for private family/friend hosting.

---

## 🏗️ Architecture

```
Stremio / Mobile App  ──▶  BusTAudio Addon (Port 7000)
                               │
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
 Jackett / ABB Scraping   TorBox API Engine     Audnexus / OpenLibrary
(Search torrent listings) (Cache check & DLs)   (Metadata & cover art)
       │                       │
 Cloudflare WARP +        Playable HTTPS
 FlareSolverr Proxy       Streams & Chapters
```

---

## 🚀 Quick Start (Self-Hosting with Docker)

The easiest and recommended way to host BusTAudio is using Docker Compose. The stack bundles:
1. **`bustaudio-backend`**: The Node.js addon server (port 7000).
2. **`bustaudio-jackett`**: Pre-configured torrent search indexer (port 9117).
3. **`bustaudio-flaresolverr`**: Bypasses Cloudflare bot detection seamlessly.
4. **`bustaudio-warp`**: Cloudflare WARP SOCKS5 proxy ensuring ISP blocks never stop searches.

### Step 1: Clone and Start

```bash
git clone git@github.com:MrBlu03/BusTAudioBooks.git
cd BusTAudioBooks

# Copy example environment configuration (optional)
cp .env.example .env

# Spin up all containers in the background
docker compose up -d
```

### Step 2: Enable the AudiobookBay Indexer (One-time, ~30 seconds)

1. Open **`http://localhost:9117`** in your browser (Jackett web UI).
2. Click **+ Add indexer**.
3. Search for `audiobookbay`, and click the blue **+** icon next to it.
4. *Done!* FlareSolverr and the backend will automatically route queries through Jackett.

---

## ⚙️ How to Configure & Install

### 1. Get your TorBox API Key
1. Go to [torbox.app](https://torbox.app) and log into your account.
2. Navigate to **Settings → API** and copy your **API Key**.

### 2. Configure the Addon
1. Open **`http://localhost:7000/configure`** (or your server's IP address, e.g. `http://192.168.1.50:7000/configure`).
2. Paste your **TorBox API Key**.
3. (Optional) Customize settings:
   - **Instant only**: Check this if you only ever want immediately streamable results.
   - **Access Token**: Enter the secret token if the instance is private.
4. Click **Generate Install Link**.

### 3. Add to Stremio
- **Desktop / Web**: Click **Install in Stremio** or copy the generated `stremio://...` link and paste it into the search bar in Stremio.
- **Mobile / Android TV**: Copy the HTTPS manifest link (e.g. `http://<ip>:7000/<config>/manifest.json`), open Stremio Settings → Addons → Paste addon URL, and click Add.

### 4. Add to the BusTAudioBooks Mobile App
1. Download and install the latest APK from the [BusTAudioBooks App Repository](https://github.com/AFK-Goblin/BusTAudioBooks-App).
2. On first launch, paste the manifest URL generated on your configure page.
3. Tap **Connect** and enjoy offline downloads, sleep timer, and lock-screen audio controls!

---

## 🌟 Setting Up Personal Recommendations (Nuvio)

BusTAudio can automatically sync your reading history and generate AI-driven audiobook recommendations:

1. In `.env`, provide your Nuvio account details:
   ```env
   NUVIO_EMAIL=your-email@example.com
   NUVIO_PASSWORD=your-password
   NUVIO_PROFILE_ID=1
   ```
2. Run the recommendation builder:
   ```bash
   npm run recs:refresh
   ```
3. To keep recommendations fresh automatically, run the daily scheduler:
   ```bash
   npm run recs:daily
   ```

---

## 🛠️ Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | Port the addon HTTP server listens on |
| `JACKETT_URL` | `http://jackett:9117` | URL of your Jackett / Prowlarr indexer |
| `JACKETT_API_KEY` | *(empty)* | Jackett API key (auto-loaded when using docker-compose) |
| `ABB_DOMAIN` | `audiobookbay.lu` | Fallback domain for direct AudiobookBay scraping |
| `INSTANT_ONLY` | `0` | Set to `1` to only return cached/instantly playable streams |
| `ACCESS_TOKENS` | *(empty)* | Comma-separated list of access tokens required to install |
| `COMIC_CATEGORIES` | `7030` | Torznab category IDs for Comics searches (mobile app) |
| `NUVIO_EMAIL` | *(empty)* | Email for Nuvio library recommendation synchronization |
| `NUVIO_PASSWORD` | *(empty)* | Password for Nuvio synchronization |
| `NUVIO_PROFILE_ID` | `1` | Profile number to sync recommendations for |

---

## 🧪 Testing & Verification

BusTAudio comes with a complete suite of unit and integration tests:

```bash
# Run unit tests (parsing, series ordering, deduplication, search normalization)
npm test

# Test recommendation serving and catalog metadata
npm run test:serve
```

---

## 🔒 Security & Privacy Notice

- **Never commit `.env` or personal tokens**: All credential files, indexer configs, and session caches are ignored by `.gitignore`.
- **TorBox keys remain private**: Keys are passed through the encrypted URL path between the user's client and the backend server.
- **Sharing with friends**: If hosting publicly, configure `ACCESS_TOKENS=friend1,friend2` so strangers cannot access your instance. Each friend enters their own TorBox key during setup.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
