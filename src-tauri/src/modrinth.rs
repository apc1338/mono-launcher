use crate::models::{
    CatalogHit, CatalogSearchResponse, CatalogVersion, CatalogVersionDependency, ContentMetaEntry,
    InstallResult, LoaderType,
};
use crate::storage;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use uuid::Uuid;

fn modrinth_client() -> Result<Client, String> {
    // Shared client: reuses pooled connections and TLS sessions between requests.
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = Client::builder()
        .user_agent("MonoLauncher/0.1.0 (https://github.com/mono-launcher)")
        .gzip(true)
        .connect_timeout(std::time::Duration::from_secs(10))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

fn modrinth_web_path(project_type: &str) -> &'static str {
    match project_type {
        "shader" => "shader",
        "resourcepack" => "resourcepack",
        "modpack" => "modpack",
        _ => "mod",
    }
}

#[derive(Deserialize)]
struct RawSearchResp {
    hits: Vec<RawHit>,
    total_hits: u64,
}

#[derive(Deserialize)]
struct RawHit {
    project_id: String,
    slug: String,
    title: String,
    description: String,
    author: String,
    downloads: u64,
    icon_url: Option<String>,
    project_type: String,
    categories: Vec<String>,
}

pub async fn search_projects(
    query: String,
    project_type: String,
    mc_version: Option<String>,
    loader: Option<String>,
    sort_index: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<CatalogSearchResponse, String> {
    let client = modrinth_client()?;
    let mut facets: Vec<Vec<String>> = vec![vec![format!("project_type:{project_type}")]];
    if let Some(v) = mc_version {
        if !v.is_empty() {
            facets.push(vec![format!("versions:{v}")]);
        }
    }
    if project_type == "mod" {
        if let Some(l) = loader {
            if !l.is_empty() && l != "vanilla" {
                facets.push(vec![format!("categories:{l}")]);
            }
        }
    }
    let facets_json = serde_json::to_string(&facets).map_err(|e| e.to_string())?;
    let index = sort_index.unwrap_or_else(|| "relevance".to_string());

    let resp = client
        .get("https://api.modrinth.com/v2/search")
        .query(&[
            ("query", query),
            ("facets", facets_json),
            ("index", index),
            ("limit", limit.to_string()),
            ("offset", offset.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("Modrinth search failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Modrinth API error: {}", resp.status()));
    }
    let raw: RawSearchResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(CatalogSearchResponse {
        total_hits: raw.total_hits,
        hits: raw
            .hits
            .into_iter()
            .map(|h| {
                let web = format!(
                    "https://modrinth.com/{}/{}",
                    modrinth_web_path(&h.project_type),
                    h.slug
                );
                CatalogHit {
                    source: "modrinth".to_string(),
                    project_id: h.project_id,
                    slug: h.slug,
                    title: h.title,
                    description: h.description,
                    author: h.author,
                    downloads: h.downloads,
                    icon_url: h.icon_url,
                    website_url: web,
                    project_type: h.project_type,
                    categories: h.categories,
                }
            })
            .collect(),
    })
}

#[derive(Deserialize)]
struct RawProject {
    title: String,
    slug: String,
    project_type: String,
    icon_url: Option<String>,
}

#[derive(Deserialize)]
struct RawVersion {
    id: String,
    name: String,
    version_number: String,
    version_type: String,
    date_published: String,
    game_versions: Vec<String>,
    loaders: Vec<String>,
    files: Vec<RawVersionFile>,
    #[serde(default)]
    dependencies: Vec<RawDependency>,
}

#[derive(Deserialize)]
struct RawVersionFile {
    url: String,
    filename: String,
    primary: bool,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
struct RawDependency {
    project_id: Option<String>,
    dependency_type: String,
}

fn version_is_compatible(
    v: &RawVersion,
    project_type: &str,
    mc_version: Option<&str>,
    loader: Option<&str>,
) -> bool {
    if let Some(mc) = mc_version {
        if !mc.is_empty() && !v.game_versions.iter().any(|g| g == mc) {
            return false;
        }
    }
    if project_type == "mod" {
        if let Some(l) = loader {
            let low = l.to_lowercase();
            if !low.is_empty() && low != "vanilla" {
                if !v.loaders.iter().any(|vl| vl.eq_ignore_ascii_case(&low)) {
                    return false;
                }
            }
        }
    }
    true
}

pub async fn get_project_versions(
    project_id: &str,
    project_type: &str,
    mc_version: Option<&str>,
    loader: Option<&str>,
) -> Result<Vec<CatalogVersion>, String> {
    let client = modrinth_client()?;
    let url = format!("https://api.modrinth.com/v2/project/{project_id}/version");
    let versions: Vec<RawVersion> = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Modrinth versions error: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let mut mapped: Vec<CatalogVersion> = versions
        .into_iter()
        .filter_map(|v| {
            let compatible = version_is_compatible(&v, project_type, mc_version, loader);
            let file = v
                .files
                .iter()
                .find(|f| f.primary)
                .or_else(|| v.files.first())?;
            let deps = v
                .dependencies
                .into_iter()
                .filter_map(|d| {
                    let pid = d.project_id?;
                    Some(CatalogVersionDependency {
                        project_id: pid,
                        dependency_type: d.dependency_type,
                    })
                })
                .collect();
            Some(CatalogVersion {
                id: v.id,
                name: v.name,
                version_number: v.version_number,
                version_type: v.version_type,
                date_published: v.date_published,
                game_versions: v.game_versions,
                loaders: v.loaders,
                compatible,
                filename: file.filename.clone(),
                download_url: file.url.clone(),
                file_size: file.size,
                dependencies: deps,
            })
        })
        .collect();

    mapped.sort_by(|a, b| b.compatible.cmp(&a.compatible));
    Ok(mapped)
}

async fn fetch_project_meta(client: &Client, project_id: &str) -> Option<RawProject> {
    let url = format!("https://api.modrinth.com/v2/project/{project_id}");
    client.get(&url).send().await.ok()?.json::<RawProject>().await.ok()
}

pub async fn install_project_version(
    instance_id: &str,
    project_id: &str,
    version_id: Option<&str>,
    project_type: &str,
    mc_version: &str,
    loader: Option<&str>,
    install_deps: bool,
) -> Result<InstallResult, String> {
    let mut visited = HashSet::new();
    let mut installed_deps = Vec::new();
    let filename = install_recursive(
        instance_id,
        project_id,
        version_id,
        project_type,
        mc_version,
        loader,
        install_deps,
        &mut visited,
        &mut installed_deps,
        true,
    )
    .await?;

    Ok(InstallResult {
        filename,
        installed_dependencies: installed_deps,
    })
}

#[allow(clippy::too_many_arguments)]
fn install_recursive<'a>(
    instance_id: &'a str,
    project_id: &'a str,
    version_id: Option<&'a str>,
    project_type: &'a str,
    mc_version: &'a str,
    loader: Option<&'a str>,
    install_deps: bool,
    visited: &'a mut HashSet<String>,
    installed_deps: &'a mut Vec<String>,
    is_root: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
    Box::pin(async move {
        if !visited.insert(project_id.to_string()) {
            return Ok(String::new());
        }

        let client = modrinth_client()?;
        let versions =
            get_project_versions(project_id, project_type, Some(mc_version), loader).await?;

        let chosen = if let Some(vid) = version_id {
            versions
                .into_iter()
                .find(|v| v.id == vid)
                .ok_or_else(|| "Selected version not found".to_string())?
        } else {
            versions
                .into_iter()
                .find(|v| v.compatible)
                .ok_or_else(|| {
                    "No compatible Modrinth version found for this Minecraft version and loader"
                        .to_string()
                })?
        };

        let sub = match project_type {
            "resourcepack" => "resourcepacks",
            "shader" => "shaderpacks",
            _ => "mods",
        };
        let dest_dir = storage::instance_game_dir(instance_id).join(sub);
        fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest_path = dest_dir.join(&chosen.filename);

        if !dest_path.exists() {
            let bytes = client
                .get(&chosen.download_url)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .bytes()
                .await
                .map_err(|e| e.to_string())?;
            fs::write(&dest_path, &bytes).map_err(|e| e.to_string())?;
        }

        let proj = fetch_project_meta(&client, project_id).await;
        let display_name = proj
            .as_ref()
            .map(|p| p.title.clone())
            .unwrap_or_else(|| chosen.name.clone());
        let website_url = proj.as_ref().map(|p| {
            format!(
                "https://modrinth.com/{}/{}",
                modrinth_web_path(&p.project_type),
                p.slug
            )
        });
        let icon_url = proj.and_then(|p| p.icon_url);

        storage::save_content_meta_entry(
            instance_id,
            &chosen.filename,
            ContentMetaEntry {
                display_name: display_name.clone(),
                version: Some(chosen.version_number.clone()),
                icon_url,
                website_url,
                source: Some("modrinth".into()),
                project_id: Some(project_id.to_string()),
            },
        );

        if !is_root {
            installed_deps.push(display_name);
        }

        if install_deps {
            for dep in &chosen.dependencies {
                if dep.dependency_type == "required" && !visited.contains(&dep.project_id) {
                    let _ = install_recursive(
                        instance_id,
                        &dep.project_id,
                        None,
                        project_type,
                        mc_version,
                        loader,
                        true,
                        visited,
                        installed_deps,
                        false,
                    )
                    .await;
                }
            }
        }

        Ok(chosen.filename)
    })
}

#[derive(Deserialize, Serialize)]
struct MrpackIndex {
    #[serde(rename = "formatVersion")]
    format_version: u32,
    game: String,
    #[serde(rename = "versionId")]
    version_id: String,
    name: String,
    files: Vec<MrpackFile>,
    dependencies: HashMap<String, String>,
}

#[derive(Deserialize, Serialize, Default)]
struct MrpackEnv {
    #[serde(default)]
    client: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct MrpackFile {
    path: String,
    downloads: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    hashes: HashMap<String, String>,
    #[serde(rename = "fileSize", default, skip_serializing_if = "is_zero")]
    file_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    env: Option<MrpackEnv>,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
}

pub async fn install_modpack(
    progress: std::sync::Arc<crate::packs::Progress>,
    project_id: &str,
    version_id: Option<&str>,
    target_instance_id: Option<&str>,
) -> Result<crate::packs::PackInstallResult, String> {
    use crate::packs::{self, ModpackRecord};

    let client = modrinth_client()?;
    progress.emit("prepare", 0, 0, "");

    let proj_meta = fetch_project_meta(&client, project_id).await;
    if let Some(m) = &proj_meta {
        progress.set_title(&m.title);
    }

    let version: RawVersion = if let Some(vid) = version_id {
        let url = format!("https://api.modrinth.com/v2/version/{vid}");
        client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?
    } else {
        let url = format!("https://api.modrinth.com/v2/project/{project_id}/version");
        let versions: Vec<RawVersion> = client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        versions
            .into_iter()
            .next()
            .ok_or_else(|| "Modpack has no downloadable versions".to_string())?
    };

    let file = version
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| version.files.first())
        .ok_or_else(|| "Modpack version has no files".to_string())?;

    let tmp_path = storage::data_root()
        .join("meta")
        .join(format!("modpack-{}.mrpack", Uuid::new_v4()));

    let res = async {
        packs::download_archive(&client, &file.url, &tmp_path, &progress, &[]).await?;
        let record_seed = Some(ModpackRecord {
            source: "modrinth".into(),
            project_id: project_id.to_string(),
            version_id: version.id.clone(),
            version_name: if version.version_number.is_empty() {
                version.name.clone()
            } else {
                version.version_number.clone()
            },
            icon_url: proj_meta.as_ref().and_then(|m| m.icon_url.clone()),
            website_url: proj_meta
                .as_ref()
                .map(|m| format!("https://modrinth.com/modpack/{}", m.slug)),
            files: Vec::new(),
        });
        let preferred_name = proj_meta.as_ref().map(|m| m.title.as_str());
        import_mrpack_archive(
            progress.clone(),
            &tmp_path,
            preferred_name,
            target_instance_id,
            record_seed,
        )
        .await
    }
    .await;
    let _ = fs::remove_file(&tmp_path);
    res
}

pub async fn import_pack_file(
    progress: std::sync::Arc<crate::packs::Progress>,
    file_path: &str,
) -> Result<crate::packs::PackInstallResult, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err("Archive file does not exist".into());
    }
    let has_mrpack = {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip/mrpack: {e}"))?;
        let mr = archive.by_name("modrinth.index.json").is_ok();
        let cf = !mr && archive.by_name("manifest.json").is_ok();
        if !mr && !cf {
            return Err("Archive is neither a Modrinth (.mrpack) nor a CurseForge (.zip) modpack".into());
        }
        mr
    };
    if has_mrpack {
        import_mrpack_archive(progress, path, None, None, None).await
    } else {
        crate::curseforge::import_cf_zip_file(progress, path).await
    }
}

