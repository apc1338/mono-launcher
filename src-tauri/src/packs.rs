//! Shared machinery for installing and updating modpacks (Modrinth + CurseForge):
//! progress events, the per-instance pack record used for version switching, and
//! "pending downloads" for files whose authors forbid third-party distribution.

use crate::models::{ContentMetaEntry, Instance, LoaderType};
use crate::storage;
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProgressEvent {
    pub task_id: String,
    pub title: String,
    /// "prepare" | "download-pack" | "files" | "overrides" | "done" | "error"
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub message: String,
    pub instance_id: Option<String>,
}

pub struct Progress {
    app: Option<AppHandle>,
    task_id: Option<String>,
    title: Mutex<String>,
    instance_id: Mutex<Option<String>>,
}

impl Progress {
    pub fn new(app: Option<AppHandle>, task_id: Option<String>, title: &str) -> Self {
        Self {
            app,
            task_id,
            title: Mutex::new(title.to_string()),
            instance_id: Mutex::new(None),
        }
    }

    pub fn set_title(&self, title: &str) {
        if let Ok(mut t) = self.title.lock() {
            *t = title.to_string();
        }
    }

    pub fn set_instance(&self, id: &str) {
        if let Ok(mut i) = self.instance_id.lock() {
            *i = Some(id.to_string());
        }
    }

    pub fn emit(&self, stage: &str, current: u64, total: u64, message: &str) {
        let (Some(app), Some(task_id)) = (&self.app, &self.task_id) else {
            return;
        };
        let title = self.title.lock().map(|t| t.clone()).unwrap_or_default();
        let instance_id = self.instance_id.lock().ok().and_then(|i| i.clone());
        let _ = app.emit(
            "pack-progress",
            PackProgressEvent {
                task_id: task_id.clone(),
                title,
                stage: stage.to_string(),
                current,
                total,
                message: message.to_string(),
                instance_id,
            },
        );
    }

    pub fn fail(&self, err: &str) {
        self.emit("error", 0, 0, err);
    }
}

