use crate::models::{LauncherUpdateInfo, LauncherUpdateProgressEvent};
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

const REPO_OWNER: &str = "apc1338";
const REPO_NAME: &str = "mono-launcher";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

fn updater_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(format!("MonoLauncher/{CURRENT_VERSION}"))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

fn parse_semver(raw: &str) -> Vec<u64> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let main_part = trimmed.split(['-', '+']).next().unwrap_or(trimmed);
    main_part
        .split('.')
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let a = parse_semver(latest);
    let b = parse_semver(current);
    let len = a.len().max(b.len());
    for i in 0..len {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av != bv {
            return av > bv;
        }
    }
    false
}

fn pick_windows_exe(assets: &[GhAsset]) -> Option<&GhAsset> {
    let exes: Vec<&GhAsset> = assets
        .iter()
        .filter(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
        .collect();
    if exes.is_empty() {
        return None;
    }
    exes.iter()
        .copied()
        .find(|a| a.name.eq_ignore_ascii_case("mono-launcher.exe"))
        .or_else(|| {
            exes.iter().copied().find(|a| {
                let low = a.name.to_ascii_lowercase();
                !low.contains("setup") && !low.contains("installer")
            })
        })
        .or_else(|| exes.first().copied())
}

fn append_suffix(path: &std::path::Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

/// Removes leftover `.old` / `.new` files from a previous self-update.
pub fn cleanup_old_exe() {
    if let Ok(cur) = std::env::current_exe() {
        let _ = fs::remove_file(append_suffix(&cur, ".old"));
        let _ = fs::remove_file(append_suffix(&cur, ".new"));
        // Also clean legacy `.exe.new` if left behind
        let _ = fs::remove_file(cur.with_extension("exe.new"));
    }
}

pub async fn check_for_update() -> Result<Option<LauncherUpdateInfo>, String> {
    let client = updater_client()?;
    let url = format!("https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/releases/latest");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API HTTP {}", resp.status()));
    }

    let rel: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("Invalid GitHub release JSON: {e}"))?;

    if rel.draft || rel.prerelease {
        return Ok(None);
    }

    let latest_clean = rel.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    if !is_newer_version(&latest_clean, CURRENT_VERSION) {
        return Ok(None);
    }

    let Some(asset) = pick_windows_exe(&rel.assets) else {
        return Ok(None);
    };

    Ok(Some(LauncherUpdateInfo {
        current_version: CURRENT_VERSION.to_string(),
        latest_version: latest_clean,
        release_name: rel.name.unwrap_or_else(|| rel.tag_name.clone()),
        notes: rel.body.unwrap_or_default(),
        release_url: rel.html_url,
        download_url: asset.browser_download_url.clone(),
        asset_name: asset.name.clone(),
        asset_size: asset.size,
    }))
}

pub async fn download_and_apply_update(
    app: AppHandle,
    download_url: String,
) -> Result<(), String> {
    let allowed_prefix = format!("https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/download/");
    if !download_url.starts_with(&allowed_prefix)
        && !download_url.starts_with("https://objects.githubusercontent.com/")
    {
        return Err("Untrusted update download URL".into());
    }

    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Cannot resolve current executable path: {e}"))?;

    let staged_path = append_suffix(&current_exe, ".new");
    let backup_path = append_suffix(&current_exe, ".old");

    let _ = app.emit(
        "launcher-update-progress",
        LauncherUpdateProgressEvent {
            stage: "downloading".into(),
            downloaded: 0,
            total: 0,
        },
    );

    let client = updater_client()?;
    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed downloading update: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(&staged_path)
        .map_err(|e| format!("Cannot write update file next to launcher: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut header = [0u8; 2];
    let mut header_filled = 0usize;

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Download interrupted: {e}"))?;
        if header_filled < 2 {
            let need = (2 - header_filled).min(chunk.len());
            header[header_filled..header_filled + need].copy_from_slice(&chunk[..need]);
            header_filled += need;
        }
        file.write_all(&chunk)
            .map_err(|e| format!("Failed writing update file: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= 65_536 || (total > 0 && downloaded >= total) {
            last_emit = downloaded;
            let _ = app.emit(
                "launcher-update-progress",
                LauncherUpdateProgressEvent {
                    stage: "downloading".into(),
                    downloaded,
                    total,
                },
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    if downloaded < 1024 || &header != b"MZ" {
        let _ = fs::remove_file(&staged_path);
        return Err("Downloaded file is not a valid Windows executable".into());
    }

    let _ = app.emit(
        "launcher-update-progress",
        LauncherUpdateProgressEvent {
            stage: "applying".into(),
            downloaded,
            total: total.max(downloaded),
        },
    );

    #[cfg(target_os = "windows")]
    {
        // Windows allows renaming a running executable in-place.
        // Rename current -> .old, move .new -> current, spawn updated exe, exit current.
        let _ = fs::remove_file(&backup_path);
        fs::rename(&current_exe, &backup_path)
            .map_err(|e| format!("Failed moving current executable: {e}"))?;

        if let Err(e) = fs::rename(&staged_path, &current_exe) {
            // Roll back so the user is never left without the executable
            let _ = fs::rename(&backup_path, &current_exe);
            let _ = fs::remove_file(&staged_path);
            return Err(format!("Failed placing updated executable: {e}"));
        }

        std::process::Command::new(&current_exe)
            .spawn()
            .map_err(|e| format!("Failed launching updated executable: {e}"))?;

        app.exit(0);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = fs::remove_file(&staged_path);
        return Err("In-place executable update is only supported on Windows".into());
    }

    Ok(())
}
