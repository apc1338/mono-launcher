//! "Rust Edition" support: Horizon (https://playhorizon.dev) - an unofficial rewrite of
//! Minecraft: Java Edition 26.3 in Rust.
//! Runs completely standalone without the third-party Horizon launcher:
//! 1. Finds a Horizon game build on disk (`<data_root>/horizon/builds/<tag>` or
//!    `%APPDATA%/horizon-launcher/versions/<tag>`), or lets the user import a folder / `.zip`.
//! 2. Ensures Minecraft Java Edition 26.3 files (Java 25, version JSON, client.jar, server.jar,
//!    libraries, assets) are downloaded from Mojang into `<data_root>`.
//! 3. Runs `horizon-prepare --prepare --complete --progress json` if resources aren't ready yet.
//! 4. Launches `horizon-client` directly.

use crate::auth;
use crate::java;
use crate::minecraft::{
    download_file, emit_log, emit_progress, emit_status, get_version_manifest, http_client,
    rule_allows_windows, RunningMap,
};
use crate::models::{AccountType, Instance};
use crate::storage;
use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as TokioBufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Semaphore;

pub const RUST_EDITION: &str = "rust";
pub const HORIZON_MC_VERSION: &str = "26.3";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HorizonBuildStatus {
    pub found: bool,
    pub tag: Option<String>,
    pub path: Option<String>,
    pub prepared: bool,
}

pub struct LocalBuild {
    pub tag: String,
    pub dir: PathBuf,
    pub client: PathBuf,
    pub prepare: Option<PathBuf>,
    pub resources: PathBuf,
    pub prepared: bool,
}

fn client_exe_name() -> &'static str {
    if cfg!(windows) {
        "horizon-client.exe"
    } else {
        "horizon-client"
    }
}

fn prepare_exe_name() -> &'static str {
    if cfg!(windows) {
        "horizon-prepare.exe"
    } else {
        "horizon-prepare"
    }
}

fn launcher_exe_name() -> &'static str {
    if cfg!(windows) {
        "horizon-launcher.exe"
    } else {
        "horizon-launcher"
    }
}

pub fn builds_dir() -> PathBuf {
    storage::data_root().join("horizon").join("builds")
}

/// Scans Mono's own managed Horizon builds directory (`<data_root>/horizon/builds/`)
/// for an already-prepared `26.3` resources directory (`horizon-resources.json`).
fn find_shared_prepared_resources() -> Option<PathBuf> {
    let Ok(rd) = fs::read_dir(builds_dir()) else {
        return None;
    };
    for e in rd.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let res_dir = e
            .path()
            .join(".local")
            .join("horizon-client")
            .join(HORIZON_MC_VERSION);
        if res_dir.join("horizon-resources.json").is_file() {
            return Some(res_dir);
        }
    }
    None
}

/// Scans Mono's own managed Horizon builds directory for a standalone `horizon-prepare` binary.
fn find_shared_prepare_exe() -> Option<PathBuf> {
    let Ok(rd) = fs::read_dir(builds_dir()) else {
        return None;
    };
    for e in rd.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let candidate = e.path().join(prepare_exe_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn inspect_build_dir(dir: &Path, tag: String) -> Option<LocalBuild> {
    let client = dir.join(client_exe_name());
    if !client.is_file() {
        return None;
    }
    let dedicated_prepare = dir.join(prepare_exe_name());
    let prepare = if dedicated_prepare.is_file() {
        Some(dedicated_prepare)
    } else {
        find_shared_prepare_exe()
    };
    let local_resources = dir
        .join(".local")
        .join("horizon-client")
        .join(HORIZON_MC_VERSION);
    let (resources, prepared) = if local_resources.join("horizon-resources.json").is_file() {
        (local_resources, true)
    } else if let Some(shared) = find_shared_prepared_resources() {
        (shared, true)
    } else {
        (local_resources, false)
    };
    Some(LocalBuild {
        tag,
        dir: dir.to_path_buf(),
        client,
        prepare,
        resources,
        prepared,
    })
}

fn scan_builds_in(parent: &Path, require_installed_marker: bool) -> Vec<(std::time::SystemTime, LocalBuild)> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(parent) else {
        return out;
    };
    for e in rd.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        if require_installed_marker && !dir.join(".installed").exists() {
            continue;
        }
        let tag = e.file_name().to_string_lossy().to_string();
        if tag.starts_with('.') {
            continue;
        }
        if let Some(b) = inspect_build_dir(&dir, tag) {
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            out.push((mtime, b));
        }
    }
    out
}

/// Finds a Horizon game build inside Mono's own managed builds directory
/// (`<data_root>/horizon/builds/`), preferring already-prepared, then builds with
/// `horizon-prepare`, then newest.
/// Never scans external launcher folders on the computer.
pub fn find_build() -> Option<LocalBuild> {
    let mut managed = scan_builds_in(&builds_dir(), false);
    managed.sort_by_key(|(m, b)| (b.prepared, b.prepare.is_some(), *m));
    managed.pop().map(|(_, b)| b)
}

pub fn get_status() -> HorizonBuildStatus {
    match find_build() {
        Some(b) => HorizonBuildStatus {
            found: true,
            tag: Some(b.tag),
            path: Some(b.dir.to_string_lossy().to_string()),
            prepared: b.prepared,
        },
        None => HorizonBuildStatus {
            found: false,
            tag: None,
            path: None,
            prepared: false,
        },
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &to).map_err(|e| {
                format!(
                    "Failed writing '{}' (make sure horizon-client is closed): {e}",
                    to.display()
                )
            })?;
        }
    }
    Ok(())
}

/// Moves `src` into `dest`, safely handling Windows `ERROR_DIR_NOT_EMPTY` (os error 145)
/// when `dest` already exists or is briefly locked by Defender/Explorer.
fn replace_build_dir(src: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        if fs::remove_dir_all(dest).is_err() && dest.exists() {
            // Try moving the existing folder aside so rename can succeed cleanly
            if let Some(parent) = dest.parent() {
                let trash = parent.join(format!(".old-{}", uuid::Uuid::new_v4()));
                if fs::rename(dest, &trash).is_ok() {
                    let _ = fs::remove_dir_all(&trash);
                }
            }
        }
    }

    match fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Fallback: copy files over in-place (avoids Windows os error 145 on non-empty target)
            copy_dir_all(src, dest)?;
            let _ = fs::remove_dir_all(src);
            Ok(())
        }
    }
}