async fn import_mrpack_archive(
    progress: std::sync::Arc<crate::packs::Progress>,
    path: &Path,
    preferred_name: Option<&str>,
    target_instance_id: Option<&str>,
    record_seed: Option<crate::packs::ModpackRecord>,
) -> Result<crate::packs::PackInstallResult, String> {
    use crate::packs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    let index: MrpackIndex = {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip/mrpack: {e}"))?;
        let mut idx_entry = archive
            .by_name("modrinth.index.json")
            .map_err(|_| "Archive does not contain modrinth.index.json".to_string())?;
        let mut raw = String::new();
        idx_entry.read_to_string(&mut raw).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| format!("Invalid modrinth.index.json: {e}"))?
    };

    let mc_version = index
        .dependencies
        .get("minecraft")
        .cloned()
        .unwrap_or_else(|| "1.21.4".to_string());

    let (loader, loader_version) = if let Some(v) = index.dependencies.get("fabric-loader") {
        (LoaderType::Fabric, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("quilt-loader") {
        (LoaderType::Quilt, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("neoforge") {
        (LoaderType::Neoforge, Some(v.clone()))
    } else if let Some(v) = index.dependencies.get("forge") {
        (LoaderType::Forge, Some(v.clone()))
    } else {
        (LoaderType::Vanilla, None)
    };

    let name = preferred_name
        .filter(|n| !n.is_empty())
        .unwrap_or(index.name.as_str());
    if !name.is_empty() {
        progress.set_title(name);
    }
    let inst = packs::prepare_instance(
        target_instance_id,
        name,
        mc_version,
        loader,
        loader_version,
        record_seed.as_ref().and_then(|r| r.icon_url.clone()),
    )?;
    progress.set_instance(&inst.id);
    let game_dir = storage::instance_game_dir(&inst.id);

    let client = modrinth_client()?;
    let eligible: Vec<&MrpackFile> = index
        .files
        .iter()
        .filter(|f| {
            let clean = !f.path.contains("..") && !f.path.starts_with('/') && !f.path.starts_with('\\');
            let supported = f
                .env
                .as_ref()
                .and_then(|e| e.client.as_deref())
                .map_or(true, |c| c != "unsupported");
            clean && supported && !f.downloads.is_empty()
        })
        .collect();

    let total = eligible.len() as u64;
    let done = Arc::new(AtomicU64::new(0));
    let max_dl = storage::load_settings().max_concurrent_downloads.clamp(2, 32) as usize;
    let sem = Arc::new(tokio::sync::Semaphore::new(max_dl));
    progress.emit("files", 0, total, "");

    let mut handles = Vec::new();
    for f in eligible {
        let client = client.clone();
        let sem = sem.clone();
        let done = done.clone();
        let progress = progress.clone();
        let rel = f.path.replace('\\', "/");
        let dest = game_dir.join(&rel);
        let urls = f.downloads.clone();
        let sha1 = f.hashes.get("sha1").cloned();
        let size = f.file_size;
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.map_err(|e| e.to_string())?;
            let mut last_err = String::new();
            let mut ok = false;
            for u in &urls {
                match packs::download_verified(&client, u, &dest, sha1.as_deref(), size).await {
                    Ok(()) => {
                        ok = true;
                        break;
                    }
                    Err(e) => last_err = e,
                }
            }
            if !ok {
                return Err(last_err);
            }
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            let fname = Path::new(&rel)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rel.clone());
            progress.emit("files", n, total, &fname);
            Ok::<_, String>(rel)
        }));
    }

    let mut record_files = Vec::new();
    let mut errors = Vec::new();
    for h in handles {
        match h.await.map_err(|e| e.to_string())? {
            Ok(rel) => {
                if packs::is_content_path(&rel) {
                    record_files.push(rel);
                }
            }
            Err(e) => errors.push(e),
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "{} file(s) failed to download. First error: {}",
            errors.len(),
            errors[0]
        ));
    }

    let prefixes = vec!["overrides".to_string(), "client-overrides".to_string()];
    record_files.extend(packs::extract_overrides(path, &prefixes, &game_dir, &progress)?);

    if let Some(mut rec) = record_seed {
        rec.files = record_files;
        packs::save_record(&inst.id, &rec)?;
    }

    progress.emit("done", 1, 1, "");
    Ok(packs::PackInstallResult {
        instance: inst,
        pending: Vec::new(),
    })
}