// ---------------------------------------------------------------------------
// Pack record (modpack.json) and pending downloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModpackRecord {
    pub source: String, // "modrinth" | "curseforge"
    pub project_id: String,
    pub version_id: String,
    pub version_name: String,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub website_url: Option<String>,
    /// Paths (relative to the game dir) of content files that came from the pack.
    /// They are removed before switching to another pack version.
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDownload {
    pub project_id: String,
    pub file_id: String,
    pub file_name: String,
    pub display_name: String,
    pub page_url: String,
    /// "mods" | "resourcepacks" | "shaderpacks"
    pub target_dir: String,
    pub sha1: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInstallResult {
    pub instance: Instance,
    pub pending: Vec<PendingDownload>,
}

fn record_path(instance_id: &str) -> PathBuf {
    storage::instance_dir(instance_id).join("modpack.json")
}

fn pending_path(instance_id: &str) -> PathBuf {
    storage::instance_dir(instance_id).join("pending_downloads.json")
}

pub fn load_record(instance_id: &str) -> Option<ModpackRecord> {
    let raw = fs::read_to_string(record_path(instance_id)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_record(instance_id: &str, record: &ModpackRecord) -> Result<(), String> {
    let json = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    fs::write(record_path(instance_id), json).map_err(|e| e.to_string())
}

pub fn load_pending(instance_id: &str) -> Vec<PendingDownload> {
    fs::read_to_string(pending_path(instance_id))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_pending(instance_id: &str, list: &[PendingDownload]) -> Result<(), String> {
    let path = pending_path(instance_id);
    if list.is_empty() {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Top-level folders whose files belong to the pack and must be cleaned on version change.
pub fn is_content_path(rel: &str) -> bool {
    let first = rel.split(['/', '\\']).next().unwrap_or("");
    matches!(first, "mods" | "resourcepacks" | "shaderpacks")
}

pub fn target_dir_for_class(class_id: Option<u32>) -> &'static str {
    match class_id {
        Some(12) => "resourcepacks",
        Some(6552) => "shaderpacks",
        _ => "mods",
    }
}

/// Creates a fresh instance, or — when `target` is set — reuses an existing one for a
/// pack version switch: removes files of the previous pack version and updates the
/// game/loader versions while keeping the user's own mods and settings.
pub fn prepare_instance(
    target: Option<&str>,
    name: &str,
    mc_version: String,
    loader: LoaderType,
    loader_version: Option<String>,
    icon_url: Option<String>,
) -> Result<Instance, String> {
    if let Some(id) = target {
        let mut inst = storage::load_instances()
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| "Instance not found".to_string())?;
        if let Some(old) = load_record(id) {
            let game_dir = storage::instance_game_dir(id);
            for rel in &old.files {
                let p = game_dir.join(rel);
                let _ = fs::remove_file(&p);
                let _ = fs::remove_file(PathBuf::from(format!("{}.disabled", p.to_string_lossy())));
            }
        }
        save_pending(id, &[])?;
        inst.mc_version = mc_version;
        inst.loader = loader;
        inst.loader_version = loader_version;
        if inst.icon_url.is_none() && icon_url.is_some() {
            inst.icon_url = icon_url;
        }
        storage::save_instance(&inst)?;
        return Ok(inst);
    }

    let settings = storage::load_settings();
    let inst = Instance {
        id: Uuid::new_v4().to_string(),
        name: if name.trim().is_empty() { "Modpack".to_string() } else { name.trim().to_string() },
        mc_version,
        loader,
        loader_version,
        ram_mb: settings.default_ram_mb.max(4096),
        jvm_args: String::new(),
        java_path: None,
        java_major: None,
        window_width: settings.default_width,
        window_height: settings.default_height,
        fullscreen: settings.default_fullscreen,
        created_at: Utc::now().to_rfc3339(),
        last_played: None,
        play_time_sec: 0,
        favorite: false,
        sort_order: None,
        icon_url,
        edition: "java".to_string(),
    };
    storage::save_instance(&inst)?;
    Ok(inst)
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

fn sha1_hex(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex::encode(hasher.finalize()))
}

/// Downloads `url` into `dest` (atomically via a temp file), verifying SHA-1 when known.
/// Skips the download if a file with the right hash/size already exists.
pub async fn download_verified(
    client: &Client,
    url: &str,
    dest: &Path,
    sha1: Option<&str>,
    size: u64,
) -> Result<(), String> {
    if dest.is_file() {
        let ok = match sha1 {
            Some(h) => sha1_hex(dest).map(|d| d.eq_ignore_ascii_case(h)).unwrap_or(false),
            None => size == 0 || fs::metadata(dest).map(|m| m.len() == size).unwrap_or(false),
        };
        if ok {
            return Ok(());
        }
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut last_err = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(600 * attempt)).await;
        }
        let resp = match client.get(url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("HTTP {}", r.status());
                continue;
            }
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        if let Some(h) = sha1 {
            let got = hex::encode(Sha1::digest(&bytes));
            if !got.eq_ignore_ascii_case(h) {
                last_err = "checksum mismatch".to_string();
                continue;
            }
        }
        let tmp = dest.with_extension("part");
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Err(format!("Failed to download {name}: {last_err}"))
}

/// Downloads a pack archive with byte-level progress.
pub async fn download_archive(
    client: &Client,
    url: &str,
    dest: &Path,
    progress: &Progress,
    headers: &[(&str, &str)],
) -> Result<(), String> {
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let mut resp = req.send().await.map_err(|e| format!("Pack download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Pack download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    progress.emit("download-pack", 0, total, "");
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        std::io::Write::write_all(&mut out, &chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done - last_emit > 256 * 1024 || (total > 0 && done >= total) {
            last_emit = done;
            progress.emit("download-pack", done, total, "");
        }
    }
    Ok(())
}

/// Extracts `<prefix>/...` entries of a pack archive into the game dir.
/// Returns relative paths of extracted content files (mods/resourcepacks/shaderpacks).
pub fn extract_overrides(
    archive_path: &Path,
    prefixes: &[String],
    game_dir: &Path,
    progress: &Progress,
) -> Result<Vec<String>, String> {
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid archive: {e}"))?;
    let total = archive.len() as u64;
    let mut content = Vec::new();
    progress.emit("overrides", 0, total, "");

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let Some(rel) = prefixes.iter().find_map(|p| {
            let p = format!("{}/", p.trim_end_matches('/'));
            name.strip_prefix(&p).map(|s| s.to_string())
        }) else {
            continue;
        };
        if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
            continue;
        }
        let out_path = game_dir.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        if is_content_path(&rel) {
            content.push(rel);
        }
        if i % 20 == 0 {
            progress.emit("overrides", i as u64, total, "");
        }
    }
    progress.emit("overrides", total, total, "");
    Ok(content)
}

pub fn save_meta_bulk(instance_id: &str, entries: Vec<(String, ContentMetaEntry)>) {
    if entries.is_empty() {
        return;
    }
    let mut map = storage::load_content_meta(instance_id);
    for (filename, entry) in entries {
        map.insert(filename.trim_end_matches(".disabled").to_string(), entry);
    }
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = fs::write(storage::instance_dir(instance_id).join("content-meta.json"), json);
    }
}

// ---------------------------------------------------------------------------
// Manual downloads (authors that disallow third-party distribution)
// ---------------------------------------------------------------------------

/// "name (1).jar" -> "name.jar" (browsers add this suffix to duplicate downloads).
fn strip_dup_suffix(name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    if let Some(open) = stem.rfind(" (") {
        let inner = &stem[open + 2..];
        if inner.len() > 1
            && inner.ends_with(')')
            && inner[..inner.len() - 1].chars().all(|c| c.is_ascii_digit())
        {
            return format!("{}{}", &stem[..open], ext);
        }
    }
    name.to_string()
}

/// Looks for manually downloaded files (in the user's Downloads folder and in
/// `extra_paths`), copies matches into the instance and returns what is still missing.
pub fn resolve_pending(instance_id: &str, extra_paths: &[String]) -> Result<Vec<PendingDownload>, String> {
    let pending = load_pending(instance_id);
    if pending.is_empty() {
        return Ok(pending);
    }

    let mut candidates: Vec<PathBuf> = extra_paths.iter().map(PathBuf::from).collect();
    if let Some(dl) = dirs::download_dir() {
        if let Ok(entries) = fs::read_dir(dl) {
            candidates.extend(entries.flatten().map(|e| e.path()).filter(|p| p.is_file()));
        }
    }

    let game_dir = storage::instance_game_dir(instance_id);
    let mut record = load_record(instance_id);
    let mut remaining = Vec::new();

    for p in pending {
        let found = candidates.iter().find(|c| {
            let Some(fname) = c.file_name().map(|n| n.to_string_lossy().to_string()) else {
                return false;
            };
            let explicit = extra_paths.iter().any(|e| Path::new(e) == c.as_path());
            let name_ok = strip_dup_suffix(&fname).eq_ignore_ascii_case(&p.file_name);
            if !name_ok && !explicit {
                return false;
            }
            if p.size > 0 {
                if let Ok(m) = fs::metadata(c) {
                    if m.len() != p.size {
                        return false;
                    }
                }
            }
            match &p.sha1 {
                Some(h) => sha1_hex(c).map(|d| d.eq_ignore_ascii_case(h)).unwrap_or(false),
                None => name_ok,
            }
        });

        match found {
            Some(src) => {
                let rel = format!("{}/{}", p.target_dir, p.file_name);
                let dest = game_dir.join(&rel);
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::copy(src, &dest).map_err(|e| e.to_string())?;
                if let Some(r) = record.as_mut() {
                    if !r.files.contains(&rel) {
                        r.files.push(rel);
                    }
                }
            }
            None => remaining.push(p),
        }
    }

    if let Some(r) = &record {
        save_record(instance_id, r)?;
    }
    save_pending(instance_id, &remaining)?;
    Ok(remaining)
}