/// Imports a Horizon game build from a folder or a `.zip` archive into `<data_root>/horizon/builds/`.
pub fn import_build(source_path: &str) -> Result<HorizonBuildStatus, String> {
    let src = PathBuf::from(source_path);
    if !src.exists() {
        return Err("Selected path does not exist".into());
    }

    let root_builds = builds_dir();
    fs::create_dir_all(&root_builds).map_err(|e| e.to_string())?;

    let target_dir = if src.is_dir() {
        if inspect_build_dir(&src, String::new()).is_none() {
            return Err(format!("Folder does not contain {}", client_exe_name()));
        }
        let name = src
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("horizon-build")
            .to_string();
        let dest = root_builds.join(&name);
        if dest != src {
            let _ = fs::remove_dir_all(&dest);
            copy_dir_all(&src, &dest)?;
        }
        dest
    } else if src
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        let file = fs::File::open(&src).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {e}"))?;
        let name = src
            .file_stem()
            .and_then(|n| n.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("horizon-build")
            .to_string();
        let temp_dir = root_builds.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = f.enclosed_name() else {
                continue;
            };
            let out = temp_dir.join(rel);
            if f.is_dir() {
                fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            } else {
                if let Some(p) = out.parent() {
                    fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                let mut out_f = fs::File::create(&out).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut out_f).map_err(|e| e.to_string())?;
            }
        }
        // Handle archives that wrap everything in a single top-level directory
        let extracted_root = if inspect_build_dir(&temp_dir, String::new()).is_some() {
            temp_dir.clone()
        } else {
            let mut found_sub = None;
            if let Ok(rd) = fs::read_dir(&temp_dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() && inspect_build_dir(&p, String::new()).is_some() {
                        found_sub = Some(p);
                        break;
                    }
                }
            }
            match found_sub {
                Some(p) => p,
                None => {
                    let _ = fs::remove_dir_all(&temp_dir);
                    return Err(format!("Archive does not contain {}", client_exe_name()));
                }
            }
        };
        let dest = root_builds.join(&name);
        if extracted_root == temp_dir {
            replace_build_dir(&temp_dir, &dest)?;
        } else {
            replace_build_dir(&extracted_root, &dest)?;
            let _ = fs::remove_dir_all(&temp_dir);
        }
        dest
    } else {
        return Err("Select a Horizon build folder or .zip archive".into());
    };

    let tag = target_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "horizon".to_string());
    let b = inspect_build_dir(&target_dir, tag)
        .ok_or_else(|| "Imported build verification failed".to_string())?;
    Ok(HorizonBuildStatus {
        found: true,
        tag: Some(b.tag),
        path: Some(b.dir.to_string_lossy().to_string()),
        prepared: b.prepared,
    })
}

