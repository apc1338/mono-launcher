mod auth;
mod curseforge;
mod extras;
mod java;
mod minecraft;
mod models;
mod modrinth;
mod packs;
mod storage;

use chrono::Utc;
use minecraft::RunningMap;
use models::{
    AccountsStore, CatalogSearchResponse, CatalogVersion, ContentUpdate, InstallResult,
    InstalledContent, Instance, LauncherSettings, LoaderType, McVersionInfo, MsaDeviceCode,
    ScreenshotInfo, SystemInfo, WorldInfo,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use sysinfo::System;
use tauri::{AppHandle, State};
use uuid::Uuid;

struct AppState {
    running: RunningMap,
    msa_cancel: Arc<AtomicBool>,
}

#[tauri::command]
fn get_settings() -> LauncherSettings {
    storage::load_settings()
}

#[tauri::command]
fn update_settings(settings: LauncherSettings) -> Result<(), String> {
    storage::save_settings(&settings)
}

#[tauri::command]
async fn get_system_info() -> SystemInfo {
    // Blocking work (spawning java processes) must not run on the UI thread.
    tauri::async_runtime::spawn_blocking(|| {
        let mut sys = System::new();
        sys.refresh_memory();
        let total_ram_mb = sys.total_memory() / (1024 * 1024);
        let detected_javas = java::detect_javas();
        SystemInfo {
            total_ram_mb,
            detected_javas,
        }
    })
    .await
    .unwrap_or(SystemInfo {
        total_ram_mb: 0,
        detected_javas: Vec::new(),
    })
}

#[tauri::command]
async fn probe_java(path: String) -> Result<models::DetectedJava, String> {
    tauri::async_runtime::spawn_blocking(move || java::probe_java_path(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn install_java_runtime(app: AppHandle, major: u32) -> Result<String, String> {
    java::download_java_runtime(&app, major, None).await
}

#[tauri::command]
fn get_accounts() -> AccountsStore {
    storage::load_accounts()
}

#[tauri::command]
fn add_offline_account(username: String) -> Result<AccountsStore, String> {
    let acc = auth::create_offline_account(username)?;
    let mut store = storage::load_accounts();
    let id = acc.id.clone();
    store.accounts.push(acc);
    store.active_id = Some(id);
    storage::save_accounts(&store)?;
    Ok(store)
}

#[tauri::command]
async fn add_elyby_account(username: String, password: String) -> Result<AccountsStore, String> {
    let acc = auth::authenticate_elyby(username, password).await?;
    let mut store = storage::load_accounts();
    let id = acc.id.clone();
    store.accounts.push(acc);
    store.active_id = Some(id);
    storage::save_accounts(&store)?;
    Ok(store)
}

#[tauri::command]
async fn start_microsoft_login(state: State<'_, AppState>) -> Result<MsaDeviceCode, String> {
    state.msa_cancel.store(false, Ordering::Relaxed);
    auth::start_msa_device_flow().await
}

#[tauri::command]
async fn complete_microsoft_login(
    state: State<'_, AppState>,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<AccountsStore, String> {
    state.msa_cancel.store(false, Ordering::Relaxed);
    let acc = auth::complete_msa_device_flow(
        &device_code,
        interval,
        expires_in,
        state.msa_cancel.clone(),
    )
    .await?;

    let mut store = storage::load_accounts();
    let active_id = if let Some(existing) = store.accounts.iter_mut().find(|a| {
        a.account_type == models::AccountType::Microsoft && a.uuid.eq_ignore_ascii_case(&acc.uuid)
    }) {
        let keep_id = existing.id.clone();
        *existing = acc;
        existing.id = keep_id.clone();
        keep_id
    } else {
        let id = acc.id.clone();
        store.accounts.push(acc);
        id
    };
    store.active_id = Some(active_id);
    storage::save_accounts(&store)?;
    Ok(store)
}

#[tauri::command]
fn cancel_microsoft_login(state: State<'_, AppState>) {
    state.msa_cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn set_active_account(account_id: String) -> Result<AccountsStore, String> {
    let mut store = storage::load_accounts();
    if !store.accounts.iter().any(|a| a.id == account_id) {
        return Err("Account not found".into());
    }
    store.active_id = Some(account_id);
    storage::save_accounts(&store)?;
    Ok(store)
}

#[tauri::command]
fn remove_account(account_id: String) -> Result<AccountsStore, String> {
    let mut store = storage::load_accounts();
    store.accounts.retain(|a| a.id != account_id);
    if store.active_id.as_deref() == Some(&account_id) {
        store.active_id = store.accounts.first().map(|a| a.id.clone());
    }
    storage::save_accounts(&store)?;
    Ok(store)
}

#[tauri::command]
fn list_instances() -> Vec<Instance> {
    storage::load_instances()
}

#[tauri::command]
fn create_instance(
    name: String,
    mc_version: String,
    loader: LoaderType,
    loader_version: Option<String>,
    ram_mb: Option<u32>,
    custom_loader_path: Option<String>,
) -> Result<Instance, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Instance name cannot be empty".into());
    }
    let settings = storage::load_settings();
    let mut loader_version = loader_version;
    let id = Uuid::new_v4().to_string();
    if loader == LoaderType::Custom {
        let src = custom_loader_path
            .as_deref()
            .ok_or_else(|| "Choose a loader JSON file".to_string())?;
        let label = storage::install_custom_loader(&id, src)?;
        loader_version = Some(label);
    }
    let inst = Instance {
        id,
        name: trimmed,
        mc_version,
        loader,
        loader_version,
        ram_mb: ram_mb.unwrap_or(settings.default_ram_mb),
        jvm_args: String::new(),
        java_path: None,
        window_width: settings.default_width,
        window_height: settings.default_height,
        fullscreen: settings.default_fullscreen,
        created_at: Utc::now().to_rfc3339(),
        last_played: None,
        play_time_sec: 0,
        favorite: false,
        sort_order: None,
        icon_url: None,
    };
    storage::save_instance(&inst)?;
    Ok(inst)
}

#[tauri::command]
fn update_instance(
    mut instance: Instance,
    custom_loader_path: Option<String>,
) -> Result<Instance, String> {
    if instance.loader == LoaderType::Custom {
        if let Some(src) = custom_loader_path.as_deref() {
            let label = storage::install_custom_loader(&instance.id, src)?;
            instance.loader_version = Some(label);
        } else if !storage::instance_dir(&instance.id)
            .join("custom_loader.json")
            .exists()
        {
            return Err("Choose a loader JSON file".to_string());
        }
    }
    storage::save_instance(&instance)?;
    Ok(instance)
}

#[tauri::command]
fn inspect_custom_loader(path: String) -> Result<String, String> {
    storage::read_custom_loader_label(&path)
}

#[tauri::command]
fn delete_instance(instance_id: String) -> Result<(), String> {
    storage::delete_instance_dir(&instance_id)
}

#[tauri::command]
fn clone_instance(instance_id: String, new_name: String) -> Result<Instance, String> {
    storage::clone_instance(&instance_id, new_name)
}

#[tauri::command]
fn reorder_instances(ordered_ids: Vec<String>) -> Result<(), String> {
    storage::reorder_instances(&ordered_ids)
}

#[tauri::command]
fn open_data_folder() -> Result<(), String> {
    let dir = storage::data_root();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn clear_cache() -> Result<(), String> {
    storage::clear_meta_cache()
}

#[tauri::command]
fn open_instance_folder(instance_id: String) -> Result<(), String> {
    let dir = storage::instance_game_dir(&instance_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_content(instance_id: String, kind: String) -> Vec<InstalledContent> {
    storage::list_instance_content(&instance_id, &kind)
}

#[tauri::command]
fn toggle_content(instance_id: String, kind: String, filename: String) -> Result<String, String> {
    storage::toggle_instance_content(&instance_id, &kind, &filename)
}

#[tauri::command]
fn delete_content(instance_id: String, kind: String, filename: String) -> Result<(), String> {
    storage::delete_instance_content(&instance_id, &kind, &filename)
}

#[tauri::command]
async fn fetch_mc_versions(include_snapshots: bool) -> Result<Vec<McVersionInfo>, String> {
    minecraft::fetch_mc_versions(include_snapshots).await
}

#[tauri::command]
async fn fetch_loader_versions(
    loader: LoaderType,
    mc_version: String,
) -> Result<Vec<String>, String> {
    minecraft::fetch_loader_versions(loader, &mc_version).await
}

#[tauri::command]
async fn launch_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    quick_play_world: Option<String>,
) -> Result<(), String> {
    minecraft::launch_instance(app, state.running.clone(), instance_id, quick_play_world).await
}

#[tauri::command]
fn stop_instance(state: State<'_, AppState>, instance_id: String) -> Result<(), String> {
    minecraft::stop_instance(&state.running, &instance_id)
}

#[tauri::command]
async fn search_catalog(
    source: String,
    query: String,
    project_type: String,
    mc_version: Option<String>,
    loader: Option<String>,
    sort_index: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<CatalogSearchResponse, String> {
    if source == "curseforge" {
        curseforge::search_projects(
            query,
            project_type,
            mc_version,
            loader,
            sort_index,
            limit.unwrap_or(24),
            offset.unwrap_or(0),
        )
        .await
    } else {
        modrinth::search_projects(
            query,
            project_type,
            mc_version,
            loader,
            sort_index,
            limit.unwrap_or(24),
            offset.unwrap_or(0),
        )
        .await
    }
}

#[tauri::command]
async fn get_catalog_versions(
    source: String,
    project_id: String,
    project_type: String,
    mc_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<CatalogVersion>, String> {
    if source == "curseforge" {
        curseforge::get_project_versions(
            &project_id,
            &project_type,
            mc_version.as_deref(),
            loader.as_deref(),
        )
        .await
    } else {
        modrinth::get_project_versions(
            &project_id,
            &project_type,
            mc_version.as_deref(),
            loader.as_deref(),
        )
        .await
    }
}

#[tauri::command]
async fn install_catalog_project(
    source: String,
    instance_id: String,
    project_id: String,
    version_id: Option<String>,
    project_type: String,
    mc_version: String,
    loader: Option<String>,
    install_deps: Option<bool>,
) -> Result<InstallResult, String> {
    let deps = install_deps.unwrap_or(true);
    if source == "curseforge" {
        curseforge::install_project_version(
            &instance_id,
            &project_id,
            version_id.as_deref(),
            &project_type,
            &mc_version,
            loader.as_deref(),
            deps,
        )
        .await
    } else {
        modrinth::install_project_version(
            &instance_id,
            &project_id,
            version_id.as_deref(),
            &project_type,
            &mc_version,
            loader.as_deref(),
            deps,
        )
        .await
    }
}

#[tauri::command]
async fn install_catalog_modpack(
    app: AppHandle,
    source: String,
    project_id: String,
    version_id: Option<String>,
    target_instance_id: Option<String>,
    task_id: Option<String>,
    title: Option<String>,
) -> Result<packs::PackInstallResult, String> {
    let tid = task_id.or_else(|| Some(Uuid::new_v4().to_string()));
    let progress = Arc::new(packs::Progress::new(
        Some(app),
        tid,
        title.as_deref().unwrap_or("Modpack"),
    ));
    let res = if source == "curseforge" {
        curseforge::install_modpack(
            progress.clone(),
            &project_id,
            version_id.as_deref(),
            target_instance_id.as_deref(),
        )
        .await
    } else {
        modrinth::install_modpack(
            progress.clone(),
            &project_id,
            version_id.as_deref(),
            target_instance_id.as_deref(),
        )
        .await
    };
    if let Err(ref e) = res {
        progress.fail(e);
    }
    res
}

#[tauri::command]
async fn import_mrpack(
    app: AppHandle,
    file_path: String,
    task_id: Option<String>,
) -> Result<packs::PackInstallResult, String> {
    let tid = task_id.or_else(|| Some(Uuid::new_v4().to_string()));
    let title = std::path::Path::new(&file_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Modpack".to_string());
    let progress = Arc::new(packs::Progress::new(Some(app), tid, &title));
    let res = modrinth::import_pack_file(progress.clone(), &file_path).await;
    if let Err(ref e) = res {
        progress.fail(e);
    }
    res
}

#[tauri::command]
fn get_modpack_record(instance_id: String) -> Option<packs::ModpackRecord> {
    packs::load_record(&instance_id)
}

#[tauri::command]
fn get_pending_downloads(instance_id: String) -> Vec<packs::PendingDownload> {
    packs::load_pending(&instance_id)
}

#[tauri::command]
fn resolve_pending_downloads(
    instance_id: String,
    extra_paths: Option<Vec<String>>,
) -> Result<Vec<packs::PendingDownload>, String> {
    packs::resolve_pending(&instance_id, &extra_paths.unwrap_or_default())
}

#[tauri::command]
fn dismiss_pending_downloads(instance_id: String) -> Result<(), String> {
    packs::save_pending(&instance_id, &[])
}

#[tauri::command]
async fn export_mrpack(instance_id: String, dest_path: String) -> Result<(), String> {
    modrinth::export_instance_mrpack(&instance_id, &dest_path).await
}

#[tauri::command]
fn set_instance_icon(instance_id: String, image_path: Option<String>) -> Result<Instance, String> {
    extras::set_instance_icon(&instance_id, image_path.as_deref())
}

#[tauri::command]
fn add_local_content(
    instance_id: String,
    kind: String,
    paths: Vec<String>,
) -> Result<u32, String> {
    extras::add_local_content(&instance_id, &kind, &paths)
}

#[tauri::command]
async fn check_content_updates(
    instance_id: String,
    kind: String,
) -> Result<Vec<ContentUpdate>, String> {
    extras::check_content_updates(&instance_id, &kind).await
}

#[tauri::command]
async fn apply_content_update(
    instance_id: String,
    kind: String,
    current_filename: String,
    source: String,
    project_id: String,
    version_id: String,
) -> Result<String, String> {
    extras::apply_content_update(
        &instance_id,
        &kind,
        &current_filename,
        &source,
        &project_id,
        &version_id,
    )
    .await
}

#[tauri::command]
fn list_worlds(instance_id: String) -> Vec<WorldInfo> {
    extras::list_worlds(&instance_id)
}

#[tauri::command]
fn open_world_folder(instance_id: String, folder_name: String) -> Result<(), String> {
    extras::open_world_folder(&instance_id, &folder_name)
}

#[tauri::command]
fn delete_world(instance_id: String, folder_name: String) -> Result<(), String> {
    extras::delete_world(&instance_id, &folder_name)
}

#[tauri::command]
fn list_screenshots(instance_id: String) -> Vec<ScreenshotInfo> {
    extras::list_screenshots(&instance_id)
}

#[tauri::command]
fn get_screenshot_data(instance_id: String, filename: String) -> Result<String, String> {
    extras::get_screenshot_data(&instance_id, &filename)
}

#[tauri::command]
fn open_screenshot(instance_id: String, filename: String) -> Result<(), String> {
    extras::open_screenshot(&instance_id, &filename)
}

#[tauri::command]
fn open_screenshots_folder(instance_id: String) -> Result<(), String> {
    extras::open_screenshots_folder(&instance_id)
}

#[tauri::command]
fn delete_screenshot(instance_id: String, filename: String) -> Result<(), String> {
    extras::delete_screenshot(&instance_id, &filename)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            running: Arc::new(Mutex::new(HashMap::new())),
            msa_cancel: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            get_system_info,
            install_java_runtime,
            probe_java,
            inspect_custom_loader,
            get_accounts,
            add_offline_account,
            add_elyby_account,
            start_microsoft_login,
            complete_microsoft_login,
            cancel_microsoft_login,
            set_active_account,
            remove_account,
            list_instances,
            reorder_instances,
            create_instance,
            update_instance,
            delete_instance,
            clone_instance,
            open_instance_folder,
            open_data_folder,
            clear_cache,
            list_content,
            toggle_content,
            delete_content,
            fetch_mc_versions,
            fetch_loader_versions,
            launch_instance,
            stop_instance,
            search_catalog,
            get_catalog_versions,
            install_catalog_project,
            install_catalog_modpack,
            import_mrpack,
            get_modpack_record,
            get_pending_downloads,
            resolve_pending_downloads,
            dismiss_pending_downloads,
            export_mrpack,
            set_instance_icon,
            add_local_content,
            check_content_updates,
            apply_content_update,
            list_worlds,
            open_world_folder,
            delete_world,
            list_screenshots,
            get_screenshot_data,
            open_screenshot,
            open_screenshots_folder,
            delete_screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mono launcher");
}
