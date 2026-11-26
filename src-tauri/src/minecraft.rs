use crate::auth;
use crate::java;
use crate::models::{
    AccountType, GameLogEvent, InstanceStatusEvent, LaunchProgressEvent, LoaderType, McVersionInfo,
};
use crate::storage;
use chrono::{Local, Utc};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

pub type RunningMap = Arc<Mutex<HashMap<String, u32>>>;

pub(crate) fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("MonoLauncher/0.1.0")
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub(crate) struct VersionManifest {
    pub(crate) versions: Vec<ManifestVersion>,
}

#[derive(Deserialize)]
pub(crate) struct ManifestVersion {
    pub(crate) id: String,
    #[serde(rename = "type")]
    version_type: String,
    pub(crate) url: String,
    #[serde(rename = "releaseTime")]
    release_time: String,
}

pub(crate) async fn get_version_manifest() -> Result<VersionManifest, String> {
    let client = http_client()?;
    let resp = client
        .get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
        .send()
        .await
        .map_err(|e| format!("Failed fetching Mojang manifest: {e}"))?;
    resp.json::<VersionManifest>()
        .await
        .map_err(|e| format!("Invalid Mojang manifest JSON: {e}"))
}

pub async fn fetch_mc_versions(include_snapshots: bool) -> Result<Vec<McVersionInfo>, String> {
    let manifest = get_version_manifest().await?;
    Ok(manifest
        .versions
        .into_iter()
        .filter(|v| include_snapshots || v.version_type == "release")
        .map(|v| McVersionInfo {
            id: v.id,
            version_type: v.version_type,
            release_time: v.release_time,
        })
        .collect())
}

#[derive(Deserialize)]
struct FabricLoaderEntry {
    loader: FabricLoaderMeta,
}

#[derive(Deserialize)]
struct FabricLoaderMeta {
    version: String,
}

pub async fn fetch_loader_versions(
    loader: LoaderType,
    mc_version: &str,
) -> Result<Vec<String>, String> {
    let client = http_client()?;
    match loader {
        LoaderType::Vanilla | LoaderType::Custom => Ok(Vec::new()),
        LoaderType::Quilt => {
            let url = format!("https://meta.quiltmc.org/v3/versions/loader/{mc_version}");
            let list: Vec<FabricLoaderEntry> = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("Quilt Meta error: {e}"))?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            Ok(list.into_iter().take(25).map(|e| e.loader.version).collect())
        }
        LoaderType::Fabric => {
            let url = format!("https://meta.fabricmc.net/v2/versions/loader/{mc_version}");
            let list: Vec<FabricLoaderEntry> = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("Fabric Meta error: {e}"))?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            Ok(list.into_iter().take(25).map(|e| e.loader.version).collect())
        }
        LoaderType::Neoforge => {
            let xml = client
                .get("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml")
                .send()
                .await
                .map_err(|e| format!("NeoForge metadata error: {e}"))?
                .text()
                .await
                .map_err(|e| e.to_string())?;

            // NeoForge versions start with "<mc_minor>.<mc_patch>." e.g. 1.21.4 -> "21.4."
            let parts: Vec<&str> = mc_version.split('.').collect();
            let prefix = if parts.len() >= 3 {
                format!("{}.{}.", parts[1], parts[2])
            } else if parts.len() == 2 {
                format!("{}.0.", parts[1])
            } else {
                String::new()
            };

            let mut versions = Vec::new();
            for line in xml.lines() {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("<version>") {
                    if let Some(ver) = rest.strip_suffix("</version>") {
                        if prefix.is_empty() || ver.starts_with(&prefix) {
                            versions.push(ver.to_string());
                        }
                    }
                }
            }
            versions.reverse();
            Ok(versions.into_iter().take(25).collect())
        }
        LoaderType::Forge => {
            let val: Value = client
                .get("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json")
                .send()
                .await
                .map_err(|e| format!("Forge promotions error: {e}"))?
                .json()
                .await
                .map_err(|e| e.to_string())?;

            let mut versions = Vec::new();
            if let Some(promos) = val.get("promos").and_then(|p| p.as_object()) {
                for suffix in ["recommended", "latest"] {
                    let key = format!("{mc_version}-{suffix}");
                    if let Some(v) = promos.get(&key).and_then(|x| x.as_str()) {
                        let s = v.to_string();
                        if !versions.contains(&s) {
                            versions.push(s);
                        }
                    }
                }
            }
            Ok(versions)
        }
    }
}

