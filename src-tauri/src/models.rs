use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LoaderType {
    Vanilla,
    Fabric,
    Forge,
    Neoforge,
    Quilt,
    Custom,
}

fn default_width() -> u32 {
    1280
}
fn default_height() -> u32 {
    720
}
fn default_concurrent_downloads() -> u32 {
    8
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub mc_version: String,
    pub loader: LoaderType,
    pub loader_version: Option<String>,
    pub ram_mb: u32,
    pub jvm_args: String,
    pub java_path: Option<String>,
    #[serde(default = "default_width")]
    pub window_width: u32,
    #[serde(default = "default_height")]
    pub window_height: u32,
    #[serde(default)]
    pub fullscreen: bool,
    pub created_at: String,
    pub last_played: Option<String>,
    pub play_time_sec: u64,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub sort_order: Option<i64>,
    #[serde(default)]
    pub icon_url: Option<String>,
    /// "java" (default) or "rust" (Horizon, Minecraft Rust Edition).
    #[serde(default = "default_edition")]
    pub edition: String,
}

fn default_edition() -> String {
    "java".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccountType {
    Offline,
    Elyby,
    Microsoft,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub username: String,
    pub uuid: String,
    pub account_type: AccountType,
    pub access_token: Option<String>,
    pub client_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MsaDeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsStore {
    pub active_id: Option<String>,
    pub accounts: Vec<Account>,
}

impl Default for AccountsStore {
    fn default() -> Self {
        Self {
            active_id: None,
            accounts: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSettings {
    pub language: String,
    pub data_dir: String,
    pub default_ram_mb: u32,
    pub close_on_launch: bool,
    pub show_snapshots: bool,
    #[serde(default = "default_true")]
    pub open_console_on_crash: bool,
    #[serde(default = "default_width")]
    pub default_width: u32,
    #[serde(default = "default_height")]
    pub default_height: u32,
    #[serde(default)]
    pub default_fullscreen: bool,
    #[serde(default = "default_concurrent_downloads")]
    pub max_concurrent_downloads: u32,
    pub java_8_path: Option<String>,
    pub java_17_path: Option<String>,
    pub java_21_path: Option<String>,
    #[serde(default)]
    pub java_25_path: Option<String>,
    #[serde(default)]
    pub curseforge_api_key: Option<String>,
    #[serde(default)]
    pub msa_client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledContent {
    pub filename: String,
    pub display_name: String,
    pub version: Option<String>,
    pub icon_url: Option<String>,
    pub website_url: Option<String>,
    pub source: Option<String>, // "modrinth" | "curseforge" | "local"
    pub project_id: Option<String>,
    pub enabled: bool,
    pub size_bytes: u64,
    pub kind: String, // "mod" | "resourcepack" | "shaderpack"
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContentMetaEntry {
    pub display_name: String,
    pub version: Option<String>,
    pub icon_url: Option<String>,
    pub website_url: Option<String>,
    pub source: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McVersionInfo {
    pub id: String,
    pub version_type: String,
    pub release_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHit {
    pub source: String, // "modrinth" | "curseforge"
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub author: String,
    pub downloads: u64,
    pub icon_url: Option<String>,
    pub website_url: String,
    pub project_type: String,
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSearchResponse {
    pub hits: Vec<CatalogHit>,
    pub total_hits: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVersionDependency {
    pub project_id: String,
    pub dependency_type: String, // "required" | "optional" | "incompatible"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVersion {
    pub id: String,
    pub name: String,
    pub version_number: String,
    pub version_type: String, // "release" | "beta" | "alpha"
    pub date_published: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub compatible: bool,
    pub filename: String,
    pub download_url: String,
    pub file_size: u64,
    pub dependencies: Vec<CatalogVersionDependency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub filename: String,
    pub installed_dependencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResolveItem {
    pub source: String,
    pub project_id: String,
    pub project_type: String,
    pub title: String,
    pub icon_url: Option<String>,
    #[serde(default)]
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBatchFile {
    pub source: String,
    pub project_id: String,
    pub project_type: String,
    pub title: String,
    pub icon_url: Option<String>,
    pub version_id: String,
    pub version_number: String,
    pub filename: String,
    pub file_size: u64,
    pub is_dependency: bool,
    pub required_by: Option<String>,
    pub already_installed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub total_ram_mb: u64,
    pub detected_javas: Vec<DetectedJava>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedJava {
    pub major: u32,
    pub version_string: String,
    pub path: String,
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProgressEvent {
    pub instance_id: String,
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLogEvent {
    pub instance_id: String,
    pub level: String, // "info" | "warn" | "error"
    pub text: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceStatusEvent {
    pub instance_id: String,
    pub status: String, // "idle" | "launching" | "running" | "crashed"
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentUpdate {
    pub filename: String,
    pub source: String,
    pub project_id: String,
    pub current_version: Option<String>,
    pub latest_version_id: String,
    pub latest_version_number: String,
    pub latest_filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldInfo {
    pub folder_name: String,
    pub display_name: String,
    pub icon_data_url: Option<String>,
    pub last_played: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotInfo {
    pub filename: String,
    pub modified_at: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub release_name: String,
    pub notes: String,
    pub release_url: String,
    pub download_url: String,
    pub asset_name: String,
    pub asset_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateProgressEvent {
    pub stage: String,
    pub downloaded: u64,
    pub total: u64,
}
