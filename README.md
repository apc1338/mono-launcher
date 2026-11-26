# Mono

Minimalist Minecraft launcher built with **Tauri v2**, **React**, **TypeScript**, and **Rust**.

## Features

- **Instances & Loaders** – Create, clone, reorder, and favorite instances with per-instance RAM, JVM arguments, Java version override, window size, and custom icons. Supports **Java Edition** (**Vanilla**, **Fabric**, **Quilt**, **Forge**, **NeoForge**) and **Rust Edition** (**Horizon**, Minecraft 26.3).
- **Rust Edition (Horizon)** – Auto-detects local Horizon builds or imports a build folder / `.zip` archive, automatically downloads Java 25 and Minecraft 26.3 resources from Mojang, runs `horizon-prepare`, and launches `horizon-client` directly without a third-party launcher.
- **Accounts** – Switch between **Microsoft** (Device Code Flow), **Ely.by**, and **Offline** accounts.
- **Modrinth & CurseForge** – Browse and install mods, resource packs, shaders, and modpacks with batch selection, dependency preview/resolution, installed status detection, and update checks.
- **Modpacks (`.mrpack`)** – Import, install, and export `.mrpack` modpacks, including handling restricted/manual downloads.
- **Instance Management** – Toggle, sort, switch versions, or delete installed content, add local files, inspect worlds and screenshots, and view live launch/crash console logs.
- **Java Management** – Auto-detect installed Java runtimes, probe custom paths, force a specific Java version per instance, or download Java 8 / 17 / 21 / 25 runtimes directly.
- **Auto-Updates & Localization** – Checks GitHub releases on startup with in-place Windows updates; English and Russian UI (`en` / `ru`).

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
