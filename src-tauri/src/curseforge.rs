use crate::models::{
    CatalogHit, CatalogSearchResponse, CatalogVersion, CatalogVersionDependency, ContentMetaEntry,
    InstallResult,
};
use crate::storage;
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;
use std::fs;

const CF_GAME_ID_MINECRAFT: u32 = 432;
const DEFAULT_CF_API_KEY: &str = "$2a$10$k/latSfDA4DpbeZss05Qae5XpD8ByGI.xA/e3A8X6NOhQwJcs9oxW";

pub fn resolve_api_key() -> Result<String, String> {
    if let Some(k) = storage::load_settings().curseforge_api_key {
        let trimmed = k.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    if let Ok(k) = std::env::var("CURSEFORGE_API_KEY") {
        let trimmed = k.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    if let Some(k) = option_env!("CURSEFORGE_API_KEY") {
        let trimmed = k.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    Ok(DEFAULT_CF_API_KEY.to_string())
}

fn cf_client() -> Result<Client, String> {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = Client::builder()
        .user_agent("MonoLauncher/0.1.0")
        .gzip(true)
        .connect_timeout(std::time::Duration::from_secs(10))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

fn class_id_for_type(project_type: &str) -> u32 {
    match project_type {
        "resourcepack" => 12,
        "shader" => 6552,
        "modpack" => 4471,
        _ => 6, // Mods
    }
}

fn type_for_class_id(class_id: u32) -> &'static str {
    match class_id {
        12 => "resourcepack",
        6552 => "shader",
        4471 => "modpack",
        _ => "mod",
    }
}

fn loader_type_id(loader: &str) -> Option<u32> {
    match loader.to_lowercase().as_str() {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

fn sort_field_for_index(sort_index: Option<&str>) -> u32 {
    match sort_index {
        Some("downloads") => 6, // TotalDownloads
        Some("updated") => 3,   // LastUpdated
        Some("newest") => 11,   // ReleasedDate
        _ => 2,                 // Popularity
    }
}

#[derive(Deserialize)]
struct CfSearchResp {
    data: Vec<CfMod>,
    pagination: CfPagination,
}

#[derive(Deserialize)]
struct CfPagination {
    #[serde(rename = "totalCount")]
    total_count: u64,
}

#[derive(Deserialize)]
struct CfModResp {
    data: CfMod,
}

#[derive(Deserialize)]
struct CfMod {
    id: u64,
    #[serde(default, rename = "classId")]
    class_id: u32,
    slug: String,
    name: String,
    summary: String,
    #[serde(rename = "downloadCount")]
    download_count: u64,
    authors: Vec<CfAuthor>,
    logo: Option<CfLogo>,
    links: Option<CfLinks>,
}

#[derive(Deserialize)]
struct CfAuthor {
    name: String,
}

#[derive(Deserialize, Clone)]
struct CfLogo {
    #[serde(rename = "thumbnailUrl")]
    thumbnail_url: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize, Clone)]
struct CfLinks {
    #[serde(rename = "websiteUrl")]
    website_url: Option<String>,
}

#[derive(Deserialize)]
struct CfFilesResp {
    data: Vec<CfFile>,
}

#[derive(Deserialize)]
struct CfFile {
    id: u64,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "releaseType")]
    release_type: u32, // 1=Release, 2=Beta, 3=Alpha
    #[serde(rename = "fileDate")]
    file_date: String,
    #[serde(rename = "fileLength")]
    file_length: u64,
    #[serde(rename = "downloadUrl")]
    download_url: Option<String>,
    #[serde(rename = "gameVersions")]
    game_versions: Vec<String>,
    dependencies: Vec<CfDep>,
}

#[derive(Deserialize)]
struct CfDep {
    #[serde(rename = "modId")]
    mod_id: u64,
    #[serde(rename = "relationType")]
    relation_type: u32, // 3 = RequiredDependency, 2 = OptionalDependency, 5 = Incompatible
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
    let api_key = resolve_api_key()?;
    let client = cf_client()?;

    let class_id = class_id_for_type(&project_type);
    let sort_field = sort_field_for_index(sort_index.as_deref());

    let mut params: Vec<(&str, String)> = vec![
        ("gameId", CF_GAME_ID_MINECRAFT.to_string()),
        ("classId", class_id.to_string()),
        ("sortField", sort_field.to_string()),
        ("sortOrder", "desc".to_string()),
        ("pageSize", limit.min(50).to_string()),
        ("index", offset.to_string()),
    ];
    if !query.trim().is_empty() {
        params.push(("searchFilter", query));
    }
    if let Some(v) = mc_version {
        if !v.is_empty() {
            params.push(("gameVersion", v));
        }
    }
    if project_type == "mod" {
        if let Some(l) = loader {
            if let Some(lid) = loader_type_id(&l) {
                params.push(("modLoaderType", lid.to_string()));
            }
        }
    }

    let resp = client
        .get("https://api.curseforge.com/v1/mods/search")
        .header("x-api-key", &api_key)
        .header("Accept", "application/json")
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("CurseForge request failed: {e}"))?;

    if resp.status().as_u16() == 403 {
        return Err("Invalid CurseForge API key (HTTP 403)".into());
    }
    if !resp.status().is_success() {
        return Err(format!("CurseForge API error: {}", resp.status()));
    }

    let raw: CfSearchResp = resp.json().await.map_err(|e| e.to_string())?;
    let hits = raw
        .data
        .into_iter()
        .map(|m| {
            let website_url = m
                .links
                .and_then(|l| l.website_url)
                .unwrap_or_else(|| format!("https://www.curseforge.com/minecraft/mc-mods/{}", m.slug));
            let icon_url = m.logo.and_then(|l| l.thumbnail_url.or(l.url));
            let author = m
                .authors
                .first()
                .map(|a| a.name.clone())
                .unwrap_or_else(|| "Unknown".into());
            CatalogHit {
                source: "curseforge".to_string(),
                project_id: m.id.to_string(),
                slug: m.slug,
                title: m.name,
                description: m.summary,
                author,
                downloads: m.download_count,
                icon_url,
                website_url,
                project_type: project_type.clone(),
                categories: Vec::new(),
            }
        })
        .collect();

    Ok(CatalogSearchResponse {
        hits,
        total_hits: raw.pagination.total_count,
    })
}

fn parse_cf_loaders_and_versions(game_versions: &[String]) -> (Vec<String>, Vec<String>) {
    let mut loaders = Vec::new();
    let mut versions = Vec::new();
    for gv in game_versions {
        let low = gv.to_lowercase();
        if matches!(low.as_str(), "fabric" | "forge" | "neoforge" | "quilt") {
            loaders.push(low);
        } else if gv.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            versions.push(gv.clone());
        }
    }
    (versions, loaders)
}