fn check_prepared(build: &LocalBuild) -> bool {
    if !build.prepared || !build.resources.join("horizon-resources.json").is_file() {
        return false;
    }
    let Some(prepare_exe) = build.prepare.as_ref() else {
        // Elyhorizon builds don't ship `horizon-prepare`; trust existing `horizon-resources.json`.
        return true;
    };
    // Only run `--check --root <dir>` when resources live inside `build.dir` itself.
    let local_res = build
        .dir
        .join(".local")
        .join("horizon-client")
        .join(HORIZON_MC_VERSION);
    if build.resources != local_res {
        return true;
    }
    let mut cmd = Command::new(prepare_exe);
    cmd.args(["--check", "--root"])
        .arg(&build.dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.status().is_ok_and(|s| s.success())
}

async fn ensure_prepared(
    app: &AppHandle,
    iid: &str,
    build: &LocalBuild,
    java_override: Option<&str>,
) -> Result<(), String> {
    if check_prepared(build) {
        return Ok(());
    }

    emit_log(
        app,
        iid,
        "info",
        "[Mono] Preparing Horizon resources from Minecraft Java Edition 26.3...".to_string(),
    );

    let root = storage::data_root();
    let client = http_client()?;

    // 1. Java 25 (required by horizon-prepare)
    emit_progress(app, iid, "java", 0, 1, "Java 25");
    let java_exe = java::resolve_java_for_instance(app, HORIZON_MC_VERSION, None, java_override, iid).await?;
    let java_home = Path::new(&java_exe)
        .parent()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not determine Java home directory".to_string())?;

    // 2. Vanilla 26.3 version JSON (prefer the exact manifest_sha1 pinned by research-lock.json
    // so Mojang republishes of 26.3.json never fail horizon-prepare's hash check).
    emit_progress(app, iid, "meta", 0, 1, HORIZON_MC_VERSION);
    let meta_dir = root.join("meta");
    fs::create_dir_all(&meta_dir).map_err(|e| e.to_string())?;
    let pinned_manifest_sha1 = fs::read_to_string(build.dir.join("research-lock.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.pointer("/minecraft/manifest_sha1")
                .and_then(|x| x.as_str())
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty());

    let version_meta_path = match pinned_manifest_sha1.as_deref() {
        Some(sha1) => meta_dir.join(format!("{HORIZON_MC_VERSION}-horizon-{sha1}.json")),
        None => meta_dir.join(format!("{HORIZON_MC_VERSION}.json")),
    };

    let version_json: Value = if let Some(sha1) = pinned_manifest_sha1.as_deref() {
        let pinned_url =
            format!("https://piston-meta.mojang.com/v1/packages/{sha1}/{HORIZON_MC_VERSION}.json");
        download_file(&client, &pinned_url, &version_meta_path, Some(sha1)).await?;
        let raw = fs::read_to_string(&version_meta_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    } else if version_meta_path.exists() {
        let raw = fs::read_to_string(&version_meta_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    } else {
        let manifest = get_version_manifest().await?;
        let entry = manifest
            .versions
            .into_iter()
            .find(|v| v.id == HORIZON_MC_VERSION)
            .ok_or_else(|| format!("Minecraft version {HORIZON_MC_VERSION} not found in Mojang manifest"))?;
        let raw = client
            .get(&entry.url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        fs::write(&version_meta_path, &raw).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    };

    // 3. Vanilla 26.3 client JAR & server JAR
    let client_jar_path = meta_dir.join("clients").join(format!("{HORIZON_MC_VERSION}.jar"));
    if let Some(dl) = version_json.pointer("/downloads/client") {
        let url = dl.get("url").and_then(|v| v.as_str()).unwrap_or_default();
        let sha1 = dl.get("sha1").and_then(|v| v.as_str());
        emit_progress(app, iid, "client", 0, 1, HORIZON_MC_VERSION);
        download_file(&client, url, &client_jar_path, sha1).await?;
    }

    let server_jar_path = meta_dir.join("servers").join(format!("{HORIZON_MC_VERSION}.jar"));
    if let Some(dl) = version_json.pointer("/downloads/server") {
        let url = dl.get("url").and_then(|v| v.as_str()).unwrap_or_default();
        let sha1 = dl.get("sha1").and_then(|v| v.as_str());
        emit_progress(app, iid, "client", 0, 1, "26.3 server");
        download_file(&client, url, &server_jar_path, sha1).await?;
    }

    // 4. Libraries
    let lib_root = root.join("libraries");
    let mut downloads_queue: Vec<(String, PathBuf, Option<String>)> = Vec::new();
    if let Some(libs) = version_json.get("libraries").and_then(|l| l.as_array()) {
        for lib in libs {
            if !rule_allows_windows(lib.get("rules")) {
                continue;
            }
            if let Some(artifact) = lib.pointer("/downloads/artifact") {
                if let (Some(url), Some(rel)) = (
                    artifact.get("url").and_then(|v| v.as_str()),
                    artifact.get("path").and_then(|v| v.as_str()),
                ) {
                    let sha1 = artifact.get("sha1").and_then(|v| v.as_str()).map(String::from);
                    downloads_queue.push((url.to_string(), lib_root.join(rel), sha1));
                }
            }
        }
    }
    let total_libs = downloads_queue.len() as u64;
    if total_libs > 0 {
        emit_progress(app, iid, "libraries", 0, total_libs, "Libraries");
        let max_dl = storage::load_settings().max_concurrent_downloads.clamp(1, 32) as usize;
        let sem = Arc::new(Semaphore::new(max_dl));
        let done = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut handles = Vec::new();
        for (url, dest, sha1) in downloads_queue {
            let permit_sem = sem.clone();
            let c = client.clone();
            let app_c = app.clone();
            let iid_c = iid.to_string();
            let done_c = done.clone();
            handles.push(tokio::spawn(async move {
                let _p = permit_sem.acquire().await.map_err(|e| e.to_string())?;
                download_file(&c, &url, &dest, sha1.as_deref()).await?;
                let n = done_c.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                if n % 4 == 0 || n == total_libs {
                    emit_progress(&app_c, &iid_c, "libraries", n, total_libs, "Libraries");
                }
                Ok::<(), String>(())
            }));
        }
        for h in handles {
            h.await.map_err(|e| e.to_string())??;
        }
    }

    // 5. Assets (textures, sounds, etc.)
    let assets_dir = root.join("assets");
    let asset_index_id = version_json
        .pointer("/assetIndex/id")
        .and_then(|v| v.as_str())
        .unwrap_or(HORIZON_MC_VERSION)
        .to_string();
    if let Some(asset_index_url) = version_json.pointer("/assetIndex/url").and_then(|v| v.as_str()) {
        let asset_index_sha1 = version_json.pointer("/assetIndex/sha1").and_then(|v| v.as_str());
        let idx_path = assets_dir.join("indexes").join(format!("{asset_index_id}.json"));
        download_file(&client, asset_index_url, &idx_path, asset_index_sha1).await?;
        let raw_idx = fs::read_to_string(&idx_path).map_err(|e| e.to_string())?;
        let idx_val: Value = serde_json::from_str(&raw_idx).map_err(|e| e.to_string())?;
        if let Some(objects) = idx_val.get("objects").and_then(|o| o.as_object()) {
            let mut missing = Vec::new();
            for (_name, obj) in objects {
                if let Some(hash) = obj.get("hash").and_then(|h| h.as_str()) {
                    if hash.len() >= 2 {
                        let prefix = &hash[0..2];
                        let dest = assets_dir.join("objects").join(prefix).join(hash);
                        if !dest.exists() {
                            let url = format!("https://resources.download.minecraft.net/{prefix}/{hash}");
                            missing.push((url, dest, hash.to_string()));
                        }
                    }
                }
            }
            let total_assets = missing.len() as u64;
            if total_assets > 0 {
                emit_progress(app, iid, "assets", 0, total_assets, "Assets");
                let sem = Arc::new(Semaphore::new(16));
                let done = Arc::new(std::sync::atomic::AtomicU64::new(0));
                let mut handles = Vec::new();
                for (url, dest, hash) in missing {
                    let ps = sem.clone();
                    let c = client.clone();
                    let app_c = app.clone();
                    let iid_c = iid.to_string();
                    let d_c = done.clone();
                    handles.push(tokio::spawn(async move {
                        let _p = ps.acquire().await.map_err(|e| e.to_string())?;
                        let _ = download_file(&c, &url, &dest, Some(&hash)).await;
                        let n = d_c.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        if n % 25 == 0 || n == total_assets {
                            emit_progress(&app_c, &iid_c, "assets", n, total_assets, "Assets");
                        }
                        Ok::<(), String>(())
                    }));
                }
                for h in handles {
                    let _ = h.await;
                }
            }
        }
    }

    // 6. Run horizon-prepare --prepare --complete --progress json (or fail cleanly if missing)
    let Some(prepare_exe) = build.prepare.clone() else {
        let launcher_exe = build.dir.join(launcher_exe_name());
        if launcher_exe.is_file() {
            return Err(format!(
                "This Horizon build does not include {} and no prepared 26.3 resources were found. Run '{}' once to prepare resources, or import a full Horizon build.",
                prepare_exe_name(),
                launcher_exe.display()
            ));
        }
        return Err(format!(
            "Missing {} and no prepared 26.3 resources found on disk.",
            prepare_exe_name()
        ));
    };

    emit_progress(app, iid, "prepare", 0, 100, "Preparing Horizon resources");
    let build_dir = build.dir.clone();
    let app_p = app.clone();
    let iid_p = iid.to_string();
    let status = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut cmd = Command::new(&prepare_exe);
        cmd.arg("--prepare")
            .arg("--complete")
            .args(["--progress", "json"])
            .arg("--root")
            .arg(&build_dir)
            .arg("--version-json")
            .arg(&version_meta_path)
            .arg("--client-jar")
            .arg(&client_jar_path)
            .arg("--server-jar")
            .arg(&server_jar_path)
            .arg("--libraries-dir")
            .arg(&lib_root)
            .arg("--assets-dir")
            .arg(&assets_dir)
            .arg("--java-home")
            .arg(&java_home)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Failed running horizon-prepare: {e}"))?;
        let stderr_handle = child.stderr.take().map(|err| {
            let (a, i) = (app_p.clone(), iid_p.clone());
            std::thread::spawn(move || {
                let mut lines = Vec::new();
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        if lines.len() < 16 {
                            lines.push(line.clone());
                        }
                        emit_log(&a, &i, "warn", format!("[horizon-prepare] {line}"));
                    }
                }
                lines
            })
        });
        let mut json_errors = Vec::new();
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(frac) = v.get("fraction").and_then(|f| f.as_f64()) {
                        let pct = (frac.clamp(0.0, 1.0) * 100.0).round() as u64;
                        emit_progress(&app_p, &iid_p, "prepare", pct, 100, "Preparing Horizon resources");
                    } else if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
                        emit_log(&app_p, &iid_p, "info", format!("[horizon-prepare] {msg}"));
                    } else if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                        if json_errors.len() < 8 {
                            json_errors.push(err.to_string());
                        }
                        emit_log(&app_p, &iid_p, "error", format!("[horizon-prepare] {err}"));
                    }
                } else if !line.trim().is_empty() {
                    emit_log(&app_p, &iid_p, "info", format!("[horizon-prepare] {line}"));
                }
            }
        }
        let exit = child.wait().map_err(|e| e.to_string())?;
        let stderr_lines = stderr_handle
            .and_then(|h| h.join().ok())
            .unwrap_or_default();
        if !exit.success() {
            let detail = if !json_errors.is_empty() {
                json_errors.join(" | ")
            } else if !stderr_lines.is_empty() {
                stderr_lines.join(" | ")
            } else {
                String::new()
            };
            return Err(if detail.is_empty() {
                format!("horizon-prepare exited with code {}", exit.code().unwrap_or(-1))
            } else {
                format!("horizon-prepare failed: {detail}")
            });
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;

    status
}

