//! Extra per-instance features:
//! - Custom & modpack instance icons
//! - Local content import (file picker + drag & drop)
//! - One-click content update checking & applying (Modrinth batch hash API + CurseForge)
//! - Worlds (`saves/`) listing, NBT LevelName reader, folder ops
//! - Screenshots (`screenshots/`) listing, lazy data-URL loader, folder ops

use crate::models::{
    ContentMetaEntry, ContentUpdate, Instance, LoaderType, ScreenshotInfo, WorldInfo,
};
use crate::{curseforge, modrinth, storage};
use base64::Engine;
use chrono::{DateTime, Utc};
use flate2::read::GzDecoder;
use reqwest::Client;
use serde::Deserialize;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub fn sha1_file(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex::encode(hasher.finalize()))
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total += meta.len();
            } else if meta.is_dir() {
                total += dir_size(&p);
            }
        }
    }
    total
}

fn system_time_iso(st: std::time::SystemTime) -> String {
    let dt: DateTime<Utc> = st.into();
    dt.to_rfc3339()
}

fn shared_http() -> Result<Client, String> {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = Client::builder()
        .user_agent("MonoLauncher/0.1.0 (https://github.com/mono-launcher)")
        .gzip(true)
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

// ---------------------------------------------------------------------------
// Instance icons
// ---------------------------------------------------------------------------

pub fn set_instance_icon(instance_id: &str, image_path: Option<&str>) -> Result<Instance, String> {
    let mut inst = storage::load_instances()
        .into_iter()
        .find(|i| i.id == instance_id)
        .ok_or_else(|| "Instance not found".to_string())?;

    match image_path {
        Some(p) if !p.trim().is_empty() => {
            let path = Path::new(p.trim());
            let bytes = fs::read(path).map_err(|e| format!("Cannot read image: {e}"))?;
            if bytes.len() > 6 * 1024 * 1024 {
                return Err("Image is too large (max 6 MB)".into());
            }
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let mime = match ext.as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "gif" => "image/gif",
                "ico" => "image/x-icon",
                _ => "image/png",
            };
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            inst.icon_url = Some(format!("data:{mime};base64,{b64}"));
        }
        _ => {
            inst.icon_url = None;
        }
    }
    storage::save_instance(&inst)?;
    Ok(inst)
}

// ---------------------------------------------------------------------------
// Local content import (picker + drag & drop)
// ---------------------------------------------------------------------------

pub fn add_local_content(instance_id: &str, kind: &str, paths: &[String]) -> Result<u32, String> {
    let dest_dir = storage::instance_game_dir(instance_id).join(storage::content_subfolder(kind));
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let mut added = 0u32;

    for raw in paths {
        let src = Path::new(raw);
        if !src.is_file() {
            continue;
        }
        let Some(fname) = src.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let low = fname.to_lowercase();
        let valid = match kind {
            "mod" => low.ends_with(".jar"),
            _ => low.ends_with(".zip") || low.ends_with(".jar"),
        };
        if !valid {
            continue;
        }
        let dest = dest_dir.join(&fname);
        fs::copy(src, &dest).map_err(|e| format!("Failed copying {fname}: {e}"))?;
        added += 1;
    }
    Ok(added)
}

// ---------------------------------------------------------------------------
// One-click content updates (Modrinth batch hash API + CurseForge)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MrUpdateVersion {
    id: String,
    project_id: String,
    version_number: String,
    files: Vec<MrUpdateFile>,
}

#[derive(Deserialize)]
struct MrUpdateFile {
    filename: String,
    primary: bool,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

fn kind_to_catalog_type(kind: &str) -> &'static str {
    match kind {
        "shaderpack" => "shader",
        "resourcepack" => "resourcepack",
        _ => "mod",
    }
}