fn is_cf_file_compatible(
    file_versions: &[String],
    file_loaders: &[String],
    project_type: &str,
    mc_version: Option<&str>,
    loader: Option<&str>,
) -> bool {
    if let Some(mc) = mc_version {
        if !mc.is_empty() && !file_versions.iter().any(|v| v == mc) {
            return false;
        }
    }
    if project_type == "mod" {
        if let Some(l) = loader {
            let low = l.to_lowercase();
            if !low.is_empty() && low != "vanilla" && !file_loaders.is_empty() {
                if !file_loaders.iter().any(|fl| fl == &low) {
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
    let api_key = resolve_api_key()?;
    let client = cf_client()?;

    let url = format!("https://api.curseforge.com/v1/mods/{project_id}/files");
    let resp = client
        .get(&url)
        .header("x-api-key", &api_key)
        .header("Accept", "application/json")
        .query(&[("pageSize", "50")])
        .send()
        .await
        .map_err(|e| format!("CurseForge files error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("CurseForge API error: {}", resp.status()));
    }

    let raw: CfFilesResp = resp.json().await.map_err(|e| e.to_string())?;
    let mut result: Vec<CatalogVersion> = raw
        .data
        .into_iter()
        .map(|f| {
            let (game_versions, loaders) = parse_cf_loaders_and_versions(&f.game_versions);
            let compatible =
                is_cf_file_compatible(&game_versions, &loaders, project_type, mc_version, loader);
            let version_type = match f.release_type {
                1 => "release",
                2 => "beta",
                _ => "alpha",
            }
            .to_string();
            let deps = f
                .dependencies
                .into_iter()
                .filter_map(|d| {
                    let dtype = match d.relation_type {
                        3 => "required",
                        2 => "optional",
                        5 => "incompatible",
                        _ => return None,
                    };
                    Some(CatalogVersionDependency {
                        project_id: d.mod_id.to_string(),
                        dependency_type: dtype.to_string(),
                    })
                })
                .collect();

            CatalogVersion {
                id: f.id.to_string(),
                name: f.display_name.clone(),
                version_number: f
                    .file_name
                    .trim_end_matches(".jar")
                    .trim_end_matches(".zip")
                    .to_string(),
                version_type,
                date_published: f.file_date,
                game_versions,
                loaders,
                compatible,
                filename: f.file_name,
                download_url: f.download_url.unwrap_or_default(),
                file_size: f.file_length,
                dependencies: deps,
            }
        })
        .collect();

    // Sort compatible first, keeping newest order within each group
    result.sort_by(|a, b| b.compatible.cmp(&a.compatible));
    Ok(result)
}

async fn fetch_mod_meta(api_key: &str, client: &Client, project_id: &str) -> Option<CfMod> {
    let url = format!("https://api.curseforge.com/v1/mods/{project_id}");
    let resp = client.get(&url).header("x-api-key", api_key).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<CfModResp>().await.ok().map(|r| r.data)
}

pub(crate) async fn fetch_project_meta_basic(
    project_id: &str,
) -> Option<(String, Option<String>, String)> {
    let api_key = resolve_api_key().ok()?;
    let client = cf_client().ok()?;
    let m = fetch_mod_meta(&api_key, &client, project_id).await?;
    let icon = m
        .logo
        .as_ref()
        .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone()));
    let ptype = type_for_class_id(m.class_id).to_string();
    Some((m.name, icon, ptype))
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

        let api_key = resolve_api_key()?;
        let client = cf_client()?;
        let meta = fetch_mod_meta(&api_key, &client, project_id).await;
        let effective_type: String = if !is_root {
            let actual = meta
                .as_ref()
                .filter(|m| m.class_id != 0)
                .map(|m| type_for_class_id(m.class_id))
                .unwrap_or(project_type);
            if project_type != "mod" && actual != project_type {
                return Ok(String::new());
            }
            actual.to_string()
        } else {
            project_type.to_string()
        };

        let versions = get_project_versions(
            project_id,
            &effective_type,
            Some(mc_version),
            loader,
        )
        .await?;

        let chosen = if let Some(vid) = version_id {
            versions
                .into_iter()
                .find(|v| v.id == vid)
                .ok_or_else(|| "Selected CurseForge version not found".to_string())?
        } else {
            versions
                .into_iter()
                .find(|v| v.compatible && !v.download_url.is_empty())
                .ok_or_else(|| {
                    "No compatible CurseForge version found for this Minecraft version and loader"
                        .to_string()
                })?
        };

        if chosen.download_url.is_empty() {
            return Err(
                "Author disabled third-party downloads for this CurseForge file. Open on website to download manually."
                    .into(),
            );
        }

        let sub = match effective_type.as_str() {
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
                .header("x-api-key", &api_key)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .bytes()
                .await
                .map_err(|e| e.to_string())?;
            fs::write(&dest_path, &bytes).map_err(|e| e.to_string())?;
        }

        let display_name = meta
            .as_ref()
            .map(|m| m.name.clone())
            .unwrap_or_else(|| chosen.name.clone());
        let icon_url = meta
            .as_ref()
            .and_then(|m| m.logo.as_ref())
            .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone()));
        let website_url = meta
            .as_ref()
            .and_then(|m| m.links.as_ref())
            .and_then(|l| l.website_url.clone());

        storage::save_content_meta_entry(
            instance_id,
            &chosen.filename,
            ContentMetaEntry {
                display_name: display_name.clone(),
                version: Some(chosen.version_number.clone()),
                icon_url,
                website_url,
                source: Some("curseforge".into()),
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

// ---------------------------------------------------------------------------
// Modpacks
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CfManifest {
    minecraft: CfManifestMc,
    #[serde(default)]
    name: String,
    #[serde(default)]
    files: Vec<CfManifestFile>,
    #[serde(default)]
    overrides: Option<String>,
}

#[derive(Deserialize)]
struct CfManifestMc {
    version: String,
    #[serde(rename = "modLoaders", default)]
    mod_loaders: Vec<CfManifestLoader>,
}

#[derive(Deserialize)]
struct CfManifestLoader {
    id: String,
    #[serde(default)]
    primary: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
struct CfManifestFile {
    #[serde(rename = "projectID")]
    project_id: u64,
    #[serde(rename = "fileID")]
    file_id: u64,
    #[serde(default = "default_true")]
    required: bool,
}

#[derive(Deserialize)]
struct CfFullFilesResp {
    data: Vec<CfFullFile>,
}

#[derive(Deserialize)]
struct CfSingleFileResp {
    data: CfFullFile,
}

#[derive(Deserialize, Clone)]
struct CfFullFile {
    id: u64,
    #[serde(rename = "modId")]
    mod_id: u64,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "downloadUrl")]
    download_url: Option<String>,
    #[serde(rename = "fileLength", default)]
    file_length: u64,
    #[serde(default)]
    hashes: Vec<CfHash>,
}

impl CfFullFile {
    fn sha1(&self) -> Option<String> {
        self.hashes
            .iter()
            .find(|h| h.algo == 1)
            .map(|h| h.value.to_lowercase())
    }
}

#[derive(Deserialize, Clone)]
struct CfHash {
    value: String,
    algo: u32,
}

#[derive(Deserialize)]
struct CfModsLiteResp {
    data: Vec<CfModLite>,
}

#[derive(Deserialize, Clone)]
struct CfModLite {
    id: u64,
    name: String,
    slug: String,
    #[serde(rename = "classId", default)]
    class_id: Option<u32>,
    links: Option<CfLinks>,
    logo: Option<CfLogo>,
}

impl CfModLite {
    fn website(&self) -> String {
        self.links
            .as_ref()
            .and_then(|l| l.website_url.clone())
            .unwrap_or_else(|| {
                let section = match self.class_id {
                    Some(12) => "texture-packs",
                    Some(6552) => "shaders",
                    Some(4471) => "modpacks",
                    _ => "mc-mods",
                };
                format!("https://www.curseforge.com/minecraft/{section}/{}", self.slug)
            })
    }
    fn icon(&self) -> Option<String> {
        self.logo
            .as_ref()
            .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone()))
    }
}

async fn cf_post<T: serde::de::DeserializeOwned>(
    client: &Client,
    api_key: &str,
    url: &str,
    body: serde_json::Value,
) -> Result<T, String> {
    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("CurseForge request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("CurseForge API error: {}", resp.status()));
    }
    resp.json::<T>().await.map_err(|e| e.to_string())
}

async fn fetch_files_bulk(client: &Client, api_key: &str, ids: &[u64]) -> Result<Vec<CfFullFile>, String> {
    let mut out = Vec::new();
    for chunk in ids.chunks(200) {
        let r: CfFullFilesResp = cf_post(
            client,
            api_key,
            "https://api.curseforge.com/v1/mods/files",
            serde_json::json!({ "fileIds": chunk }),
        )
        .await?;
        out.extend(r.data);
    }
    Ok(out)
}

async fn fetch_mods_bulk(client: &Client, api_key: &str, ids: &[u64]) -> Result<Vec<CfModLite>, String> {
    let mut out = Vec::new();
    for chunk in ids.chunks(200) {
        let r: CfModsLiteResp = cf_post(
            client,
            api_key,
            "https://api.curseforge.com/v1/mods",
            serde_json::json!({ "modIds": chunk }),
        )
        .await?;
        out.extend(r.data);
    }
    Ok(out)
}

fn parse_cf_loader(mc: &CfManifestMc) -> (crate::models::LoaderType, Option<String>) {
    use crate::models::LoaderType;
    let primary = mc
        .mod_loaders
        .iter()
        .find(|l| l.primary)
        .or_else(|| mc.mod_loaders.first());
    let Some(l) = primary else {
        return (LoaderType::Vanilla, None);
    };
    let (kind, ver) = l.id.split_once('-').unwrap_or((l.id.as_str(), ""));
    let ver = if ver.is_empty() { None } else { Some(ver.to_string()) };
    match kind.to_lowercase().as_str() {
        "forge" => (LoaderType::Forge, ver),
        "neoforge" => {
            // Old 1.20.1 NeoForge ids look like "neoforge-1.20.1-47.1.x"
            let v = ver.map(|v| match v.strip_prefix(&format!("{}-", mc.version)) {
                Some(rest) => rest.to_string(),
                None => v,
            });
            (LoaderType::Neoforge, v)
        }
        "fabric" => (LoaderType::Fabric, ver),
        "quilt" => (LoaderType::Quilt, ver),
        _ => (LoaderType::Vanilla, None),
    }
}

/// Installs (or switches the version of) a CurseForge modpack directly in the launcher.
/// Files whose authors disabled third-party downloads are returned as `pending`.
pub async fn install_modpack(
    progress: std::sync::Arc<crate::packs::Progress>,
    project_id: &str,
    file_id: Option<&str>,
    target_instance_id: Option<&str>,
) -> Result<crate::packs::PackInstallResult, String> {
    use crate::packs::{self, ModpackRecord};

    let api_key = resolve_api_key()?;
    let client = cf_client()?;
    progress.emit("prepare", 0, 0, "");

    // 1. Pack metadata + chosen file
    let pack_meta = fetch_mod_meta(&api_key, &client, project_id).await;
    if let Some(m) = &pack_meta {
        progress.set_title(&m.name);
    }
    let pack_file: CfFullFile = match file_id {
        Some(fid) => {
            let url = format!("https://api.curseforge.com/v1/mods/{project_id}/files/{fid}");
            let resp = client
                .get(&url)
                .header("x-api-key", &api_key)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("CurseForge API error: {}", resp.status()));
            }
            resp.json::<CfSingleFileResp>().await.map_err(|e| e.to_string())?.data
        }
        None => {
            let url = format!("https://api.curseforge.com/v1/mods/{project_id}/files");
            let resp = client
                .get(&url)
                .header("x-api-key", &api_key)
                .query(&[("pageSize", "1")])
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("CurseForge API error: {}", resp.status()));
            }
            resp.json::<CfFullFilesResp>()
                .await
                .map_err(|e| e.to_string())?
                .data
                .into_iter()
                .next()
                .ok_or_else(|| "This modpack has no files".to_string())?
        }
    };
    let pack_url = pack_file.download_url.clone().ok_or_else(|| {
        "The author of this modpack disabled downloads from third-party launchers".to_string()
    })?;

    // 2. Download the pack archive
    let tmp = storage::data_root()
        .join("meta")
        .join(format!("cf-pack-{}.zip", uuid::Uuid::new_v4()));
    let result = async {
        packs::download_archive(&client, &pack_url, &tmp, &progress, &[]).await?;
        let version_name = if pack_file.display_name.is_empty() {
            pack_file.file_name.clone()
        } else {
            pack_file.display_name.clone()
        };
        let record_seed = Some(ModpackRecord {
            source: "curseforge".into(),
            project_id: project_id.to_string(),
            version_id: pack_file.id.to_string(),
            version_name,
            icon_url: pack_meta
                .as_ref()
                .and_then(|m| m.logo.as_ref())
                .and_then(|l| l.thumbnail_url.clone().or_else(|| l.url.clone())),
            website_url: pack_meta
                .as_ref()
                .and_then(|m| m.links.as_ref())
                .and_then(|l| l.website_url.clone()),
            files: Vec::new(),
        });
        let preferred_name = pack_meta.as_ref().map(|m| m.name.as_str());
        install_cf_archive(
            progress.clone(),
            &tmp,
            preferred_name,
            target_instance_id,
            record_seed,
        )
        .await
    }
    .await;
    let _ = fs::remove_file(&tmp);
    result
}