/// Migrates legacy `<instance>/horizon/*` data (saves, screenshots, options, etc.)
/// into the unified `<instance>/game/` folder without overwriting existing files.
pub fn migrate_legacy_horizon_dir(instance_id: &str) {
    let legacy = storage::instance_dir(instance_id).join("horizon");
    if !legacy.is_dir() {
        return;
    }
    let game_dir = storage::instance_game_dir(instance_id);
    let _ = fs::create_dir_all(&game_dir);

    fn merge_move(src: &Path, dst: &Path) {
        let Ok(entries) = fs::read_dir(src) else {
            return;
        };
        let _ = fs::create_dir_all(dst);
        for entry in entries.flatten() {
            let from = entry.path();
            let to = dst.join(entry.file_name());
            if from.is_dir() {
                if !to.exists() {
                    if fs::rename(&from, &to).is_err() {
                        merge_move(&from, &to);
                        let _ = fs::remove_dir(&from);
                    }
                } else {
                    merge_move(&from, &to);
                    let _ = fs::remove_dir(&from);
                }
            } else if from.is_file() && !to.exists() {
                if fs::rename(&from, &to).is_err() {
                    if fs::copy(&from, &to).is_ok() {
                        let _ = fs::remove_file(&from);
                    }
                }
            }
        }
    }

    merge_move(&legacy, &game_dir);
    let _ = fs::remove_dir_all(&legacy);
}

pub async fn launch(
    app: AppHandle,
    running: RunningMap,
    mut inst: Instance,
    quick_play_world: Option<String>,
) -> Result<(), String> {
    let iid = inst.id.clone();
    emit_status(&app, &iid, "launching", None);

    let build = match find_build() {
        Some(b) if b.prepared || b.prepare.is_some() => b,
        _ => {
            emit_log(
                &app,
                &iid,
                "info",
                "[Mono] Complete Horizon build not found locally. Downloading build archive..."
                    .to_string(),
            );
            if let Err(e) = download_latest_build(&app, Some(&iid)).await {
                emit_status(&app, &iid, "idle", None);
                return Err(e);
            }
            match find_build() {
                Some(b) => b,
                None => {
                    emit_status(&app, &iid, "idle", None);
                    return Err("Downloaded Horizon build verification failed".into());
                }
            }
        }
    };

    emit_log(
        &app,
        &iid,
        "info",
        format!("[Mono] Rust Edition (Horizon {}): {}", build.tag, build.client.display()),
    );

    if let Err(e) = ensure_prepared(&app, &iid, &build, inst.java_path.as_deref()).await {
        emit_status(&app, &iid, "idle", None);
        return Err(e);
    }

    migrate_legacy_horizon_dir(&iid);
    let home = storage::instance_game_dir(&iid);
    for sub in ["mods", "resourcepacks", "shaderpacks", "saves", "screenshots"] {
        let _ = fs::create_dir_all(home.join(sub));
    }
    let accounts = storage::load_accounts();
    let raw_account = accounts
        .active_id
        .as_ref()
        .and_then(|id| accounts.accounts.iter().find(|a| &a.id == id))
        .or_else(|| accounts.accounts.first())
        .cloned();
    let account = match raw_account {
        Some(acc) if acc.account_type == AccountType::Microsoft => {
            match auth::refresh_msa_account(&acc).await {
                Ok(a) => Some(a),
                Err(e) => {
                    emit_status(&app, &iid, "idle", None);
                    return Err(e);
                }
            }
        }
        other => other,
    };

    emit_progress(&app, &iid, "done", 1, 1, "Launching");
    emit_log(&app, &iid, "info", "[Mono] Starting Horizon client...".to_string());

    let mut cmd = Command::new(&build.client);
    cmd.current_dir(&home)
        .env("HORIZON_HOME", &home)
        .arg("--resources")
        .arg(&build.resources)
        .arg("--game-dir")
        .arg(&home)
        .arg("--home")
        .arg(&home);
    if let Some(acc) = account {
        if acc.account_type == AccountType::Microsoft {
            if let Some(token) = acc.access_token.as_deref().filter(|t| !t.is_empty()) {
                let sessions_dir = home.join("sessions");
                let _ = fs::create_dir_all(&sessions_dir);
                let session_path = sessions_dir.join(format!("session-{}.json", uuid::Uuid::new_v4()));
                let body = serde_json::json!({
                    "name": acc.username,
                    "uuid": acc.uuid.replace('-', ""),
                    "access_token": token,
                    "user_type": "msa",
                    "xuid": "",
                });
                fs::write(&session_path, body.to_string()).map_err(|e| e.to_string())?;
                cmd.arg("--session-file").arg(&session_path);
            } else {
                cmd.args(["--name", acc.username.as_str()]);
            }
        } else {
            cmd.args(["--name", acc.username.as_str()]);
        }
    }
    if inst.fullscreen {
        cmd.arg("--fullscreen");
    } else if inst.window_width > 0 && inst.window_height > 0 {
        cmd.args([
            "--width",
            &inst.window_width.to_string(),
            "--height",
            &inst.window_height.to_string(),
        ]);
    }
    if let Some(world) = quick_play_world.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        cmd.args(["--quickPlaySingleplayer", world]);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child: Child = cmd.spawn().map_err(|e| {
        emit_status(&app, &iid, "idle", None);
        format!("Failed starting Horizon client: {e}")
    })?;
    let pid = child.id();
    running.lock().map_err(|_| "Lock error")?.insert(iid.clone(), pid);

    inst.last_played = Some(Utc::now().to_rfc3339());
    let _ = storage::save_instance(&inst);
    emit_status(&app, &iid, "running", None);

    if let Some(out) = child.stdout.take() {
        let (a, i) = (app.clone(), iid.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                emit_log(&a, &i, "info", line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let (a, i) = (app.clone(), iid.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                emit_log(&a, &i, "error", line);
            }
        });
    }

    let started = std::time::Instant::now();
    std::thread::spawn(move || {
        let status = child.wait();
        if let Ok(mut map) = running.lock() {
            map.remove(&iid);
        }
        let elapsed = started.elapsed().as_secs();
        if let Some(mut updated) = storage::load_instances().into_iter().find(|i| i.id == iid) {
            updated.play_time_sec += elapsed;
            let _ = storage::save_instance(&updated);
        }
        let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
        emit_log(
            &app,
            &iid,
            if code == 0 { "info" } else { "error" },
            format!("[Mono] Horizon exited with code {code}"),
        );
        emit_status(&app, &iid, if code == 0 { "idle" } else { "crashed" }, Some(code));
        if storage::load_settings().close_on_launch {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }
    });
    Ok(())
}