#[derive(Deserialize)]
struct MrLookupVersion {
    files: Vec<MrLookupFile>,
}

#[derive(Deserialize)]
struct MrLookupFile {
    url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

pub async fn export_instance_mrpack(instance_id: &str, dest_path: &str) -> Result<(), String> {
    let instances = storage::load_instances();
    let inst = instances
        .into_iter()
        .find(|i| i.id == instance_id)
        .ok_or_else(|| "Instance not found".to_string())?;

    let mut deps = HashMap::new();
    deps.insert("minecraft".to_string(), inst.mc_version.clone());
    if let Some(lv) = &inst.loader_version {
        let key = match inst.loader {
            LoaderType::Fabric => Some("fabric-loader"),
            LoaderType::Forge => Some("forge"),
            LoaderType::Neoforge => Some("neoforge"),
            LoaderType::Quilt => Some("quilt-loader"),
            LoaderType::Vanilla | LoaderType::Custom => None,
        };
        if let Some(k) = key {
            deps.insert(k.to_string(), lv.clone());
        }
    }

    let game_dir = storage::instance_game_dir(instance_id);
    // Collect active content files for Modrinth hash lookup
    let mut candidates: Vec<(String, std::path::PathBuf, String)> = Vec::new(); // (rel, full_path, sha1)
    for folder in ["mods", "resourcepacks", "shaderpacks"] {
        let dir = game_dir.join(folder);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".disabled") {
                continue;
            }
            if let Some(sha1) = crate::extras::sha1_file(&p) {
                candidates.push((format!("{folder}/{name}"), p, sha1));
            }
        }
    }

    let mut matched_rels: HashSet<String> = HashSet::new();
    let mut index_files: Vec<MrpackFile> = Vec::new();

    if !candidates.is_empty() {
        if let Ok(client) = modrinth_client() {
            let hashes: Vec<String> = candidates.iter().map(|(_, _, h)| h.clone()).collect();
            if let Ok(resp) = client
                .post("https://api.modrinth.com/v2/version_files")
                .json(&serde_json::json!({
                    "hashes": hashes,
                    "algorithm": "sha1",
                }))
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(map) = resp.json::<HashMap<String, MrLookupVersion>>().await {
                        for (rel, full_path, sha1) in &candidates {
                            let Some(ver) = map.get(sha1) else {
                                continue;
                            };
                            let file_match = ver
                                .files
                                .iter()
                                .find(|f| {
                                    f.hashes
                                        .get("sha1")
                                        .map(|h| h.eq_ignore_ascii_case(sha1))
                                        .unwrap_or(false)
                                })
                                .or_else(|| ver.files.first());
                            let Some(mf) = file_match else {
                                continue;
                            };
                            if !mf.hashes.contains_key("sha1") || !mf.hashes.contains_key("sha512") {
                                continue;
                            }
                            let size = if mf.size > 0 {
                                mf.size
                            } else {
                                fs::metadata(full_path).map(|m| m.len()).unwrap_or(0)
                            };
                            matched_rels.insert(rel.clone());
                            index_files.push(MrpackFile {
                                path: rel.clone(),
                                downloads: vec![mf.url.clone()],
                                hashes: mf.hashes.clone(),
                                file_size: size,
                                env: None,
                            });
                        }
                    }
                }
            }
        }
    }

    let index = MrpackIndex {
        format_version: 1,
        game: "minecraft".to_string(),
        version_id: "1.0.0".to_string(),
        name: inst.name.clone(),
        files: index_files,
        dependencies: deps,
    };

    let out_file = fs::File::create(dest_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(out_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("modrinth.index.json", options)
        .map_err(|e| e.to_string())?;
    let idx_json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    zip.write_all(idx_json.as_bytes()).map_err(|e| e.to_string())?;

    for folder in ["mods", "config", "resourcepacks", "shaderpacks"] {
        let dir = game_dir.join(folder);
        if dir.exists() {
            add_dir_to_zip(&mut zip, &dir, &format!("overrides/{folder}"), folder, &matched_rels, options)?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    src_dir: &Path,
    prefix: &str,
    rel_prefix: &str,
    skip_rels: &HashSet<String>,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let entries = fs::read_dir(src_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = format!("{rel_prefix}/{name}");
        if skip_rels.contains(&rel) || name.ends_with(".disabled") {
            continue;
        }
        let zip_path = format!("{prefix}/{name}");
        if path.is_dir() {
            add_dir_to_zip(zip, &path, &zip_path, &rel, skip_rels, options)?;
        } else if path.is_file() {
            zip.start_file(&zip_path, options).map_err(|e| e.to_string())?;
            let data = fs::read(&path).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