fn sha1_matches(path: &Path, expected: Option<&str>) -> bool {
    if !path.exists() {
        return false;
    }
    let Some(exp) = expected else {
        return true;
    };
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let hash = hex::encode(Sha1::digest(&bytes));
    hash.eq_ignore_ascii_case(exp)
}

pub(crate) async fn download_file(
    client: &Client,
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
) -> Result<(), String> {
    if sha1_matches(dest, expected_sha1) {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download error ({url}): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading {url}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    fs::write(dest, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn rule_allows_windows(rules: Option<&Value>) -> bool {
    let Some(arr) = rules.and_then(|r| r.as_array()) else {
        return true;
    };
    let current_arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "x86_64"
    };
    let mut allowed = false;
    for rule in arr {
        if rule.get("features").is_some() {
            continue;
        }
        let action = rule.get("action").and_then(|a| a.as_str()).unwrap_or("allow");
        let os_match = match rule.get("os").and_then(|o| o.get("name")).and_then(|n| n.as_str()) {
            Some("windows") => true,
            Some(_) => false,
            None => true,
        };
        let arch_match = match rule.get("os").and_then(|o| o.get("arch")).and_then(|a| a.as_str()) {
            Some(a) => a == current_arch || (current_arch == "x86_64" && a == "amd64"),
            None => true,
        };
        if os_match && arch_match {
            allowed = action == "allow";
        }
    }
    allowed
}

fn collect_json_args(arr: Option<&Vec<Value>>, mut push_fn: impl FnMut(&str)) {
    let Some(items) = arr else {
        return;
    };
    for item in items {
        if let Some(s) = item.as_str() {
            push_fn(s);
        } else if let Some(obj) = item.as_object() {
            if !rule_allows_windows(obj.get("rules")) {
                continue;
            }
            match obj.get("value") {
                Some(Value::String(s)) => push_fn(s),
                Some(Value::Array(vals)) => {
                    for v in vals {
                        if let Some(s) = v.as_str() {
                            push_fn(s);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

fn extract_legacy_extra_game_args(mc_args: &str, out: &mut Vec<String>) {
    const STANDARD_KEYS: &[&str] = &[
        "--username",
        "--version",
        "--gameDir",
        "--assetsDir",
        "--assetIndex",
        "--uuid",
        "--accessToken",
        "--userType",
        "--versionType",
        "--userProperties",
        "--clientId",
        "--xuid",
    ];
    let tokens: Vec<&str> = mc_args.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if STANDARD_KEYS.contains(&tok) {
            i += 2;
            continue;
        }
        out.push(tok.to_string());
        i += 1;
    }
}

fn maven_coords_to_path(coords: &str) -> Option<String> {
    let parts: Vec<&str> = coords.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let classifier = parts.get(3).map(|c| format!("-{c}")).unwrap_or_default();
    Some(format!("{group}/{artifact}/{version}/{artifact}-{version}{classifier}.jar"))
}

pub(crate) fn emit_progress(app: &AppHandle, iid: &str, stage: &str, current: u64, total: u64, msg: &str) {
    let _ = app.emit(
        "launch-progress",
        LaunchProgressEvent {
            instance_id: iid.to_string(),
            stage: stage.to_string(),
            current,
            total,
            message: msg.to_string(),
        },
    );
}

pub(crate) fn emit_status(app: &AppHandle, iid: &str, status: &str, exit_code: Option<i32>) {
    let _ = app.emit(
        "instance-status",
        InstanceStatusEvent {
            instance_id: iid.to_string(),
            status: status.to_string(),
            exit_code,
        },
    );
}

pub(crate) fn emit_log(app: &AppHandle, iid: &str, level: &str, text: String) {
    let _ = app.emit(
        "game-log",
        GameLogEvent {
            instance_id: iid.to_string(),
            level: level.to_string(),
            text,
            timestamp: Local::now().format("%H:%M:%S").to_string(),
        },
    );
}

pub fn supports_quick_play(mc_version: &str) -> bool {
    let parts: Vec<u32> = mc_version
        .split('.')
        .filter_map(|p| {
            let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().ok()
        })
        .collect();
    if let Some(&major) = parts.first() {
        if major >= 26 {
            return true; // 2026+ numbering (e.g. 26.3)
        }
        if major == 1 {
            return parts.get(1).copied().unwrap_or(0) >= 20;
        }
    }
    // Snapshots 23w14a+
    if let Some((yr, _)) = mc_version.split_once('w') {
        if let Ok(y) = yr.parse::<u32>() {
            return y >= 23;
        }
    }
    false
}

pub async fn launch_instance(
    app: AppHandle,
    running: RunningMap,
    instance_id: String,
    quick_play_world: Option<String>,
) -> Result<(), String> {
    {
        let map = running.lock().map_err(|_| "State lock poisoned")?;
        if map.contains_key(&instance_id) {
            return Err("Instance is already running".into());
        }
    }

    let instances = storage::load_instances();
    let mut inst = instances
        .into_iter()
        .find(|i| i.id == instance_id)
        .ok_or_else(|| "Instance not found".to_string())?;

    if inst.edition == crate::horizon::RUST_EDITION {
        return crate::horizon::launch(app, running, inst, quick_play_world).await;
    }

    let accounts = storage::load_accounts();
    let raw_account = accounts
        .active_id
        .as_ref()
        .and_then(|aid| accounts.accounts.iter().find(|a| &a.id == aid))
        .or_else(|| accounts.accounts.first())
        .cloned()
        .ok_or_else(|| "No active account. Add an account first.".to_string())?;
    let account = if raw_account.account_type == AccountType::Microsoft {
        auth::refresh_msa_account(&raw_account).await?
    } else {
        raw_account
    };

    emit_status(&app, &instance_id, "launching", None);
    emit_log(
        &app,
        &instance_id,
        "info",
        format!("[Mono] Preparing {} ({} {:?})", inst.name, inst.mc_version, inst.loader),
    );

    let root = storage::data_root();
    let client = http_client()?;

    // 1. Resolve Java
    emit_progress(&app, &instance_id, "java", 0, 1, "Java");
    let java_exe = java::resolve_java_for_instance(
        &app,
        &inst.mc_version,
        inst.java_path.as_deref(),
        &instance_id,
    )
    .await?;
    emit_log(&app, &instance_id, "info", format!("[Mono] Using Java: {java_exe}"));

    // 2. Fetch Vanilla Version JSON
    emit_progress(&app, &instance_id, "meta", 0, 1, &inst.mc_version);
    let version_meta_path = root.join("meta").join(format!("{}.json", inst.mc_version));
    let version_json: Value = if version_meta_path.exists() {
        let raw = fs::read_to_string(&version_meta_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    } else {
        let manifest = get_version_manifest().await?;
        let entry = manifest
            .versions
            .into_iter()
            .find(|v| v.id == inst.mc_version)
            .ok_or_else(|| format!("Minecraft version {} not found in Mojang manifest", inst.mc_version))?;
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

    // 3. Download Client JAR
    let client_jar_path = root
        .join("meta")
        .join("clients")
        .join(format!("{}.jar", inst.mc_version));
    if let Some(dl) = version_json.pointer("/downloads/client") {
        let url = dl.get("url").and_then(|v| v.as_str()).unwrap_or_default();
        let sha1 = dl.get("sha1").and_then(|v| v.as_str());
        emit_progress(&app, &instance_id, "client", 0, 1, &inst.mc_version);
        download_file(&client, url, &client_jar_path, sha1).await?;
    }

    // 4. Collect Libraries & Natives
    let lib_root = root.join("libraries");
    let natives_dir = storage::instance_dir(&instance_id).join("natives");
    fs::create_dir_all(&natives_dir).map_err(|e| e.to_string())?;

    let mut classpath_entries: Vec<PathBuf> = Vec::new();
    let mut downloads_queue: Vec<(String, PathBuf, Option<String>, bool)> = Vec::new();

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
                    let dest = lib_root.join(rel);
                    classpath_entries.push(dest.clone());
                    downloads_queue.push((url.to_string(), dest, sha1, false));
                }
            }
            if let Some(classifiers) = lib.pointer("/downloads/classifiers").and_then(|c| c.as_object()) {
                let win_key = lib
                    .pointer("/natives/windows")
                    .and_then(|v| v.as_str())
                    .map(|k| k.replace("${arch}", "64"));
                let native_obj = win_key
                    .as_deref()
                    .and_then(|k| classifiers.get(k))
                    .or_else(|| classifiers.get("natives-windows"));
                if let Some(nat) = native_obj {
                    if let (Some(url), Some(rel)) = (
                        nat.get("url").and_then(|v| v.as_str()),
                        nat.get("path").and_then(|v| v.as_str()),
                    ) {
                        let sha1 = nat.get("sha1").and_then(|v| v.as_str()).map(String::from);
                        let dest = lib_root.join(rel);
                        downloads_queue.push((url.to_string(), dest, sha1, true));
                    }
                }
            }
        }
    }

    // 5. Handle Modloader (Fabric / Forge / NeoForge)
    let mut main_class = version_json
        .get("mainClass")
        .and_then(|v| v.as_str())
        .unwrap_or("net.minecraft.client.main.Main")
        .to_string();
    let mut extra_jvm_args: Vec<String> = Vec::new();
    let mut extra_game_args: Vec<String> = Vec::new();

    // Apply JVM arguments from the base Minecraft version JSON (e.g. --enable-native-access, --add-exports, StackShadowPages)
    for sub in ["jna", "lwjgl", "netty"] {
        let _ = fs::create_dir_all(natives_dir.join(sub));
    }
    if let Some(jvm_arr) = version_json.pointer("/arguments/jvm").and_then(|a| a.as_array()) {
        let natives_str = natives_dir.to_string_lossy().to_string();
        let lib_str = lib_root.to_string_lossy().to_string();
        collect_json_args(Some(jvm_arr), |raw| {
            let resolved = raw
                .replace("${natives_directory}", &natives_str)
                .replace("${library_directory}", &lib_str)
                .replace("${classpath_separator}", ";")
                .replace("${launcher_name}", "Mono")
                .replace("${launcher_version}", "0.1.0");
            if resolved == "-cp"
                || resolved == "${classpath}"
                || resolved.starts_with("-Djava.library.path=")
                || resolved.starts_with("-Dminecraft.launcher.brand=")
                || resolved.starts_with("-Dminecraft.launcher.version=")
            {
                return;
            }
            extra_jvm_args.push(resolved);
        });
    }

    match inst.loader {
        LoaderType::Vanilla => {}
        LoaderType::Fabric | LoaderType::Quilt => {
            let is_quilt = inst.loader == LoaderType::Quilt;
            let loader_name = if is_quilt { "Quilt" } else { "Fabric" };
            let loader_ver = match &inst.loader_version {
                Some(v) if !v.is_empty() => v.clone(),
                _ => {
                    let list = fetch_loader_versions(inst.loader.clone(), &inst.mc_version).await?;
                    list.into_iter()
                        .next()
                        .ok_or_else(|| format!("No {loader_name} loader found for this MC version"))?
                }
            };
            let profile_url = if is_quilt {
                format!(
                    "https://meta.quiltmc.org/v3/versions/loader/{}/{}/profile/json",
                    inst.mc_version, loader_ver
                )
            } else {
                format!(
                    "https://meta.fabricmc.net/v2/versions/loader/{}/{}/profile/json",
                    inst.mc_version, loader_ver
                )
            };
            let default_maven = if is_quilt {
                "https://maven.quiltmc.org/repository/release/"
            } else {
                "https://maven.fabricmc.net/"
            };
            let fjson: Value = client
                .get(&profile_url)
                .send()
                .await
                .map_err(|e| format!("{loader_name} profile fetch failed: {e}"))?
                .json()
                .await
                .map_err(|e| e.to_string())?;

            if let Some(mc) = fjson.get("mainClass").and_then(|v| v.as_str()) {
                main_class = mc.to_string();
            }
            if let Some(flibs) = fjson.get("libraries").and_then(|l| l.as_array()) {
                for flib in flibs {
                    if let Some(name) = flib.get("name").and_then(|n| n.as_str()) {
                        let base_url = flib
                            .get("url")
                            .and_then(|u| u.as_str())
                            .unwrap_or(default_maven);
                        if let Some(rel) = maven_coords_to_path(name) {
                            let url = format!("{}{}", base_url.trim_end_matches('/'), format!("/{rel}"));
                            let dest = lib_root.join(&rel);
                            classpath_entries.push(dest.clone());
                            downloads_queue.push((url, dest, None, false));
                        }
                    }
                }
            }
            collect_json_args(fjson.pointer("/arguments/jvm").and_then(|a| a.as_array()), |s| {
                extra_jvm_args.push(s.to_string());
            });
            collect_json_args(fjson.pointer("/arguments/game").and_then(|a| a.as_array()), |s| {
                extra_game_args.push(s.to_string());
            });
        }
        LoaderType::Custom => {
            let profile_path = storage::instance_dir(&instance_id).join("custom_loader.json");
            let raw = fs::read_to_string(&profile_path).map_err(|_| {
                "Custom loader profile is missing. Choose a loader JSON file in the instance settings."
                    .to_string()
            })?;
            let cjson: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("Custom loader JSON is invalid: {e}"))?;
            if let Some(mc) = cjson.get("mainClass").and_then(|v| v.as_str()) {
                main_class = mc.to_string();
            }
            if let Some(libs) = cjson.get("libraries").and_then(|l| l.as_array()) {
                for lib in libs {
                    if !rule_allows_windows(lib.get("rules")) {
                        continue;
                    }
                    let artifact = lib.pointer("/downloads/artifact");
                    let art_url = artifact.and_then(|a| a.get("url")).and_then(|v| v.as_str());
                    let art_path = artifact.and_then(|a| a.get("path")).and_then(|v| v.as_str());
                    if let (Some(url), Some(rel)) = (art_url, art_path) {
                        if !url.is_empty() {
                            let sha1 = artifact
                                .and_then(|a| a.get("sha1"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let dest = lib_root.join(rel);
                            classpath_entries.push(dest.clone());
                            downloads_queue.push((url.to_string(), dest, sha1, false));
                            continue;
                        }
                    }
                    if let Some(name) = lib.get("name").and_then(|n| n.as_str()) {
                        if let Some(rel) = maven_coords_to_path(name) {
                            let base = lib
                                .get("url")
                                .and_then(|u| u.as_str())
                                .unwrap_or("https://repo1.maven.org/maven2/");
                            let url = format!("{}/{rel}", base.trim_end_matches('/'));
                            let dest = lib_root.join(&rel);
                            classpath_entries.push(dest.clone());
                            downloads_queue.push((url, dest, None, false));
                        }
                    }
                }
            }
            collect_json_args(cjson.pointer("/arguments/jvm").and_then(|a| a.as_array()), |s| {
                extra_jvm_args.push(
                    s.replace("${library_directory}", &lib_root.to_string_lossy())
                        .replace("${classpath_separator}", ";"),
                );
            });
            collect_json_args(cjson.pointer("/arguments/game").and_then(|a| a.as_array()), |s| {
                extra_game_args.push(s.to_string());
            });
            if let Some(mc_args) = cjson.get("minecraftArguments").and_then(|v| v.as_str()) {
                extract_legacy_extra_game_args(mc_args, &mut extra_game_args);
            }
        }
        LoaderType::Forge | LoaderType::Neoforge => {            let is_neo = inst.loader == LoaderType::Neoforge;
            let loader_ver = match &inst.loader_version {
                Some(v) if !v.is_empty() => v.clone(),
                _ => {
                    let list = fetch_loader_versions(inst.loader.clone(), &inst.mc_version).await?;
                    list.into_iter()
                        .next()
                        .ok_or_else(|| "No loader version found for this MC version".to_string())?
                }
            };
            let installer_url = if is_neo {
                format!(
                    "https://maven.neoforged.net/releases/net/neoforged/neoforge/{loader_ver}/neoforge-{loader_ver}-installer.jar"
                )
            } else {
                format!(
                    "https://maven.minecraftforge.net/net/minecraftforge/forge/{mc}-{lv}/forge-{mc}-{lv}-installer.jar",
                    mc = inst.mc_version,
                    lv = loader_ver
                )
            };

            let loader_tag = if is_neo {
                format!("neoforge-{loader_ver}")
            } else {
                format!("{}-forge-{loader_ver}", inst.mc_version)
            };
            let loader_profile_path = root.join("versions").join(&loader_tag).join(format!("{loader_tag}.json"));

            if !loader_profile_path.exists() {
                emit_log(
                    &app,
                    &instance_id,
                    "info",
                    format!("[Mono] Installing {loader_tag} via headless installer..."),
                );
                let installer_jar = root.join("meta").join(format!("{loader_tag}-installer.jar"));
                download_file(&client, &installer_url, &installer_jar, None).await?;

                // Ensure launcher_profiles.json exists in data root for Forge/NeoForge installer
                let lp = root.join("launcher_profiles.json");
                if !lp.exists() {
                    let _ = fs::write(&lp, r#"{"profiles":{}}"#);
                }

                let mut cmd = Command::new(&java_exe);
                cmd.args(["-jar", &installer_jar.to_string_lossy(), "--installClient", &root.to_string_lossy()]);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000);
                }
                let out = cmd.output().map_err(|e| format!("Loader installer failed: {e}"))?;
                if !out.status.success() {
                    let err = String::from_utf8_lossy(&out.stderr);
                    return Err(format!("Modloader installation failed: {err}"));
                }
            }

            if loader_profile_path.exists() {
                let raw = fs::read_to_string(&loader_profile_path).map_err(|e| e.to_string())?;
                let ljson: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                if let Some(mc) = ljson.get("mainClass").and_then(|v| v.as_str()) {
                    main_class = mc.to_string();
                }
                if let Some(libs) = ljson.get("libraries").and_then(|l| l.as_array()) {
                    for lib in libs {
                        if let Some(rel) = lib.pointer("/downloads/artifact/path").and_then(|v| v.as_str()) {
                            let dest = lib_root.join(rel);
                            if dest.exists() {
                                classpath_entries.push(dest);
                            }
                        } else if let Some(name) = lib.get("name").and_then(|n| n.as_str()) {
                            if let Some(rel) = maven_coords_to_path(name) {
                                let dest = lib_root.join(rel);
                                if dest.exists() {
                                    classpath_entries.push(dest);
                                }
                            }
                        }
                    }
                }
                collect_json_args(ljson.pointer("/arguments/jvm").and_then(|a| a.as_array()), |s| {
                    let mut resolved = s
                        .replace("${library_directory}", &lib_root.to_string_lossy())
                        .replace("${classpath_separator}", ";")
                        .replace("${version_name}", &loader_tag);
                    // Vanilla client JAR is stored as `<mc_version>.jar`, not `<loader_tag>.jar`.
                    if resolved.starts_with("-DignoreList=") {
                        let mc_jar = format!("{}.jar", inst.mc_version);
                        if !resolved.split(',').any(|p| p == mc_jar) {
                            resolved.push(',');
                            resolved.push_str(&mc_jar);
                        }
                    }
                    extra_jvm_args.push(resolved);
                });
                collect_json_args(ljson.pointer("/arguments/game").and_then(|a| a.as_array()), |s| {
                    extra_game_args.push(s.to_string());
                });
                if let Some(mc_args) = ljson.get("minecraftArguments").and_then(|v| v.as_str()) {
                    extract_legacy_extra_game_args(mc_args, &mut extra_game_args);
                }
            }
        }
    }

    // Download libraries in parallel (respecting max_concurrent_downloads)
    let settings = storage::load_settings();
    let max_dl = settings.max_concurrent_downloads.clamp(2, 32) as usize;
    let total_libs = downloads_queue.len() as u64;
    emit_progress(&app, &instance_id, "libraries", 0, total_libs, "Libraries");
    let sem = Arc::new(Semaphore::new(max_dl));
    let completed = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut handles = Vec::new();
    let mut native_jars = Vec::new();

    for (url, dest, sha1, is_native) in downloads_queue {
        if is_native {
            native_jars.push(dest.clone());
        }
        let permit_sem = sem.clone();
        let c = client.clone();
        let app_c = app.clone();
        let iid_c = instance_id.clone();
        let done_c = completed.clone();
        handles.push(tokio::spawn(async move {
            let _permit = permit_sem.acquire().await.map_err(|e| e.to_string())?;
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

    // Extract native DLLs
    for njar in native_jars {
        if let Ok(file) = fs::File::open(&njar) {
            if let Ok(mut archive) = zip::ZipArchive::new(file) {
                for i in 0..archive.len() {
                    if let Ok(mut entry) = archive.by_index(i) {
                        let name = entry.name().to_string();
                        if name.ends_with(".dll") && !name.contains('/') {
                            let out = natives_dir.join(&name);
                            if let Ok(mut f) = fs::File::create(&out) {
                                let _ = std::io::copy(&mut entry, &mut f);
                            }
                        }
                    }
                }
            }
        }
    }

    // 6. Download Assets
    let game_dir = storage::instance_game_dir(&instance_id);
    fs::create_dir_all(&game_dir).map_err(|e| e.to_string())?;
    let assets_dir = root.join("assets");
    let mut effective_assets_dir = assets_dir.clone();
    let asset_index_id = version_json
        .pointer("/assetIndex/id")
        .and_then(|v| v.as_str())
        .unwrap_or("legacy")
        .to_string();
    if let Some(asset_index_url) = version_json.pointer("/assetIndex/url").and_then(|v| v.as_str()) {
        let idx_path = assets_dir.join("indexes").join(format!("{asset_index_id}.json"));
        download_file(&client, asset_index_url, &idx_path, None).await?;

        let raw_idx = fs::read_to_string(&idx_path).map_err(|e| e.to_string())?;
        let idx_val: Value = serde_json::from_str(&raw_idx).map_err(|e| e.to_string())?;
        if let Some(objects) = idx_val.get("objects").and_then(|o| o.as_object()) {
            let mut missing_assets = Vec::new();
            for (_name, obj) in objects {
                if let Some(hash) = obj.get("hash").and_then(|h| h.as_str()) {
                    if hash.len() >= 2 {
                        let prefix = &hash[0..2];
                        let dest = assets_dir.join("objects").join(prefix).join(hash);
                        if !dest.exists() {
                            let url = format!("https://resources.download.minecraft.net/{prefix}/{hash}");
                            missing_assets.push((url, dest, hash.to_string()));
                        }
                    }
                }
            }
            let total_assets = missing_assets.len() as u64;
            if total_assets > 0 {
                emit_progress(&app, &instance_id, "assets", 0, total_assets, "Assets");
                let a_sem = Arc::new(Semaphore::new(16));
                let a_done = Arc::new(std::sync::atomic::AtomicU64::new(0));
                let mut a_handles = Vec::new();
                for (url, dest, hash) in missing_assets {
                    let ps = a_sem.clone();
                    let c = client.clone();
                    let app_c = app.clone();
                    let iid_c = instance_id.clone();
                    let d_c = a_done.clone();
                    a_handles.push(tokio::spawn(async move {
                        let _p = ps.acquire().await.map_err(|e| e.to_string())?;
                        let _ = download_file(&c, &url, &dest, Some(&hash)).await;
                        let n = d_c.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        if n % 25 == 0 || n == total_assets {
                            emit_progress(&app_c, &iid_c, "assets", n, total_assets, "Assets");
                        }
                        Ok::<(), String>(())
                    }));
                }
                for h in a_handles {
                    let _ = h.await;
                }
            }
            let is_virtual = idx_val.get("virtual").and_then(|v| v.as_bool()) == Some(true);
            let map_resources = idx_val.get("map_to_resources").and_then(|v| v.as_bool()) == Some(true);
            if is_virtual || map_resources {
                let target_root = if map_resources {
                    game_dir.join("resources")
                } else {
                    let vdir = assets_dir.join("virtual").join(&asset_index_id);
                    effective_assets_dir = vdir.clone();
                    vdir
                };
                for (rel_name, obj) in objects {
                    if let Some(hash) = obj.get("hash").and_then(|h| h.as_str()) {
                        if hash.len() >= 2 {
                            let src = assets_dir.join("objects").join(&hash[0..2]).join(hash);
                            let dst = target_root.join(rel_name);
                            if src.exists() && !dst.exists() {
                                if let Some(parent) = dst.parent() {
                                    let _ = fs::create_dir_all(parent);
                                }
                                let _ = fs::copy(&src, &dst);
                            }
                        }
                    }
                }
            }
        }
    }

    // 7. Build Classpath & JVM Args
    classpath_entries.push(client_jar_path);
    let mut unique_cp = Vec::new();
    let mut seen_cp = std::collections::HashSet::new();
    for p in classpath_entries {
        let s = p.to_string_lossy().to_string();
        if seen_cp.insert(s.clone()) {
            unique_cp.push(s);
        }
    }
    let classpath = unique_cp.join(";");

    let mut jvm_args: Vec<String> = vec![
        format!("-Xmx{}M", inst.ram_mb),
        format!("-Xms{}M", (inst.ram_mb / 2).max(512)),
        format!("-Djava.library.path={}", natives_dir.to_string_lossy()),
        "-Dminecraft.launcher.brand=Mono".to_string(),
        "-Dminecraft.launcher.version=0.1.0".to_string(),
    ];

    if account.account_type == AccountType::Elyby {
        emit_progress(&app, &instance_id, "auth", 0, 1, "Ely.by authlib-injector");
        let injector_path = auth::ensure_authlib_injector().await?;
        jvm_args.push(format!("-javaagent:{}=ely.by", injector_path.to_string_lossy()));
    }

    if !inst.jvm_args.trim().is_empty() {
        for part in inst.jvm_args.split_whitespace() {
            jvm_args.push(part.to_string());
        }
    }
    jvm_args.extend(extra_jvm_args);
    jvm_args.push("-cp".to_string());
    jvm_args.push(classpath);
    jvm_args.push(main_class);

    // Game args
    jvm_args.extend([
        "--username".to_string(),
        account.username.clone(),
        "--version".to_string(),
        inst.mc_version.clone(),
        "--gameDir".to_string(),
        game_dir.to_string_lossy().to_string(),
        "--assetsDir".to_string(),
        effective_assets_dir.to_string_lossy().to_string(),
        "--assetIndex".to_string(),
        asset_index_id,
        "--uuid".to_string(),
        account.uuid.replace('-', ""),
        "--accessToken".to_string(),
        account.access_token.unwrap_or_else(|| "0".to_string()),
        "--userType".to_string(),
        match account.account_type {
            AccountType::Microsoft => "msa".to_string(),
            AccountType::Elyby => "mojang".to_string(),
            AccountType::Offline => "legacy".to_string(),
        },
        "--versionType".to_string(),
        "Mono".to_string(),
    ]);
    if inst.fullscreen {
        jvm_args.push("--fullscreen".to_string());
    } else if inst.window_width > 0 && inst.window_height > 0 {
        jvm_args.extend([
            "--width".to_string(),
            inst.window_width.to_string(),
            "--height".to_string(),
            inst.window_height.to_string(),
        ]);
    }
    if let Some(world) = quick_play_world.filter(|w| !w.trim().is_empty()) {
        if supports_quick_play(&inst.mc_version) {
            jvm_args.push("--quickPlaySingleplayer".to_string());
            jvm_args.push(world);
        }
    }
    jvm_args.extend(extra_game_args);

    emit_progress(&app, &instance_id, "done", 1, 1, "Launching");
    emit_log(&app, &instance_id, "info", "[Mono] Starting Minecraft process...".to_string());

    let mut cmd = Command::new(&java_exe);
    cmd.current_dir(&game_dir)
        .args(&jvm_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child: Child = cmd
        .spawn()
        .map_err(|e| format!("Failed starting Java process: {e}"))?;
    let pid = child.id();

    {
        let mut map = running.lock().map_err(|_| "Lock error")?;
        map.insert(instance_id.clone(), pid);
    }

    inst.last_played = Some(Utc::now().to_rfc3339());
    let _ = storage::save_instance(&inst);
    emit_status(&app, &instance_id, "running", None);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    let iid_out = instance_id.clone();

    if let Some(out) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let lvl = if line.contains("/ERROR]") || line.contains("Exception") || line.contains("FATAL") {
                    "error"
                } else if line.contains("/WARN]") {
                    "warn"
                } else {
                    "info"
                };
                emit_log(&app_out, &iid_out, lvl, line);
            }
        });
    }

    let app_err = app.clone();
    let iid_err = instance_id.clone();
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                emit_log(&app_err, &iid_err, "error", line);
            }
        });
    }

    let started = std::time::Instant::now();
    let running_c = running.clone();
    let app_exit = app.clone();
    let iid_exit = instance_id.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        if let Ok(mut map) = running_c.lock() {
            map.remove(&iid_exit);
        }
        let elapsed = started.elapsed().as_secs();
        let all = storage::load_instances();
        if let Some(mut updated) = all.into_iter().find(|i| i.id == iid_exit) {
            updated.play_time_sec += elapsed;
            let _ = storage::save_instance(&updated);
        }
        match status {
            Ok(s) => {
                let code = s.code().unwrap_or(0);
                let st = if code == 0 { "idle" } else { "crashed" };
                emit_log(
                    &app_exit,
                    &iid_exit,
                    if code == 0 { "info" } else { "error" },
                    format!("[Mono] Process exited with code {code}"),
                );
                emit_status(&app_exit, &iid_exit, st, Some(code));
            }
            Err(e) => {
                emit_log(&app_exit, &iid_exit, "error", format!("[Mono] Process wait error: {e}"));
                emit_status(&app_exit, &iid_exit, "crashed", Some(-1));
            }
        }
        // Restore launcher window if it was hidden on launch
        let cfg = storage::load_settings();
        if cfg.close_on_launch {
            if let Some(win) = app_exit.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }
    });

    Ok(())
}

pub fn stop_instance(running: &RunningMap, instance_id: &str) -> Result<(), String> {
    let pid = {
        let map = running.lock().map_err(|_| "Lock error")?;
        map.get(instance_id).copied()
    };
    let Some(pid) = pid else {
        return Err("Instance is not running".into());
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    Ok(())
}