// ============================================================================
// Tauri v2 async commands: prepare_horizon_assets & launch_horizon
// ============================================================================

/// Strongly-typed error enum serialized to JSON for frontend Promise rejections.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum LauncherError {
    InvalidPath(String),
    IoError(String),
    ProcessSpawnFailed(String),
    #[serde(rename_all = "camelCase")]
    PrepareFailed {
        exit_code: Option<i32>,
        details: String,
    },
}

impl std::fmt::Display for LauncherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPath(msg) => write!(f, "Invalid path: {msg}"),
            Self::IoError(msg) => write!(f, "I/O error: {msg}"),
            Self::ProcessSpawnFailed(msg) => write!(f, "Failed to spawn process: {msg}"),
            Self::PrepareFailed { exit_code, details } => {
                write!(f, "Prepare failed (code {:?}): {details}", exit_code)
            }
        }
    }
}

impl std::error::Error for LauncherError {}

impl From<std::io::Error> for LauncherError {
    fn from(err: std::io::Error) -> Self {
        Self::IoError(err.to_string())
    }
}

pub const EVENT_PREPARE_STARTED: &str = "horizon://prepare-started";
pub const EVENT_PREPARE_LOG: &str = "horizon://prepare-log";
pub const EVENT_PREPARE_FINISHED: &str = "horizon://prepare-finished";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareStartedPayload {
    pub vanilla_dir: String,
    pub output_dir: String,
    pub client_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareLogPayload {
    /// "stdout" or "stderr"
    pub stream: String,
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareFinishedPayload {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

/// Checks asynchronously whether `dir` exists and contains at least one entry.
async fn is_dir_non_empty(dir: &Path) -> Result<bool, LauncherError> {
    match tokio::fs::metadata(dir).await {
        Ok(meta) if meta.is_dir() => {
            let mut entries = tokio::fs::read_dir(dir).await?;
            Ok(entries.next_entry().await?.is_some())
        }
        Ok(_) => Err(LauncherError::InvalidPath(format!(
            "output_dir exists but is not a directory: {}",
            dir.display()
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(LauncherError::IoError(e.to_string())),
    }
}

/// Removes `output_dir` completely if it exists, preventing partial/corrupted assets
/// from being treated as valid on the next launch.
async fn cleanup_output_dir(output_dir: &Path) {
    if tokio::fs::try_exists(output_dir).await.unwrap_or(false) {
        if let Err(e) = tokio::fs::remove_dir_all(output_dir).await {
            eprintln!(
                "[horizon] Failed to clean up output_dir '{}': {e}",
                output_dir.display()
            );
        }
    }
}

/// Prepares Horizon assets from vanilla Minecraft resources using `horizon-client --prepare`.
///
/// - If `output_dir` already exists and is non-empty, returns `Ok(true)` immediately.
/// - Otherwise spawns `[client_path] --prepare --vanilla-dir [vanilla_dir] --output-dir [output_dir]`
///   via `tokio::process::Command`, streaming stdout/stderr to the frontend via `tauri::Emitter`.
/// - On any failure or non-zero exit code, cleans up `output_dir` and returns `Err(LauncherError)`.
#[tauri::command]
pub async fn prepare_horizon_assets(
    app: AppHandle,
    vanilla_dir: String,
    output_dir: String,
    client_path: String,
) -> Result<bool, LauncherError> {
    let out_path = PathBuf::from(&output_dir);
    let vanilla_path = PathBuf::from(&vanilla_dir);
    let client_bin = PathBuf::from(&client_path);

    if is_dir_non_empty(&out_path).await? {
        return Ok(true);
    }

    if !tokio::fs::try_exists(&client_bin).await.unwrap_or(false) {
        return Err(LauncherError::InvalidPath(format!(
            "Client binary not found: {}",
            client_bin.display()
        )));
    }
    if !tokio::fs::try_exists(&vanilla_path).await.unwrap_or(false) {
        return Err(LauncherError::InvalidPath(format!(
            "Vanilla directory not found: {}",
            vanilla_path.display()
        )));
    }

    tokio::fs::create_dir_all(&out_path).await?;

    let _ = app.emit(
        EVENT_PREPARE_STARTED,
        PrepareStartedPayload {
            vanilla_dir: vanilla_dir.clone(),
            output_dir: output_dir.clone(),
            client_path: client_path.clone(),
        },
    );

    let mut cmd = TokioCommand::new(&client_bin);
    cmd.arg("--prepare")
        .arg("--vanilla-dir")
        .arg(&vanilla_path)
        .arg("--output-dir")
        .arg(&out_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: hide console window during background asset extraction
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup_output_dir(&out_path).await;
            let msg = format!("Failed to spawn '{}': {e}", client_bin.display());
            let _ = app.emit(
                EVENT_PREPARE_FINISHED,
                PrepareFinishedPayload {
                    success: false,
                    exit_code: None,
                    error: Some(msg.clone()),
                },
            );
            return Err(LauncherError::ProcessSpawnFailed(msg));
        }
    };

    let stdout_task = child.stdout.take().map(|stdout| {
        let app_handle = app.clone();
        tokio::spawn(async move {
            let mut lines = TokioBufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_handle.emit(
                    EVENT_PREPARE_LOG,
                    PrepareLogPayload {
                        stream: "stdout".to_string(),
                        line,
                    },
                );
            }
        })
    });

    let stderr_task = child.stderr.take().map(|stderr| {
        let app_handle = app.clone();
        tokio::spawn(async move {
            let mut lines = TokioBufReader::new(stderr).lines();
            let mut captured = Vec::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if captured.len() < 32 {
                    captured.push(line.clone());
                }
                let _ = app_handle.emit(
                    EVENT_PREPARE_LOG,
                    PrepareLogPayload {
                        stream: "stderr".to_string(),
                        line,
                    },
                );
            }
            captured
        })
    });

    let wait_res = child.wait().await;

    if let Some(t) = stdout_task {
        let _ = t.await;
    }
    let stderr_tail = match stderr_task {
        Some(t) => t.await.unwrap_or_default(),
        None => Vec::new(),
    };

    match wait_res {
        Ok(status) if status.success() => {
            let _ = app.emit(
                EVENT_PREPARE_FINISHED,
                PrepareFinishedPayload {
                    success: true,
                    exit_code: status.code(),
                    error: None,
                },
            );
            Ok(true)
        }
        Ok(status) => {
            cleanup_output_dir(&out_path).await;
            let code = status.code();
            let details = if stderr_tail.is_empty() {
                format!("horizon-client --prepare exited with status {status}")
            } else {
                stderr_tail.join("\n")
            };
            let _ = app.emit(
                EVENT_PREPARE_FINISHED,
                PrepareFinishedPayload {
                    success: false,
                    exit_code: code,
                    error: Some(details.clone()),
                },
            );
            Err(LauncherError::PrepareFailed {
                exit_code: code,
                details,
            })
        }
        Err(e) => {
            cleanup_output_dir(&out_path).await;
            let msg = format!("Error waiting for prepare process: {e}");
            let _ = app.emit(
                EVENT_PREPARE_FINISHED,
                PrepareFinishedPayload {
                    success: false,
                    exit_code: None,
                    error: Some(msg.clone()),
                },
            );
            Err(LauncherError::PrepareFailed {
                exit_code: None,
                details: msg,
            })
        }
    }
}

/// Launches `horizon-client` asynchronously and detached from the launcher process group,
/// capturing stdout/stderr into both launcher stderr/stdout and a debug log file.
///
/// Returns the spawned child process PID on success.
#[tauri::command]
pub async fn launch_horizon(
    client_path: String,
    assets_dir: String,
    access_token: String,
    uuid: String,
) -> Result<u32, LauncherError> {
    let client_bin = PathBuf::from(&client_path);
    let assets_path = PathBuf::from(&assets_dir);

    if !tokio::fs::try_exists(&client_bin).await.unwrap_or(false) {
        return Err(LauncherError::InvalidPath(format!(
            "Client binary not found: {}",
            client_bin.display()
        )));
    }
    if !is_dir_non_empty(&assets_path).await? {
        return Err(LauncherError::InvalidPath(format!(
            "Assets directory is missing or empty: {}",
            assets_path.display()
        )));
    }

    let mut cmd = TokioCommand::new(&client_bin);
    cmd.arg("--assets-dir")
        .arg(&assets_path)
        .arg("--access-token")
        .arg(&access_token)
        .arg("--uuid")
        .arg(&uuid)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    #[cfg(windows)]
    {
        // DETACHED_PROCESS (0x00000008) | CREATE_NEW_PROCESS_GROUP (0x00000200)
        // Detaches the game from the launcher's console/process group so closing the launcher
        // does not terminate the game process.
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }

    #[cfg(unix)]
    {
        // Start in a new process group so signals sent to the launcher do not propagate to the game.
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| {
        LauncherError::ProcessSpawnFailed(format!("Failed to launch '{}': {e}", client_bin.display()))
    })?;

    let pid = child.id().unwrap_or(0);

    // Prepare debug log file for stdout/stderr capture
    let log_dir = storage::data_root().join("logs");
    let _ = tokio::fs::create_dir_all(&log_dir).await;
    let log_path = log_dir.join(format!(
        "horizon-{}-{}.log",
        Utc::now().format("%Y%m%d-%H%M%S"),
        pid
    ));
    let log_file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await
        .ok()
        .map(|f| Arc::new(tokio::sync::Mutex::new(f)));

    if let Some(stdout) = child.stdout.take() {
        let log_file_c = log_file.clone();
        tokio::spawn(async move {
            let mut lines = TokioBufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                println!("[horizon:{pid}][stdout] {line}");
                if let Some(ref f) = log_file_c {
                    let mut guard = f.lock().await;
                    let _ = guard
                        .write_all(format!("[stdout] {line}\n").as_bytes())
                        .await;
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let log_file_c = log_file.clone();
        tokio::spawn(async move {
            let mut lines = TokioBufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[horizon:{pid}][stderr] {line}");
                if let Some(ref f) = log_file_c {
                    let mut guard = f.lock().await;
                    let _ = guard
                        .write_all(format!("[stderr] {line}\n").as_bytes())
                        .await;
                }
            }
        });
    }

    // Reap the child asynchronously in the background without blocking the command
    // (dropping `child` with `kill_on_drop(false)` keeps the process alive if the launcher exits).
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => println!("[horizon:{pid}] exited with {status}"),
            Err(e) => eprintln!("[horizon:{pid}] wait error: {e}"),
        }
    });

    Ok(pid)
}

pub const EVENT_DOWNLOAD_PROGRESS: &str = "download-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressPayload {
    pub downloaded: u64,
    pub total: u64,
}

/// Streams a client binary from `url` into `dest_path`, emitting throttled
/// `download-progress` events with `{ downloaded, total }`.
///
/// Writes to a `.part` sibling file first and atomically renames on completion
/// so failed/interrupted downloads never leave a corrupted binary behind.
/// If `dest_path` is relative, it is resolved under `<data_root>/horizon/builds/downloaded/`.
#[tauri::command]
pub async fn download_client(
    app: AppHandle,
    url: String,
    dest_path: String,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::time::{Duration, Instant};

    let trimmed_url = url.trim();
    if !(trimmed_url.starts_with("https://") || trimmed_url.starts_with("http://")) {
        return Err("Download URL must start with http:// or https://".into());
    }

    let trimmed_dest = dest_path.trim();
    let final_path = if trimmed_dest.is_empty() {
        builds_dir().join("downloaded").join(client_exe_name())
    } else {
        let candidate = PathBuf::from(trimmed_dest);
        if candidate.is_absolute() {
            candidate
        } else {
            builds_dir().join("downloaded").join(candidate)
        }
    };

    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed creating destination directory: {e}"))?;
    }

    let mut part_os = final_path.as_os_str().to_os_string();
    part_os.push(".part");
    let part_path = PathBuf::from(part_os);

    let client = http_client()?;
    let resp = client
        .get(trimmed_url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Server returned HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let _ = app.emit(
        EVENT_DOWNLOAD_PROGRESS,
        DownloadProgressPayload {
            downloaded: 0,
            total,
        },
    );

    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("Cannot create '{}': {e}", part_path.display()))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit_at = Instant::now();
    let mut last_emit_bytes: u64 = 0;

    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&part_path).await;
                return Err(format!("Download interrupted: {e}"));
            }
        };

        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(format!("Failed writing file: {e}"));
        }

        downloaded += chunk.len() as u64;

        let elapsed = last_emit_at.elapsed();
        if downloaded.saturating_sub(last_emit_bytes) >= 64 * 1024
            || elapsed >= Duration::from_millis(50)
        {
            let _ = app.emit(
                EVENT_DOWNLOAD_PROGRESS,
                DownloadProgressPayload { downloaded, total },
            );
            last_emit_at = Instant::now();
            last_emit_bytes = downloaded;
        }
    }

    if let Err(e) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(format!("Failed flushing file: {e}"));
    }
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = tokio::fs::metadata(&part_path).await {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = tokio::fs::set_permissions(&part_path, perms).await;
        }
    }

    #[cfg(windows)]
    {
        if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
            let _ = tokio::fs::remove_file(&final_path).await;
        }
    }

    if let Err(e) = tokio::fs::rename(&part_path, &final_path).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(format!("Failed moving downloaded file into place: {e}"));
    }

    let final_total = if total > 0 { total } else { downloaded };
    let _ = app.emit(
        EVENT_DOWNLOAD_PROGRESS,
        DownloadProgressPayload {
            downloaded,
            total: final_total,
        },
    );

    Ok(final_path.to_string_lossy().to_string())
}

