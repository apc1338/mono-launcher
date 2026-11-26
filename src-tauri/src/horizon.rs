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
use tauri::{AppHandle, Manager};
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
    pub prepare: PathBuf,
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

pub fn builds_dir() -> PathBuf {
    storage::data_root().join("horizon").join("builds")
}

fn horizon_launcher_home() -> PathBuf {
    if let Some(h) = std::env::var_os("HORIZON_LAUNCHER_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    dirs::data_dir().unwrap_or_default().join("horizon-launcher")
}

fn inspect_build_dir(dir: &Path, tag: String) -> Option<LocalBuild> {
    let client = dir.join(client_exe_name());
    let prepare = dir.join(prepare_exe_name());
    if !client.is_file() || !prepare.is_file() {
        return None;
    }
    let resources = dir
        .join(".local")
        .join("horizon-client")
        .join(HORIZON_MC_VERSION);
    let prepared = resources.join("horizon-resources.json").is_file();
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

/// Finds a Horizon game build on disk:
/// 1. Managed builds in `<data_root>/horizon/builds/` (preferring already-prepared, then newest).
/// 2. Existing builds installed by Horizon's own launcher in `%APPDATA%/horizon-launcher/versions/`.
pub fn find_build() -> Option<LocalBuild> {
    let mut managed = scan_builds_in(&builds_dir(), false);
    if !managed.is_empty() {
        managed.sort_by_key(|(m, b)| (b.prepared, *m));
        return managed.pop().map(|(_, b)| b);
    }

    let hl_home = horizon_launcher_home();
    let selected = fs::read_to_string(hl_home.join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["selected"].as_str().map(str::to_owned));
    let mut external = scan_builds_in(&hl_home.join("versions"), true);
    if let Some(sel) = selected {
        if let Some(i) = external.iter().position(|(_, b)| b.tag == sel) {
            return Some(external.swap_remove(i).1);
        }
    }
    external.sort_by_key(|(m, b)| (b.prepared, *m));
    external.pop().map(|(_, b)| b)
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
            fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
            return Err(format!(
                "Folder does not contain {} and {}",
                client_exe_name(),
                prepare_exe_name()
            ));
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
                    return Err(format!(
                        "Archive does not contain {} and {}",
                        client_exe_name(),
                        prepare_exe_name()
                    ));
                }
            }
        };
        let dest = root_builds.join(&name);
        let _ = fs::remove_dir_all(&dest);
        if extracted_root == temp_dir {
            fs::rename(&temp_dir, &dest).map_err(|e| e.to_string())?;
        } else {
            fs::rename(&extracted_root, &dest).map_err(|e| e.to_string())?;
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
    if !build.prepared {
        return false;
    }
    let mut cmd = Command::new(&build.prepare);
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
    let java_exe = java::resolve_java_for_instance(app, HORIZON_MC_VERSION, java_override, iid).await?;
    let java_home = Path::new(&java_exe)
        .parent()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not determine Java home directory".to_string())?;

    // 2. Vanilla 26.3 version JSON
    emit_progress(app, iid, "meta", 0, 1, HORIZON_MC_VERSION);
    let meta_dir = root.join("meta");
    fs::create_dir_all(&meta_dir).map_err(|e| e.to_string())?;
    let version_meta_path = meta_dir.join(format!("{HORIZON_MC_VERSION}.json"));
    let version_json: Value = if version_meta_path.exists() {
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
        let idx_path = assets_dir.join("indexes").join(format!("{asset_index_id}.json"));
        download_file(&client, asset_index_url, &idx_path, None).await?;
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

    // 6. Run horizon-prepare --prepare --complete --progress json
    emit_progress(app, iid, "prepare", 0, 100, "Preparing Horizon resources");
    let prepare_exe = build.prepare.clone();
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
        if let Some(err) = child.stderr.take() {
            let (a, i) = (app_p.clone(), iid_p.clone());
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        emit_log(&a, &i, "warn", format!("[horizon-prepare] {line}"));
                    }
                }
            });
        }
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(frac) = v.get("fraction").and_then(|f| f.as_f64()) {
                        let pct = (frac.clamp(0.0, 1.0) * 100.0).round() as u64;
                        emit_progress(&app_p, &iid_p, "prepare", pct, 100, "Preparing Horizon resources");
                    } else if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
                        emit_log(&app_p, &iid_p, "info", format!("[horizon-prepare] {msg}"));
                    } else if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                        emit_log(&app_p, &iid_p, "error", format!("[horizon-prepare] {err}"));
                    }
                } else if !line.trim().is_empty() {
                    emit_log(&app_p, &iid_p, "info", format!("[horizon-prepare] {line}"));
                }
            }
        }
        let exit = child.wait().map_err(|e| e.to_string())?;
        if !exit.success() {
            return Err(format!("horizon-prepare exited with code {}", exit.code().unwrap_or(-1)));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;

    status
}

pub async fn launch(
    app: AppHandle,
    running: RunningMap,
    mut inst: Instance,
    quick_play_world: Option<String>,
) -> Result<(), String> {
    let iid = inst.id.clone();
    emit_status(&app, &iid, "launching", None);

    let Some(build) = find_build() else {
        emit_status(&app, &iid, "idle", None);
        return Err(
            "Horizon game build not found. Import a Horizon build folder or .zip archive in instance settings."
                .into(),
        );
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

    let home = storage::instance_dir(&iid).join("horizon");
    let _ = fs::create_dir_all(&home);
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
