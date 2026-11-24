# Mono

Minimalist Minecraft launcher built with **Tauri v2**, **React**, **TypeScript**, and **Rust**.

## Features

- **Instances & Loaders** – Create, clone, reorder, and favorite instances with per-instance RAM, JVM arguments, window size, and custom icons. Supports **Vanilla**, **Fabric**, **Quilt**, **Forge**, **NeoForge**, and **Custom** loaders.
- **Accounts** – Switch between **Microsoft** (Device Code Flow), **Ely.by**, and **Offline** accounts.
- **Modrinth & CurseForge** – Browse and install mods, resource packs, shaders, and modpacks with dependency resolution and update checks (CurseForge requires an API key in settings).
- **Modpacks (`.mrpack`)** – Import, install, and export `.mrpack` modpacks, including handling restricted/manual downloads.
- **Instance Management** – Toggle/delete installed content, add local files, inspect worlds and screenshots, and view live launch/crash console logs.
- **Java Management** – Auto-detect installed Java runtimes, probe custom paths, or download Java 8 / 17 / 21 / 25 runtimes directly.
- **Localization** – English and Russian UI (`en` / `ru`).

## Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, Vite, Lucide Icons
- **Backend:** Rust, Tauri v2 (`tauri-plugin-dialog`, `tauri-plugin-opener`, `reqwest`, `tokio`)

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (on Windows: MSVC build tools + WebView2)

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

> Note: `bundle.active` in `src-tauri/tauri.conf.json` is currently set to `false` (builds the executable without installers). Enable it or pass `--bundles` if you want `.msi` / `.nsis` installers.

## Configuration

Optional settings available inside the app:
- **CurseForge API Key** – Required for searching and downloading from CurseForge.
- **MSA Client ID** – Optional custom Microsoft Azure app client ID for Device Code authentication.