const OFFICIAL_HORIZON_REPO: &str = "horizon-rust/horizon";
const FALLBACK_HORIZON_REPO: &str = "apc1338/mono-horizon-mirror";

#[derive(Debug, serde::Deserialize)]
struct HorizonGhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<HorizonGhAsset>,
}

#[derive(Debug, serde::Deserialize)]
struct HorizonGhAsset {
    name: String,
    browser_download_url: String,
}

struct ResolvedHorizonRelease {
    repo: &'static str,
    tag: String,
    asset_name: String,
    download_url: String,
}

fn pick_platform_archive<'a>(assets: &'a [HorizonGhAsset]) -> Option<&'a HorizonGhAsset> {
    let zips: Vec<&HorizonGhAsset> = assets
        .iter()
        .filter(|a| a.name.to_ascii_lowercase().ends_with(".zip"))
        .collect();
    if zips.is_empty() {
        return None;
    }

    #[cfg(target_os = "windows")]
    let os_tokens: &[&str] = &["windows", "win64", "win32", "win"];
    #[cfg(target_os = "macos")]
    let os_tokens: &[&str] = &["macos", "darwin", "osx", "mac"];
    #[cfg(target_os = "linux")]
    let os_tokens: &[&str] = &["linux"];

    #[cfg(target_arch = "x86_64")]
    let arch_tokens: &[&str] = &["x64", "x86_64", "amd64"];
    #[cfg(target_arch = "aarch64")]
    let arch_tokens: &[&str] = &["arm64", "aarch64"];
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    let arch_tokens: &[&str] = &[];

    let matches_os = |name: &str| os_tokens.iter().any(|t| name.contains(t));
    let matches_arch = |name: &str| arch_tokens.is_empty() || arch_tokens.iter().any(|t| name.contains(t));

    // Prefer OS + arch match, then OS match, then any zip
    zips.iter()
        .copied()
        .find(|a| {
            let low = a.name.to_ascii_lowercase();
            matches_os(&low) && matches_arch(&low)
        })
        .or_else(|| {
            zips.iter()
                .copied()
                .find(|a| matches_os(&a.name.to_ascii_lowercase()))
        })
        .or_else(|| zips.first().copied())
}