pub async fn check_content_updates(
    instance_id: &str,
    kind: &str,
) -> Result<Vec<ContentUpdate>, String> {
    let inst = storage::load_instances()
        .into_iter()
        .find(|i| i.id == instance_id)
        .ok_or_else(|| "Instance not found".to_string())?;

    let dir = storage::instance_game_dir(instance_id).join(storage::content_subfolder(kind));
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let meta_map = storage::load_content_meta(instance_id);
    let mut mr_candidates: Vec<(String, String, String, Option<ContentMetaEntry>)> = Vec::new(); // (filename, base_name, sha1, meta)
    let mut cf_candidates: Vec<(String, String, ContentMetaEntry)> = Vec::new(); // (filename, base_name, meta)

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        let base_name = filename.trim_end_matches(".disabled").to_string();
        let low = base_name.to_lowercase();
        let valid = match kind {
            "mod" => low.ends_with(".jar"),
            _ => low.ends_with(".zip") || low.ends_with(".jar"),
        };
        if !valid {
            continue;
        }

        let meta = meta_map.get(&base_name).cloned();
        if let Some(ref m) = meta {
            if m.source.as_deref() == Some("curseforge") && m.project_id.is_some() {
                cf_candidates.push((filename, base_name, m.clone()));
                continue;
            }
        }
        if let Some(sha1) = sha1_file(&path) {
            mr_candidates.push((filename, base_name, sha1, meta));
        }
    }

    let mut updates: Vec<ContentUpdate> = Vec::new();
    let client = shared_http()?;

    // 1. Single batch request to Modrinth `/v2/version_files/update`
    if !mr_candidates.is_empty() {
        let hashes: Vec<String> = mr_candidates.iter().map(|(_, _, h, _)| h.clone()).collect();
        let loaders: Vec<String> = match kind {
            "shaderpack" => vec![
                "iris".into(),
                "optifine".into(),
                "canvas".into(),
                "minecraft".into(),
            ],
            "resourcepack" => vec!["minecraft".into()],
            _ => match inst.loader {
                LoaderType::Fabric => vec!["fabric".into()],
                LoaderType::Quilt => vec!["quilt".into(), "fabric".into()],
                LoaderType::Forge => vec!["forge".into()],
                LoaderType::Neoforge => vec!["neoforge".into()],
                LoaderType::Vanilla | LoaderType::Custom => Vec::new(),
            },
        };

        if !loaders.is_empty() {
            let resp = client
                .post("https://api.modrinth.com/v2/version_files/update")
                .json(&serde_json::json!({
                    "hashes": hashes,
                    "algorithm": "sha1",
                    "loaders": loaders,
                    "game_versions": [inst.mc_version.clone()],
                }))
                .send()
                .await;

            if let Ok(r) = resp {
                if r.status().is_success() {
                    if let Ok(map) = r.json::<HashMap<String, MrUpdateVersion>>().await {
                        for (filename, _base, sha1, meta) in &mr_candidates {
                            if let Some(ver) = map.get(sha1) {
                                let primary = ver
                                    .files
                                    .iter()
                                    .find(|f| f.primary)
                                    .or_else(|| ver.files.first());
                                if let Some(pf) = primary {
                                    let latest_sha1 = pf.hashes.get("sha1").map(|s| s.as_str());
                                    if latest_sha1
                                        .map(|ls| !ls.eq_ignore_ascii_case(sha1))
                                        .unwrap_or(false)
                                    {
                                        updates.push(ContentUpdate {
                                            filename: filename.clone(),
                                            source: "modrinth".into(),
                                            project_id: ver.project_id.clone(),
                                            current_version: meta
                                                .as_ref()
                                                .and_then(|m| m.version.clone()),
                                            latest_version_id: ver.id.clone(),
                                            latest_version_number: ver.version_number.clone(),
                                            latest_filename: pf.filename.clone(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Concurrent CurseForge version checks for CurseForge-tracked items
    if !cf_candidates.is_empty() {
        let sem = Arc::new(tokio::sync::Semaphore::new(6));
        let catalog_type = kind_to_catalog_type(kind).to_string();
        let mc_ver = inst.mc_version.clone();
        let loader_str = match inst.loader {
            LoaderType::Fabric => Some("fabric".to_string()),
            LoaderType::Quilt => Some("quilt".to_string()),
            LoaderType::Forge => Some("forge".to_string()),
            LoaderType::Neoforge => Some("neoforge".to_string()),
            LoaderType::Vanilla | LoaderType::Custom => None,
        };

        let mut handles = Vec::new();
        for (filename, base_name, meta) in cf_candidates {
            let Some(pid) = meta.project_id.clone() else {
                continue;
            };
            let sem = sem.clone();
            let ctype = catalog_type.clone();
            let mc = mc_ver.clone();
            let ldr = loader_str.clone();
            handles.push(tokio::spawn(async move {
                let _permit = sem.acquire().await.ok()?;
                let vers = curseforge::get_project_versions(
                    &pid,
                    &ctype,
                    Some(&mc),
                    ldr.as_deref(),
                )
                .await
                .ok()?;
                let best = vers
                    .into_iter()
                    .find(|v| v.compatible && !v.download_url.is_empty())?;
                if best.filename.eq_ignore_ascii_case(&base_name) {
                    return None;
                }
                if let Some(ref cur) = meta.version {
                    if cur == &best.version_number || cur == &best.name {
                        return None;
                    }
                }
                Some(ContentUpdate {
                    filename,
                    source: "curseforge".into(),
                    project_id: pid,
                    current_version: meta.version,
                    latest_version_id: best.id,
                    latest_version_number: best.version_number,
                    latest_filename: best.filename,
                })
            }));
        }
        for h in handles {
            if let Ok(Some(u)) = h.await {
                updates.push(u);
            }
        }
    }

    Ok(updates)
}

pub async fn apply_content_update(
    instance_id: &str,
    kind: &str,
    current_filename: &str,
    source: &str,
    project_id: &str,
    version_id: &str,
) -> Result<String, String> {
    let inst = storage::load_instances()
        .into_iter()
        .find(|i| i.id == instance_id)
        .ok_or_else(|| "Instance not found".to_string())?;

    let was_disabled = current_filename.ends_with(".disabled");
    let old_base = current_filename.trim_end_matches(".disabled").to_string();
    let catalog_type = kind_to_catalog_type(kind);
    let loader_str = match inst.loader {
        LoaderType::Fabric => Some("fabric"),
        LoaderType::Quilt => Some("quilt"),
        LoaderType::Forge => Some("forge"),
        LoaderType::Neoforge => Some("neoforge"),
        LoaderType::Vanilla | LoaderType::Custom => None,
    };

    let res = if source == "curseforge" {
        curseforge::install_project_version(
            instance_id,
            project_id,
            Some(version_id),
            catalog_type,
            &inst.mc_version,
            loader_str,
            true,
        )
        .await?
    } else {
        modrinth::install_project_version(
            instance_id,
            project_id,
            Some(version_id),
            catalog_type,
            &inst.mc_version,
            loader_str,
            true,
        )
        .await?
    };

    let dir = storage::instance_game_dir(instance_id).join(storage::content_subfolder(kind));
    if !res.filename.eq_ignore_ascii_case(&old_base) {
        let _ = fs::remove_file(dir.join(current_filename));
        let mut meta_map = storage::load_content_meta(instance_id);
        if meta_map.remove(&old_base).is_some() {
            if let Ok(json) = serde_json::to_string_pretty(&meta_map) {
                let _ = fs::write(
                    storage::instance_dir(instance_id).join("content-meta.json"),
                    json,
                );
            }
        }
    }

    if was_disabled {
        let fresh = dir.join(&res.filename);
        let disabled_name = format!("{}.disabled", res.filename);
        let disabled_path = dir.join(&disabled_name);
        if fresh.exists() {
            let _ = fs::rename(&fresh, &disabled_path);
            return Ok(disabled_name);
        }
    }
    Ok(res.filename)
}

// ---------------------------------------------------------------------------
// Worlds (`saves/`)
// ---------------------------------------------------------------------------

/// Extracts the `LevelName` UTF-8 string tag (`TAG_String = 0x08`) from gzipped `level.dat`.
fn read_level_dat_name(level_dat: &Path) -> Option<String> {
    let file = fs::File::open(level_dat).ok()?;
    let mut decoder = GzDecoder::new(file);
    let mut buf = Vec::new();
    decoder.read_to_end(&mut buf).ok()?;

    // TAG_String (0x08) + name length 9 (0x00, 0x09) + "LevelName"
    let needle = b"\x08\x00\x09LevelName";
    let pos = buf.windows(needle.len()).position(|w| w == needle)?;
    let val_pos = pos + needle.len();
    if val_pos + 2 > buf.len() {
        return None;
    }
    let str_len = u16::from_be_bytes([buf[val_pos], buf[val_pos + 1]]) as usize;
    let start = val_pos + 2;
    if start + str_len > buf.len() {
        return None;
    }
    let name = String::from_utf8_lossy(&buf[start..start + str_len]).to_string();
    if name.trim().is_empty() {
        None
    } else {
        Some(name)
    }
}

pub fn list_worlds(instance_id: &str) -> Vec<WorldInfo> {
    let saves_dir = storage::instance_game_dir(instance_id).join("saves");
    let Ok(entries) = fs::read_dir(saves_dir) else {
        return Vec::new();
    };
    let mut worlds = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let level_dat = path.join("level.dat");
        if !level_dat.is_file() {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().to_string();
        let display_name = read_level_dat_name(&level_dat).unwrap_or_else(|| folder_name.clone());
        let icon_data_url = fs::read(path.join("icon.png")).ok().map(|bytes| {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            format!("data:image/png;base64,{b64}")
        });
        let last_played = fs::metadata(&level_dat)
            .or_else(|_| entry.metadata())
            .ok()
            .and_then(|m| m.modified().ok())
            .map(system_time_iso);
        let size_bytes = dir_size(&path);

        worlds.push(WorldInfo {
            folder_name,
            display_name,
            icon_data_url,
            last_played,
            size_bytes,
        });
    }
    worlds.sort_by(|a, b| b.last_played.cmp(&a.last_played));
    worlds
}

fn safe_child_dir(base: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("Invalid name".into());
    }
    Ok(base.join(name))
}

pub fn open_world_folder(instance_id: &str, folder_name: &str) -> Result<(), String> {
    let saves = storage::instance_game_dir(instance_id).join("saves");
    let dir = safe_child_dir(&saves, folder_name)?;
    if !dir.is_dir() {
        return Err("World folder not found".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn delete_world(instance_id: &str, folder_name: &str) -> Result<(), String> {
    let saves = storage::instance_game_dir(instance_id).join("saves");
    let dir = safe_child_dir(&saves, folder_name)?;
    if dir.is_dir() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Screenshots (`screenshots/`)
// ---------------------------------------------------------------------------

pub fn list_screenshots(instance_id: &str) -> Vec<ScreenshotInfo> {
    let dir = storage::instance_game_dir(instance_id).join("screenshots");
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        let low = filename.to_lowercase();
        if !(low.ends_with(".png") || low.ends_with(".jpg") || low.ends_with(".jpeg") || low.ends_with(".webp")) {
            continue;
        }
        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_at = meta
            .and_then(|m| m.modified().ok())
            .map(system_time_iso);
        list.push(ScreenshotInfo {
            filename,
            modified_at,
            size_bytes,
        });
    }
    list.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    list
}

pub fn get_screenshot_data(instance_id: &str, filename: &str) -> Result<String, String> {
    let dir = storage::instance_game_dir(instance_id).join("screenshots");
    let path = safe_child_dir(&dir, filename)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let low = filename.to_lowercase();
    let mime = if low.ends_with(".jpg") || low.ends_with(".jpeg") {
        "image/jpeg"
    } else if low.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

pub fn open_screenshot(instance_id: &str, filename: &str) -> Result<(), String> {
    let dir = storage::instance_game_dir(instance_id).join("screenshots");
    let path = safe_child_dir(&dir, filename)?;
    if !path.is_file() {
        return Err("Screenshot not found".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn open_screenshots_folder(instance_id: &str) -> Result<(), String> {
    let dir = storage::instance_game_dir(instance_id).join("screenshots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn delete_screenshot(instance_id: &str, filename: &str) -> Result<(), String> {
    let dir = storage::instance_game_dir(instance_id).join("screenshots");
    let path = safe_child_dir(&dir, filename)?;
    if path.is_file() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
