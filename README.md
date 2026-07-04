<div align="center">

<img src="assets/mediadash-logo.png" alt="MediaDash logo" width="120">

# MediaDash

**A clean Plex dashboard for syncing, browsing, naming checks, media size insight, and file health scans.**

![GitHub repo size](https://img.shields.io/github/repo-size/TheKevinatorX/MediaDash?style=for-the-badge&logo=github&color=dc2626)
![GitHub last commit](https://img.shields.io/github/last-commit/TheKevinatorX/MediaDash?style=for-the-badge&logo=github&color=dc2626)
![GitHub issues](https://img.shields.io/github/issues/TheKevinatorX/MediaDash?style=for-the-badge&logo=github&color=dc2626)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-3.1-000000?style=for-the-badge&logo=flask&logoColor=white)

</div>

---

## ✨ What Is MediaDash?

MediaDash is a self-hosted web app that connects to your **Plex server** and gives you a cleaner way to inspect your media library. 

In simple terms:

> Plex is the library.  
> MediaDash is the control panel that helps you understand what is inside it.

It is built for homelab use, Docker deployment, and quick visual checks of media metadata, naming, and storage usage.

It is also mobile-friendly so you can view your media stats on-the-go.

---

## 🧭 Main Features

### 🏠 Home Dashboard

- Shows a high-level summary of your Plex libraries
- Displays movie/show totals and library stats
- Uses cached data when available so the UI stays fast
  - Optimal for large libraries

### 🔎 Browse + Sizes View

- Browse Plex libraries in table form
- Search by title, genre, year, and other metadata
- Use quick filters for ratings, years, subtitles, and more
- Customize visible columns for desktop and mobile view

### 🧾 Naming View

- Checks media naming against expected patterns
- Separates correct and incorrect entries
- Includes a built-in naming convention reference
- Useful for spotting messy file names before they become a bigger problem

### 📦 Storage Insight

- Reviews storage usage across libraries
- Helps identify large movies, shows, seasons, and episodes
- Useful when cleaning up space or understanding storage growth

### 🩺 File Health Scanner

- Scans mounted media files with `ffprobe`
- Flags unreadable files, missing streams, zero-byte files, and zero-duration media
- Resumes scans after restarts so long checks do not disappear halfway through

### ⚙️ Setup + Settings UI

- First-time setup is handled through the browser
- No `.env.example` or `.env.sample` is required

---

## 🖼️ Setup Screenshots

| Welcome | Connect |
|---|---|
| ![MediaDash welcome](assets/mediadash%20-%20welcome%20%281%29.png) | ![MediaDash connect](assets/mediadash%20-%20connect%20%282%29.png) |

| Configure | Launch |
|---|---|
| ![MediaDash configure](assets/mediadash%20-%20configure%20%283%29.png) | ![MediaDash launch](assets/mediadash%20-%20launch%20%284%29.png) |

---

## 🔐 First-Time Setup

MediaDash uses a browser-based setup flow.

You will need:

- Your Plex server URL
- Your Plex token
- The Plex libraries you want MediaDash to inspect
- Optional naming/settings preferences

Example Plex server URL:

```text
http://192.168.1.100:32400
```

---

## 🐳 Docker Compose

Use the published image when you want the simplest setup:

```yaml
services:
  mediadash:
    image: ghcr.io/thekevinatorx/mediadash:latest
    container_name: MediaDash
    restart: unless-stopped
    network_mode: bridge
    ports:
      - "5010:5010"
    environment:
      TZ: America/New_York
    volumes:
      - ./cache:/data/cache
      # Optional, but required for the Health page:
      - /media/Movies:/media/Movies:ro
      - /media/FullSeries:/media/FullSeries:ro
```

---

## 📜 License

MediaDash is licensed under the [MIT License](LICENSE).

© 2026 [TheKevinatorX](https://github.com/TheKevinatorX)