async fn fetch_repo_latest_release(
    client: &reqwest::Client,
    repo: &'static str,
) -> Result<ResolvedHorizonRelease, String> {
    let latest_url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let resp = client
        .get(&latest_url)
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("{repo}: {e}"))?;

    let release: HorizonGhRelease = if resp.status().is_success() {
        resp.json()
            .await
            .map_err(|e| format!("{repo}: invalid release JSON: {e}"))?
    } else {
        // If `/releases/latest` returned 404 (e.g. only prereleases), try listing releases
        let list_url = format!("https://api.github.com/repos/{repo}/releases?per_page=5");
        let list_resp = client
            .get(&list_url)
            .header("Accept", "application/vnd.github+json")
            .timeout(std::time::Duration::from_secs(12))
            .send()
            .await
            .map_err(|e| format!("{repo}: {e}"))?;

        if !list_resp.status().is_success() {
            return Err(format!("{repo}: HTTP {}", list_resp.status()));
        }

        let releases: Vec<HorizonGhRelease> = list_resp
            .json()
            .await
            .map_err(|e| format!("{repo}: invalid releases list JSON: {e}"))?;

        releases
            .into_iter()
            .find(|r| !r.draft && pick_platform_archive(&r.assets).is_some())
            .ok_or_else(|| format!("{repo}: no suitable release archive found"))?
    };

    let asset = pick_platform_archive(&release.assets)
        .ok_or_else(|| format!("{repo} ({}): no .zip archive asset for this platform", release.tag_name))?;

    Ok(ResolvedHorizonRelease {
        repo,
        tag: release.tag_name,
        asset_name: asset.name.clone(),
        download_url: asset.browser_download_url.clone(),
    })
}

async fn resolve_latest_horizon_release(
    client: &reqwest::Client,
) -> Result<ResolvedHorizonRelease, String> {
    match fetch_repo_latest_release(client, OFFICIAL_HORIZON_REPO).await {
        Ok(rel) => Ok(rel),
        Err(official_err) => {
            println!(
                "[horizon] Official repo unreachable ({official_err}), falling back to {FALLBACK_HORIZON_REPO}"
            );
            fetch_repo_latest_release(client, FALLBACK_HORIZON_REPO)
                .await
                .map_err(|fallback_err| {
                    format!(
                        "Failed fetching Horizon release from both official ({official_err}) and mirror ({fallback_err})"
                    )
                })
        }
    }
}

fn sanitize_build_tag(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "horizon-latest".to_string()
    } else {
        cleaned
    }
}

