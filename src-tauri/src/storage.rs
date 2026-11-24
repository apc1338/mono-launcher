use crate::models::{AccountsStore, ContentMetaEntry, InstalledContent, Instance, LauncherSettings};
use base64::Engine;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn default_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Mono")
}

pub fn ensure_layout(base: &Path) -> Result<(), String> {
    for sub in ["instances", "meta", "libraries", "assets", "runtimes"] {
        fs::create_dir_all(base.join(sub)).map_err(|e| format!("Failed creating dir {sub}: {e}"))?;
    }
    Ok(())
}

pub fn load_settings() -> LauncherSettings {
    let default_dir = default_data_dir();
    let cfg_path = default_dir.join("config.json");
    if let Ok(raw) = fs::read_to_string(&cfg_path) {
        if let Ok(settings) = serde_json::from_str::<LauncherSettings>(&raw) {
            return settings;
        }
    }
    let settings = LauncherSettings {
        language: "ru".to_string(),
        data_dir: default_dir.to_string_lossy().to_string(),
        default_ram_mb: 4096,
        close_on_launch: false,
        show_snapshots: false,
        open_console_on_crash: true,
        default_width: 1280,
        default_height: 720,
        default_fullscreen: false,
        max_concurrent_downloads: 8,
        java_8_path: None,
        java_17_path: None,
        java_21_path: None,
        java_25_path: None,
        curseforge_api_key: None,
        msa_client_id: None,
    };
    let _ = ensure_layout(&default_dir);
    let _ = save_settings(&settings);
    settings
}

pub fn save_settings(settings: &LauncherSettings) -> Result<(), String> {
    let default_dir = default_data_dir();
    fs::create_dir_all(&default_dir).map_err(|e| e.to_string())?;
    let cfg_path = default_dir.join("config.json");
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(cfg_path, json).map_err(|e| e.to_string())?;
    ensure_layout(Path::new(&settings.data_dir))?;
    Ok(())
}

pub fn data_root() -> PathBuf {
    let settings = load_settings();
    let p = PathBuf::from(settings.data_dir);
    let _ = ensure_layout(&p);
    p
}

pub fn load_accounts() -> AccountsStore {
    let path = data_root().join("accounts.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(store) = serde_json::from_str::<AccountsStore>(&raw) {
            return store;
        }
    }
    AccountsStore::default()
}

pub fn save_accounts(store: &AccountsStore) -> Result<(), String> {
    let path = data_root().join("accounts.json");
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn instance_dir(id: &str) -> PathBuf {
    data_root().join("instances").join(id)
}

pub fn instance_game_dir(id: &str) -> PathBuf {
    instance_dir(id).join("game")
}

pub fn load_instances() -> Vec<Instance> {
    let dir = data_root().join("instances");
    let mut result = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return result;
    };
    for entry in entries.flatten() {
        let meta = entry.path().join("instance.json");
        if let Ok(raw) = fs::read_to_string(meta) {
            if let Ok(inst) = serde_json::from_str::<Instance>(&raw) {
                result.push(inst);
            }
        }
    }
    result.sort_by(|a, b| {
        b.favorite
            .cmp(&a.favorite)
            .then_with(|| match (a.sort_order, b.sort_order) {
                (Some(oa), Some(ob)) => oa.cmp(&ob),
                (None, Some(_)) => std::cmp::Ordering::Less,
                (Some(_), None) => std::cmp::Ordering::Greater,
                (None, None) => b.created_at.cmp(&a.created_at),
            })
    });
    result
}