pub async fn import_cf_zip_file(
    progress: std::sync::Arc<crate::packs::Progress>,
    archive_path: &std::path::Path,
) -> Result<crate::packs::PackInstallResult, String> {
    install_cf_archive(progress, archive_path, None, None, None).await
}

async fn install_cf_archive(
    progress: std::sync::Arc<crate::packs::Progress>,
    archive_path: &std::path::Path,
    preferred_name: Option<&str>,
    target_instance_id: Option<&str>,
    record_seed: Option<crate::packs::ModpackRecord>,
) -> Result<crate::packs::PackInstallResult, String> {
    use crate::packs::{self, PendingDownload};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    let api_key = resolve_api_key()?;
    let client = cf_client()?;

    let manifest: CfManifest = {
        let f = fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("Invalid modpack archive: {e}"))?;
        let mut entry = zip
            .by_name("manifest.json")
            .map_err(|_| "Archive does not contain manifest.json".to_string())?;
        let mut raw = String::new();
        std::io::Read::read_to_string(&mut entry, &mut raw).map_err(|e| e.to_string())?;
        serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|e| format!("Invalid manifest.json: {e}"))?
    };

    let (loader, loader_version) = parse_cf_loader(&manifest.minecraft);
    let name = preferred_name
        .filter(|n| !n.is_empty())
        .map(String::from)
        .unwrap_or_else(|| manifest.name.clone());
    if !name.is_empty() {
        progress.set_title(&name);
    }
    let inst = packs::prepare_instance(
        target_instance_id,
        &name,
        manifest.minecraft.version.clone(),
        loader,
        loader_version,
        record_seed.as_ref().and_then(|r| r.icon_url.clone()),
    )?;
    progress.set_instance(&inst.id);
    let game_dir = storage::instance_game_dir(&inst.id);

    progress.emit("prepare", 0, 0, "");
    let wanted: Vec<&CfManifestFile> = manifest.files.iter().filter(|f| f.required).collect();
    let file_ids: Vec<u64> = wanted.iter().map(|f| f.file_id).collect();
    let mut mod_ids: Vec<u64> = wanted.iter().map(|f| f.project_id).collect();
    mod_ids.sort_unstable();
    mod_ids.dedup();
    let files = if file_ids.is_empty() {
        Vec::new()
    } else {
        fetch_files_bulk(&client, &api_key, &file_ids).await?
    };
    let mods: HashMap<u64, CfModLite> = if mod_ids.is_empty() {
        HashMap::new()
    } else {
        fetch_mods_bulk(&client, &api_key, &mod_ids)
            .await?
            .into_iter()
            .map(|m| (m.id, m))
            .collect()
    };

    let mut downloads = Vec::new();
    let mut pending: Vec<PendingDownload> = Vec::new();
    for f in files {
        let m = mods.get(&f.mod_id);
        let dir = packs::target_dir_for_class(m.and_then(|m| m.class_id));
        match &f.download_url {
            Some(url) if !url.is_empty() => downloads.push((f.clone(), url.clone(), dir, m.cloned())),
            _ => pending.push(PendingDownload {
                project_id: f.mod_id.to_string(),
                file_id: f.id.to_string(),
                file_name: f.file_name.clone(),
                display_name: m.map(|m| m.name.clone()).unwrap_or_else(|| f.display_name.clone()),
                page_url: m
                    .map(|m| format!("{}/download/{}", m.website(), f.id))
                    .unwrap_or_else(|| format!("https://www.curseforge.com/projects/{}", f.mod_id)),
                target_dir: dir.to_string(),
                sha1: f.sha1(),
                size: f.file_length,
            }),
        }
    }

    let total = downloads.len() as u64;
    let done = Arc::new(AtomicU64::new(0));
    let max_dl = storage::load_settings().max_concurrent_downloads.clamp(2, 32) as usize;
    let sem = Arc::new(tokio::sync::Semaphore::new(max_dl));
    progress.emit("files", 0, total, "");
    let mut handles = Vec::new();
    for (f, url, dir, m) in downloads {
        let client = client.clone();
        let sem = sem.clone();
        let done = done.clone();
        let progress = progress.clone();
        let dest = game_dir.join(dir).join(&f.file_name);
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.map_err(|e| e.to_string())?;
            packs::download_verified(&client, &url, &dest, f.sha1().as_deref(), f.file_length).await?;
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            progress.emit("files", n, total, &f.file_name);
            let meta = crate::models::ContentMetaEntry {
                display_name: m.as_ref().map(|m| m.name.clone()).unwrap_or_else(|| f.display_name.clone()),
                version: Some(f.display_name.clone()),
                icon_url: m.as_ref().and_then(|m| m.icon()),
                website_url: m.as_ref().map(|m| m.website()),
                source: Some("curseforge".into()),
                project_id: Some(f.mod_id.to_string()),
            };
            Ok::<_, String>((format!("{dir}/{}", f.file_name), f.file_name.clone(), meta))
        }));
    }
    let mut record_files = Vec::new();
    let mut metas = Vec::new();
    let mut errors = Vec::new();
    for h in handles {
        match h.await.map_err(|e| e.to_string())? {
            Ok((rel, fname, meta)) => {
                record_files.push(rel);
                metas.push((fname, meta));
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
    packs::save_meta_bulk(&inst.id, metas);

    let overrides = manifest.overrides.clone().unwrap_or_else(|| "overrides".to_string());
    record_files.extend(packs::extract_overrides(archive_path, &[overrides], &game_dir, &progress)?);

    if let Some(mut rec) = record_seed {
        rec.files = record_files;
        packs::save_record(&inst.id, &rec)?;
    }
    packs::save_pending(&inst.id, &pending)?;
    let pending = packs::resolve_pending(&inst.id, &[])?;

    progress.emit("done", 1, 1, "");
    Ok(packs::PackInstallResult { instance: inst, pending })
}