/// Downloads the latest Horizon release archive (official `horizon-rust/horizon`,
/// automatically falling back to `kkerneldev/Elyhorizon` if official is unreachable),
/// extracts `horizon-client` and all accompanying files into `<data_root>/horizon/builds/<tag>/`,
/// and emits `download-progress` (and `launch-progress` when `instance_id` is provided).
pub async fn download_latest_build(
    app: &AppHandle,
    instance_id: Option<&str>,
) -> Result<HorizonBuildStatus, String> {
    use futures_util::StreamExt;
    use std::time::{Duration, Instant};

    let client = http_client()?;
    let rel = resolve_latest_horizon_release(&client).await?;

    if let Some(iid) = instance_id {
        emit_log(
            app,
            iid,
            "info",
            format!(
                "[Mono] Downloading Horizon {} from {} ({})...",
                rel.tag, rel.repo, rel.asset_name
            ),
        );
        emit_progress(
            app,
            iid,
            "horizon",
            0,
            100,
            &format!("Downloading {}", rel.asset_name),
        );
    }

    let root_builds = builds_dir();
    tokio::fs::create_dir_all(&root_builds)
        .await
        .map_err(|e| format!("Failed creating Horizon builds directory: {e}"))?;

    let tmp_zip = root_builds.join(format!(".tmp-dl-{}.zip", uuid::Uuid::new_v4()));

    let resp = client
        .get(&rel.download_url)
        .send()
        .await
        .map_err(|e| format!("Failed downloading {}: {e}", rel.asset_name))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Failed downloading {}: HTTP {}",
            rel.asset_name,
            resp.status()
        ));
    }

    let total = resp.content_length().unwrap_or(0);
    let _ = app.emit(
        EVENT_DOWNLOAD_PROGRESS,
        DownloadProgressPayload {
            downloaded: 0,
            total,
        },
    );

    let mut file = tokio::fs::File::create(&tmp_zip)
        .await
        .map_err(|e| format!("Cannot create temp archive: {e}"))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit_at = Instant::now();
    let mut last_emit_bytes: u64 = 0;
    let mut magic = [0u8; 2];
    let mut magic_len: usize = 0;

    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp_zip).await;
                return Err(format!("Horizon download interrupted: {e}"));
            }
        };

        if magic_len < 2 {
            let take = (2 - magic_len).min(chunk.len());
            magic[magic_len..magic_len + take].copy_from_slice(&chunk[..take]);
            magic_len += take;
            if magic_len == 2 && magic != *b"PK" {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp_zip).await;
                return Err(
                    "Mirror returned an invalid response instead of a .zip archive.".into(),
                );
            }
        }

        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp_zip).await;
            return Err(format!("Failed writing Horizon archive: {e}"));
        }

        downloaded += chunk.len() as u64;

        let elapsed = last_emit_at.elapsed();
        if downloaded.saturating_sub(last_emit_bytes) >= 64 * 1024
            || elapsed >= Duration::from_millis(50)
        {
            let _ = app.emit(
                EVENT_DOWNLOAD_PROGRESS,
                DownloadProgressPayload { downloaded, total },
            );
            if let Some(iid) = instance_id {
                let pct = if total > 0 {
                    ((downloaded as f64 / total as f64) * 100.0)
                        .clamp(0.0, 100.0)
                        .round() as u64
                } else {
                    0
                };
                emit_progress(
                    app,
                    iid,
                    "horizon",
                    pct,
                    100,
                    &format!("Downloading {} ({pct}%)", rel.asset_name),
                );
            }
            last_emit_at = Instant::now();
            last_emit_bytes = downloaded;
        }
    }

    if let Err(e) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(&tmp_zip).await;
        return Err(format!("Failed flushing Horizon archive: {e}"));
    }
    drop(file);

    let final_total = if total > 0 { total } else { downloaded };
    let _ = app.emit(
        EVENT_DOWNLOAD_PROGRESS,
        DownloadProgressPayload {
            downloaded,
            total: final_total,
        },
    );

    if let Some(iid) = instance_id {
        emit_progress(app, iid, "horizon", 100, 100, "Extracting Horizon build");
        emit_log(
            app,
            iid,
            "info",
            format!("[Mono] Extracting {} into Mono builds folder...", rel.asset_name),
        );
    }

    let safe_tag = sanitize_build_tag(&rel.tag);
    let zip_for_extract = tmp_zip.clone();
    let extract_res = tauri::async_runtime::spawn_blocking(move || -> Result<HorizonBuildStatus, String> {
        let res = (|| -> Result<HorizonBuildStatus, String> {
            let file = fs::File::open(&zip_for_extract).map_err(|e| e.to_string())?;
            let mut zip =
                zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {e}"))?;

            let root_builds = builds_dir();
            let temp_dir = root_builds.join(format!(".tmp-extract-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

            for i in 0..zip.len() {
                let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
                let Some(rel_path) = f.enclosed_name() else {
                    continue;
                };
                let out = temp_dir.join(rel_path);
                if f.is_dir() {
                    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                } else {
                    if let Some(p) = out.parent() {
                        fs::create_dir_all(p).map_err(|e| e.to_string())?;
                    }
                    let mut out_f = fs::File::create(&out).map_err(|e| e.to_string())?;
                    std::io::copy(&mut f, &mut out_f).map_err(|e| e.to_string())?;
                    #[cfg(unix)]
                    if out
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n == client_exe_name() || n == prepare_exe_name())
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if let Ok(meta) = fs::metadata(&out) {
                            let mut perms = meta.permissions();
                            perms.set_mode(0o755);
                            let _ = fs::set_permissions(&out, perms);
                        }
                    }
                }
            }

            // Locate the directory containing `horizon-client(.exe)` (handles single top-level folder like `Elyhorizon/`)
            let extracted_root = if inspect_build_dir(&temp_dir, String::new()).is_some() {
                temp_dir.clone()
            } else {
                let mut found_sub = None;
                if let Ok(rd) = fs::read_dir(&temp_dir) {
                    for e in rd.flatten() {
                        let p = e.path();
                        if p.is_dir() && inspect_build_dir(&p, String::new()).is_some() {
                            found_sub = Some(p);
                            break;
                        }
                    }
                }
                match found_sub {
                    Some(p) => p,
                    None => {
                        let _ = fs::remove_dir_all(&temp_dir);
                        return Err(format!(
                            "Downloaded archive does not contain {}",
                            client_exe_name()
                        ));
                    }
                }
            };

            let dest = root_builds.join(&safe_tag);
            if extracted_root == temp_dir {
                replace_build_dir(&temp_dir, &dest)?;
            } else {
                replace_build_dir(&extracted_root, &dest)?;
                let _ = fs::remove_dir_all(&temp_dir);
            }

            let b = inspect_build_dir(&dest, safe_tag)
                .ok_or_else(|| "Extracted Horizon build verification failed".to_string())?;
            Ok(HorizonBuildStatus {
                found: true,
                tag: Some(b.tag),
                path: Some(b.dir.to_string_lossy().to_string()),
                prepared: b.prepared,
            })
        })();

        let _ = fs::remove_file(&zip_for_extract);
        res
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Some(iid) = instance_id {
        emit_log(
            app,
            iid,
            "info",
            format!(
                "[Mono] Horizon {} installed to {}",
                extract_res.tag.as_deref().unwrap_or(""),
                extract_res.path.as_deref().unwrap_or("")
            ),
        );
    }

    Ok(extract_res)
}

#[tauri::command]
pub async fn download_latest_horizon_build(app: AppHandle) -> Result<HorizonBuildStatus, String> {
    download_latest_build(&app, None).await
}