pub fn reorder_instances(ordered_ids: &[String]) -> Result<(), String> {
    for (idx, id) in ordered_ids.iter().enumerate() {
        let meta = instance_dir(id).join("instance.json");
        if let Ok(raw) = fs::read_to_string(&meta) {
            if let Ok(mut inst) = serde_json::from_str::<Instance>(&raw) {
                let order = Some(idx as i64);
                if inst.sort_order != order {
                    inst.sort_order = order;
                    let json = serde_json::to_string_pretty(&inst).map_err(|e| e.to_string())?;
                    fs::write(&meta, json).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

pub fn save_instance(inst: &Instance) -> Result<(), String> {
    let dir = instance_dir(&inst.id);
    let game_dir = instance_game_dir(&inst.id);
    for sub in ["mods", "resourcepacks", "shaderpacks", "saves", "config", "logs"] {
        fs::create_dir_all(game_dir.join(sub)).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(inst).map_err(|e| e.to_string())?;
    fs::write(dir.join("instance.json"), json).map_err(|e| e.to_string())
}

pub fn delete_instance_dir(id: &str) -> Result<(), String> {
    let dir = instance_dir(id);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let s = entry.path();
        let d = dst.join(entry.file_name());
        if s.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else if s.is_file() {
            fs::copy(&s, &d).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn clone_instance(src_id: &str, new_name: String) -> Result<Instance, String> {
    let all = load_instances();
    let src = all
        .into_iter()
        .find(|i| i.id == src_id)
        .ok_or_else(|| "Instance not found".to_string())?;

    let mut cloned = src.clone();
    cloned.id = uuid::Uuid::new_v4().to_string();
    cloned.name = new_name;
    cloned.created_at = chrono::Utc::now().to_rfc3339();
    cloned.last_played = None;
    cloned.play_time_sec = 0;
    cloned.favorite = false;
    cloned.sort_order = None;

    save_instance(&cloned)?;
    let src_game = instance_game_dir(src_id);
    let dst_game = instance_game_dir(&cloned.id);
    for folder in ["mods", "config", "resourcepacks", "shaderpacks"] {
        copy_dir_recursive(&src_game.join(folder), &dst_game.join(folder))?;
    }
    Ok(cloned)
}

pub fn clear_meta_cache() -> Result<(), String> {
    let meta = data_root().join("meta");
    if meta.exists() {
        for entry in fs::read_dir(&meta).map_err(|e| e.to_string())?.flatten() {
            let p = entry.path();
            if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("json") {
                let _ = fs::remove_file(p);
            }
        }
    }
    Ok(())
}

pub fn content_subfolder(kind: &str) -> &'static str {
    match kind {
        "resourcepack" => "resourcepacks",
        "shaderpack" => "shaderpacks",
        _ => "mods",
    }
}

pub fn load_content_meta(instance_id: &str) -> HashMap<String, ContentMetaEntry> {
    let path = instance_dir(instance_id).join("content-meta.json");
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, ContentMetaEntry>>(&raw) {
            return map;
        }
    }
    HashMap::new()
}

pub fn save_content_meta_entry(instance_id: &str, filename: &str, entry: ContentMetaEntry) {
    let mut map = load_content_meta(instance_id);
    let base = filename.trim_end_matches(".disabled").to_string();
    map.insert(base, entry);
    let path = instance_dir(instance_id).join("content-meta.json");
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = fs::write(path, json);
    }
}

fn read_icon_from_zip(archive: &mut zip::ZipArchive<fs::File>, icon_path: &str) -> Option<String> {
    let clean = icon_path.trim_start_matches('/').trim_start_matches("./");
    let mut entry = archive.by_name(clean).ok()?;
    if entry.size() > 512 * 1024 {
        return None;
    }
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Some(format!("data:image/png;base64,{b64}"))
}

fn parse_toml_field(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(val) = rest.strip_prefix('=') {
                let val = val.trim().trim_matches('"').trim_matches('\'').to_string();
                if !val.is_empty() && !val.contains("${") {
                    return Some(val);
                }
            }
        }
    }
    None
}

fn read_text_from_zip(archive: &mut zip::ZipArchive<fs::File>, name: &str) -> Option<String> {
    let mut f = archive.by_name(name).ok()?;
    let mut raw = String::new();
    f.read_to_string(&mut raw).ok()?;
    Some(raw)
}

fn inspect_jar_metadata(path: &Path) -> Option<ContentMetaEntry> {
    let file = fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    // 1. Fabric: fabric.mod.json
    if let Some(raw) = read_text_from_zip(&mut archive, "fabric.mod.json") {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            let name = val
                .get("name")
                .and_then(|v| v.as_str())
                .or_else(|| val.get("id").and_then(|v| v.as_str()))
                .map(String::from);
            let version = val.get("version").and_then(|v| v.as_str()).map(String::from);
            let icon_rel = val.get("icon").and_then(|v| v.as_str()).map(String::from);
            let website = val
                .pointer("/contact/homepage")
                .or_else(|| val.pointer("/contact/sources"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let icon_url = icon_rel.as_deref().and_then(|p| read_icon_from_zip(&mut archive, p));
            if let Some(display_name) = name {
                return Some(ContentMetaEntry {
                    display_name,
                    version,
                    icon_url,
                    website_url: website,
                    source: Some("local".into()),
                    project_id: None,
                });
            }
        }
    }

    // 2. NeoForge / Forge: META-INF/neoforge.mods.toml or META-INF/mods.toml
    for toml_path in ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"] {
        if let Some(raw) = read_text_from_zip(&mut archive, toml_path) {
            let name = parse_toml_field(&raw, "displayName")
                .or_else(|| parse_toml_field(&raw, "modId"));
            let version = parse_toml_field(&raw, "version");
            let logo = parse_toml_field(&raw, "logoFile");
            let website = parse_toml_field(&raw, "displayURL");
            let icon_url = logo.as_deref().and_then(|p| read_icon_from_zip(&mut archive, p));
            if let Some(display_name) = name {
                return Some(ContentMetaEntry {
                    display_name,
                    version,
                    icon_url,
                    website_url: website,
                    source: Some("local".into()),
                    project_id: None,
                });
            }
        }
    }

    None
}

pub fn list_instance_content(instance_id: &str, kind: &str) -> Vec<InstalledContent> {
    let dir = instance_game_dir(instance_id).join(content_subfolder(kind));
    let meta_map = load_content_meta(instance_id);
    let mut items = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return items;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        let enabled = !filename.ends_with(".disabled");
        let base_name = filename.trim_end_matches(".disabled");
        let is_valid = match kind {
            "mod" => base_name.ends_with(".jar"),
            _ => base_name.ends_with(".zip") || base_name.ends_with(".jar"),
        };
        if !is_valid {
            continue;
        }
        let fallback_name = base_name
            .trim_end_matches(".jar")
            .trim_end_matches(".zip")
            .to_string();
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);

        let saved_meta = meta_map.get(base_name).cloned();
        let jar_meta = if saved_meta.is_none() && kind == "mod" {
            inspect_jar_metadata(&path)
        } else {
            None
        };
        let meta = saved_meta.or(jar_meta);

        items.push(InstalledContent {
            filename,
            display_name: meta
                .as_ref()
                .map(|m| m.display_name.clone())
                .unwrap_or(fallback_name),
            version: meta.as_ref().and_then(|m| m.version.clone()),
            icon_url: meta.as_ref().and_then(|m| m.icon_url.clone()),
            website_url: meta.as_ref().and_then(|m| m.website_url.clone()),
            source: meta.as_ref().and_then(|m| m.source.clone()),
            project_id: meta.as_ref().and_then(|m| m.project_id.clone()),
            enabled,
            size_bytes,
            kind: kind.to_string(),
        });
    }
    items.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    items
}

pub fn toggle_instance_content(instance_id: &str, kind: &str, filename: &str) -> Result<String, String> {
    let dir = instance_game_dir(instance_id).join(content_subfolder(kind));
    let src = dir.join(filename);
    if !src.exists() {
        return Err("File not found".into());
    }
    let new_name = if filename.ends_with(".disabled") {
        filename.trim_end_matches(".disabled").to_string()
    } else {
        format!("{filename}.disabled")
    };
    let dst = dir.join(&new_name);
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(new_name)
}

pub fn delete_instance_content(instance_id: &str, kind: &str, filename: &str) -> Result<(), String> {
    let path = instance_game_dir(instance_id)
        .join(content_subfolder(kind))
        .join(filename);
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Validates a user-provided loader profile (Fabric/Quilt/Forge-style version JSON)
/// and returns a human-readable label for it.
pub fn read_custom_loader_label(path: &str) -> Result<String, String> {
    let cleaned = path.trim().trim_matches('"');
    let raw = fs::read_to_string(cleaned).map_err(|e| format!("Cannot read file: {e}"))?;
    let raw = raw.trim_start_matches('\u{feff}');
    let json: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Not a valid JSON file: {e}"))?;
    let has_main = json.get("mainClass").and_then(|v| v.as_str()).is_some();
    let has_libs = json.get("libraries").map_or(false, |l| l.is_array());
    if !has_main && !has_libs {
        return Err("This JSON is not a loader profile (no mainClass or libraries)".to_string());
    }
    let label = json
        .get("id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            Path::new(cleaned)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "custom".to_string());
    Ok(label)
}

/// Copies a validated custom loader profile into the instance folder.
pub fn install_custom_loader(instance_id: &str, src: &str) -> Result<String, String> {
    let label = read_custom_loader_label(src)?;
    let cleaned = src.trim().trim_matches('"');
    let dir = instance_dir(instance_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = fs::read_to_string(cleaned).map_err(|e| e.to_string())?;
    let raw = raw.trim_start_matches('\u{feff}');
    fs::write(dir.join("custom_loader.json"), raw).map_err(|e| e.to_string())?;
    Ok(label)
}
