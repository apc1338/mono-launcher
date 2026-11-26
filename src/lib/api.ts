import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AccountsStore,
  CatalogSearchResponse,
  CatalogSource,
  CatalogVersion,
  ContentUpdate,
  DetectedJava,
  GameLogEvent,
  HorizonBuildStatus,
  InstalledContent,
  InstallResult,
  Instance,
  InstanceStatusEvent,
  LauncherSettings,
  LaunchProgressEvent,
  LoaderType,
  McVersionInfo,
  ModpackRecord,
  MsaDeviceCode,
  PackInstallResult,
  PackProgressEvent,
  PendingDownload,
  ScreenshotInfo,
  SystemInfo,
  WorldInfo,
} from "../types";

export const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mockInstances: Instance[] = [
  {
    id: "preview-1",
    name: "Fabric 1.21.4",
    mcVersion: "1.21.4",
    loader: "fabric",
    loaderVersion: "0.16.10",
    ramMb: 4096,
    jvmArgs: "-XX:+UseG1GC",
    javaPath: null,
    windowWidth: 1280,
    windowHeight: 720,
    fullscreen: false,
    createdAt: "2026-11-20T10:00:00Z",
    lastPlayed: "2026-11-22T21:15:00Z",
    playTimeSec: 51420,
    favorite: false,
  },
  {
    id: "preview-2",
    name: "Create NeoForge",
    mcVersion: "1.21.1",
    loader: "neoforge",
    loaderVersion: "21.1.92",
    ramMb: 6144,
    jvmArgs: "",
    javaPath: null,
    windowWidth: 1920,
    windowHeight: 1080,
    fullscreen: false,
    createdAt: "2026-11-18T14:00:00Z",
    lastPlayed: "2026-11-21T18:40:00Z",
    playTimeSec: 18900,
    favorite: false,
  },
  {
    id: "preview-3",
    name: "Vanilla 1.21.4",
    mcVersion: "1.21.4",
    loader: "vanilla",
    loaderVersion: null,
    ramMb: 2048,
    jvmArgs: "",
    javaPath: null,
    windowWidth: 1280,
    windowHeight: 720,
    fullscreen: false,
    createdAt: "2026-11-10T09:00:00Z",
    lastPlayed: null,
    playTimeSec: 0,
    favorite: false,
  },
];

const mockMods: InstalledContent[] = [
  {
    filename: "sodium-fabric-0.6.5+mc1.21.4.jar",
    displayName: "Sodium",
    version: "0.6.5+mc1.21.4",
    iconUrl: "https://cdn.modrinth.com/data/AANobbMI/295862f4724dc3f78df3447ad6072b2dcd3ef0c9_96.webp",
    websiteUrl: "https://modrinth.com/mod/sodium",
    source: "modrinth",
    projectId: "AANobbMI",
    enabled: true,
    sizeBytes: 1248920,
    kind: "mod",
  },
  {
    filename: "iris-fabric-1.8.5+mc1.21.4.jar",
    displayName: "Iris Shaders",
    version: "1.8.5+mc1.21.4",
    iconUrl: "https://cdn.modrinth.com/data/YL57xq9U/dc558eece920db435f9823ce86de0c4cde89800b_96.webp",
    websiteUrl: "https://modrinth.com/mod/iris",
    source: "modrinth",
    projectId: "YL57xq9U",
    enabled: true,
    sizeBytes: 2891020,
    kind: "mod",
  },
  {
    filename: "lithium-fabric-0.14.7+mc1.21.4.jar",
    displayName: "Lithium",
    version: "0.14.7+mc1.21.4",
    iconUrl: "https://cdn.modrinth.com/data/gvQqBUqZ/icon.png",
    websiteUrl: "https://modrinth.com/mod/lithium",
    source: "modrinth",
    projectId: "gvQqBUqZ",
    enabled: true,
    sizeBytes: 682400,
    kind: "mod",
  },
  {
    filename: "ferritecore-7.1.1-fabric.jar",
    displayName: "FerriteCore",
    version: "7.1.1",
    iconUrl: "https://cdn.modrinth.com/data/uXXizFIs/5101342636380168672_96.webp",
    websiteUrl: "https://modrinth.com/mod/ferrite-core",
    source: "modrinth",
    projectId: "uXXizFIs",
    enabled: true,
    sizeBytes: 138210,
    kind: "mod",
  },
  {
    filename: "freecam-fabric-1.3.1.jar.disabled",
    displayName: "Freecam",
    version: "1.3.1",
    iconUrl: null,
    websiteUrl: "https://modrinth.com/mod/freecam",
    source: "modrinth",
    projectId: "XeEZ3fK2",
    enabled: false,
    sizeBytes: 312900,
    kind: "mod",
  },
];

export const api = {
  async openExternalUrl(url: string): Promise<void> {
    if (!url) return;
    if (isTauri()) {
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  },

  async getSettings(): Promise<LauncherSettings> {
    if (!isTauri()) {
      return {
        language: "ru",
        dataDir: "C:\\Users\\apcxdxd\\AppData\\Roaming\\Mono",
        defaultRamMb: 4096,
        closeOnLaunch: false,
        showSnapshots: false,
        openConsoleOnCrash: true,
        defaultWidth: 1280,
        defaultHeight: 720,
        defaultFullscreen: false,
        maxConcurrentDownloads: 8,
        java8Path: null,
        java17Path: null,
        java21Path: null,
        java25Path: "C:\\Program Files\\Eclipse Adoptium\\jdk-25\\bin\\java.exe",
        curseforgeApiKey: null,
        msaClientId: null,
      };
    }
    return invoke<LauncherSettings>("get_settings");
  },

  async updateSettings(settings: LauncherSettings): Promise<void> {
    if (!isTauri()) return;
    return invoke("update_settings", { settings });
  },

  async getSystemInfo(): Promise<SystemInfo> {
    if (!isTauri()) {
      return {
        totalRamMb: 16384,
        detectedJavas: [
          {
            major: 25,
            versionString: "25.0.5.1",
            path: "C:\\Program Files\\Eclipse Adoptium\\jdk-25\\bin\\java.exe",
            managed: false,
          },
        ],
      };
    }
    return invoke<SystemInfo>("get_system_info");
  },

  async pickJavaExecutable(title: string): Promise<string | null> {
    if (!isTauri()) return null;
    const selected = await open({
      multiple: false,
      directory: false,
      title,
      filters: [{ name: "Java", extensions: ["exe"] }],
    });
    return typeof selected === "string" ? selected : null;
  },

  async probeJava(path: string): Promise<DetectedJava> {
    if (!isTauri()) {
      return { major: 21, versionString: "21.0.0", path, managed: false };
    }
    return invoke<DetectedJava>("probe_java", { path });
  },

  async installJavaRuntime(major: number): Promise<string> {
    if (!isTauri()) return `C:\\Mono\\runtimes\\java-${major}\\bin\\java.exe`;
    return invoke<string>("install_java_runtime", { major });
  },

  async getAccounts(): Promise<AccountsStore> {
    if (!isTauri()) {
      return {
        activeId: "acc-1",
        accounts: [
          {
            id: "acc-1",
            username: "apcxdxd",
            uuid: "8f3c2d10-1a2b-3c4d-8e5f-9a0b1c2d3e4f",
            accountType: "elyby",
            accessToken: "mock",
            clientToken: "mock",
          },
        ],
      };
    }
    return invoke<AccountsStore>("get_accounts");
  },

  async addOfflineAccount(username: string): Promise<AccountsStore> {
    return invoke<AccountsStore>("add_offline_account", { username });
  },

  async addElybyAccount(username: string, password: string): Promise<AccountsStore> {
    return invoke<AccountsStore>("add_elyby_account", { username, password });
  },

  async startMicrosoftLogin(): Promise<MsaDeviceCode> {
    return invoke<MsaDeviceCode>("start_microsoft_login");
  },

  async completeMicrosoftLogin(params: {
    deviceCode: string;
    interval: number;
    expiresIn: number;
  }): Promise<AccountsStore> {
    return invoke<AccountsStore>("complete_microsoft_login", params);
  },

  async cancelMicrosoftLogin(): Promise<void> {
    if (!isTauri()) return;
    return invoke("cancel_microsoft_login");
  },

  async setActiveAccount(accountId: string): Promise<AccountsStore> {
    return invoke<AccountsStore>("set_active_account", { accountId });
  },

  async removeAccount(accountId: string): Promise<AccountsStore> {
    return invoke<AccountsStore>("remove_account", { accountId });
  },

  async listInstances(): Promise<Instance[]> {
    if (!isTauri()) return mockInstances;
    return invoke<Instance[]>("list_instances");
  },

  async createInstance(params: {
    name: string;
    mcVersion: string;
    loader: LoaderType;
    loaderVersion: string | null;
    ramMb?: number;
    customLoaderPath?: string | null;
    edition?: "java" | "rust";
  }): Promise<Instance> {
    return invoke<Instance>("create_instance", params);
  },

  async getHorizonStatus(): Promise<HorizonBuildStatus> {
    if (!isTauri()) return { found: false, tag: null, path: null, prepared: false };
    return invoke<HorizonBuildStatus>("get_horizon_status");
  },

  async importHorizonBuild(path: string): Promise<HorizonBuildStatus> {
    return invoke<HorizonBuildStatus>("import_horizon_build", { path });
  },

  async pickHorizonBuild(title: string, archive: boolean): Promise<string | null> {
    if (!isTauri()) return null;
    const picked = await open({
      title,
      directory: !archive,
      multiple: false,
      filters: archive ? [{ name: "Zip", extensions: ["zip"] }] : undefined,
    });
    return typeof picked === "string" ? picked : null;
  },

  async updateInstance(
    instance: Instance,
    customLoaderPath?: string | null
  ): Promise<Instance> {
    if (!isTauri()) return instance;
    return invoke<Instance>("update_instance", {
      instance,
      customLoaderPath: customLoaderPath ?? null,
    });
  },

  async pickLoaderProfile(title: string): Promise<string | null> {
    if (!isTauri()) return null;
    const selected = await open({
      multiple: false,
      directory: false,
      title,
      filters: [{ name: "Loader profile (JSON)", extensions: ["json"] }],
    });
    return typeof selected === "string" ? selected : null;
  },

  async inspectCustomLoader(path: string): Promise<string> {
    if (!isTauri()) return "custom";
    return invoke<string>("inspect_custom_loader", { path });
  },

  async deleteInstance(instanceId: string): Promise<void> {
    if (!isTauri()) return;
    return invoke("delete_instance", { instanceId });
  },

  async cloneInstance(instanceId: string, newName: string): Promise<Instance> {
    return invoke<Instance>("clone_instance", { instanceId, newName });
  },

  async reorderInstances(orderedIds: string[]): Promise<void> {
    if (!isTauri()) return;
    return invoke("reorder_instances", { orderedIds });
  },

  async openInstanceFolder(instanceId: string): Promise<void> {
    if (!isTauri()) return;
    return invoke("open_instance_folder", { instanceId });
  },

  async openDataFolder(): Promise<void> {
    if (!isTauri()) return;
    return invoke("open_data_folder");
  },

  async clearCache(): Promise<void> {
    if (!isTauri()) return;
    return invoke("clear_cache");
  },

  async listContent(
    instanceId: string,
    kind: "mod" | "resourcepack" | "shaderpack"
  ): Promise<InstalledContent[]> {
    if (!isTauri()) return kind === "mod" ? mockMods : [];
    return invoke<InstalledContent[]>("list_content", { instanceId, kind });
  },

  async toggleContent(instanceId: string, kind: string, filename: string): Promise<string> {
    return invoke<string>("toggle_content", { instanceId, kind, filename });
  },

  async deleteContent(instanceId: string, kind: string, filename: string): Promise<void> {
    return invoke("delete_content", { instanceId, kind, filename });
  },

  async pickAndAddLocalContent(
    instanceId: string,
    kind: "mod" | "resourcepack" | "shaderpack",
    title: string
  ): Promise<number> {
    if (!isTauri()) return 0;
    const extensions = kind === "mod" ? ["jar"] : ["zip", "jar"];
    const selected = await open({
      multiple: true,
      directory: false,
      title,
      filters: [{ name: "Minecraft content", extensions }],
    });
    if (!selected) return 0;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return 0;
    return invoke<number>("add_local_content", { instanceId, kind, paths });
  },

  async addLocalContent(
    instanceId: string,
    kind: "mod" | "resourcepack" | "shaderpack",
    paths: string[]
  ): Promise<number> {
    if (!isTauri() || paths.length === 0) return 0;
    return invoke<number>("add_local_content", { instanceId, kind, paths });
  },

  async checkContentUpdates(
    instanceId: string,
    kind: "mod" | "resourcepack" | "shaderpack"
  ): Promise<ContentUpdate[]> {
    if (!isTauri()) return [];
    return invoke<ContentUpdate[]>("check_content_updates", { instanceId, kind });
  },

  async applyContentUpdate(params: {
    instanceId: string;
    kind: "mod" | "resourcepack" | "shaderpack";
    currentFilename: string;
    source: string;
    projectId: string;
    versionId: string;
  }): Promise<string> {
    return invoke<string>("apply_content_update", params);
  },

  async pickInstanceIcon(instanceId: string, title: string): Promise<Instance | null> {
    if (!isTauri()) return null;
    const selected = await open({
      multiple: false,
      directory: false,
      title,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "ico"] }],
    });
    if (!selected || typeof selected !== "string") return null;
    return invoke<Instance>("set_instance_icon", { instanceId, imagePath: selected });
  },

  async resetInstanceIcon(instanceId: string): Promise<Instance | null> {
    if (!isTauri()) return null;
    return invoke<Instance>("set_instance_icon", { instanceId, imagePath: null });
  },

  async listWorlds(instanceId: string): Promise<WorldInfo[]> {
    if (!isTauri()) return [];
    return invoke<WorldInfo[]>("list_worlds", { instanceId });
  },

  async openWorldFolder(instanceId: string, folderName: string): Promise<void> {
    if (!isTauri()) return;
    return invoke("open_world_folder", { instanceId, folderName });
  },

  async deleteWorld(instanceId: string, folderName: string): Promise<void> {
    if (!isTauri()) return;
    return invoke("delete_world", { instanceId, folderName });
  },

  async listScreenshots(instanceId: string): Promise<ScreenshotInfo[]> {
    if (!isTauri()) return [];
    return invoke<ScreenshotInfo[]>("list_screenshots", { instanceId });
  },

  async getScreenshotData(instanceId: string, filename: string): Promise<string> {
    return invoke<string>("get_screenshot_data", { instanceId, filename });
  },

  async openScreenshot(instanceId: string, filename: string): Promise<void> {
    if (!isTauri()) return;
    return invoke("open_screenshot", { instanceId, filename });
  },

  async openScreenshotsFolder(instanceId: string): Promise<void> {
    if (!isTauri()) return;
    return invoke("open_screenshots_folder", { instanceId });
  },

  async deleteScreenshot(instanceId: string, filename: string): Promise<void> {
    if (!isTauri()) return;
    return invoke("delete_screenshot", { instanceId, filename });
  },

  async onFileDrop(
    cb: (ev: { type: "enter" | "over" | "drop" | "leave"; paths: string[] }) => void
  ): Promise<UnlistenFn> {
    if (!isTauri()) return () => {};
    return getCurrentWindow().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "drop") {
        cb({ type: p.type, paths: p.paths });
      } else {
        cb({ type: p.type, paths: [] });
      }
    });
  },

  async fetchMcVersions(includeSnapshots: boolean): Promise<McVersionInfo[]> {
    if (!isTauri()) {
      return [
        { id: "1.21.4", versionType: "release", releaseTime: "2024-12-03" },
        { id: "1.21.1", versionType: "release", releaseTime: "2024-08-08" },
        { id: "1.20.4", versionType: "release", releaseTime: "2023-12-07" },
        { id: "1.20.1", versionType: "release", releaseTime: "2023-06-12" },
        { id: "1.19.4", versionType: "release", releaseTime: "2023-03-14" },
        { id: "1.16.5", versionType: "release", releaseTime: "2021-01-15" },
        { id: "1.12.2", versionType: "release", releaseTime: "2017-09-18" },
      ];
    }
    return invoke<McVersionInfo[]>("fetch_mc_versions", { includeSnapshots });
  },

  async fetchLoaderVersions(loader: LoaderType, mcVersion: string): Promise<string[]> {
    if (!isTauri()) return loader === "vanilla" ? [] : ["0.16.10", "0.16.9"];
    return invoke<string[]>("fetch_loader_versions", { loader, mcVersion });
  },

  async launchInstance(instanceId: string, quickPlayWorld?: string | null): Promise<void> {
    return invoke("launch_instance", {
      instanceId,
      quickPlayWorld: quickPlayWorld ?? null,
    });
  },

  async stopInstance(instanceId: string): Promise<void> {
    return invoke("stop_instance", { instanceId });
  },

  async searchCatalog(params: {
    source: CatalogSource;
    query: string;
    projectType: string;
    mcVersion?: string;
    loader?: string;
    sortIndex?: string;
    limit?: number;
    offset?: number;
  }): Promise<CatalogSearchResponse> {
    if (!isTauri()) {
      if (params.source === "curseforge") {
        return { hits: [], totalHits: 0 };
      }
      const facets: string[][] = [[`project_type:${params.projectType}`]];
      if (params.mcVersion) facets.push([`versions:${params.mcVersion}`]);
      if (params.projectType === "mod" && params.loader && params.loader !== "vanilla") {
        facets.push([`categories:${params.loader}`]);
      }
      const qs = new URLSearchParams({
        query: params.query,
        facets: JSON.stringify(facets),
        index: params.sortIndex ?? "relevance",
        limit: String(params.limit ?? 24),
        offset: String(params.offset ?? 0),
      });
      const r = await fetch(`https://api.modrinth.com/v2/search?${qs}`);
      const d = await r.json();
      return {
        totalHits: d.total_hits ?? 0,
        hits: (d.hits ?? []).map((h: Record<string, unknown>) => ({
          source: "modrinth" as const,
          projectId: String(h.project_id),
          slug: String(h.slug),
          title: String(h.title),
          description: String(h.description),
          author: String(h.author),
          downloads: Number(h.downloads),
          iconUrl: h.icon_url ? String(h.icon_url) : null,
          websiteUrl: `https://modrinth.com/${h.project_type}/${h.slug}`,
          projectType: String(h.project_type),
          categories: (h.categories as string[]) ?? [],
        })),
      };
    }
    return invoke<CatalogSearchResponse>("search_catalog", params);
  },

  async getCatalogVersions(params: {
    source: CatalogSource;
    projectId: string;
    projectType: string;
    mcVersion?: string;
    loader?: string;
  }): Promise<CatalogVersion[]> {
    if (!isTauri()) {
      if (params.source === "curseforge") return [];
      const r = await fetch(`https://api.modrinth.com/v2/project/${params.projectId}/version`);
      const list = (await r.json()) as Array<Record<string, unknown>>;
      return list.slice(0, 30).map((v) => {
        const gvs = (v.game_versions as string[]) ?? [];
        const lds = (v.loaders as string[]) ?? [];
        const files = (v.files as Array<Record<string, unknown>>) ?? [];
        const file = files.find((f) => f.primary) ?? files[0] ?? {};
        const compatible =
          (!params.mcVersion || gvs.includes(params.mcVersion)) &&
          (params.projectType !== "mod" ||
            !params.loader ||
            params.loader === "vanilla" ||
            lds.includes(params.loader));
        return {
          id: String(v.id),
          name: String(v.name),
          versionNumber: String(v.version_number),
          versionType: String(v.version_type) as "release" | "beta" | "alpha",
          datePublished: String(v.date_published),
          gameVersions: gvs,
          loaders: lds,
          compatible,
          filename: String(file.filename ?? ""),
          downloadUrl: String(file.url ?? ""),
          fileSize: Number(file.size ?? 0),
          dependencies: ((v.dependencies as Array<Record<string, unknown>>) ?? [])
            .filter((d) => d.project_id)
            .map((d) => ({
              projectId: String(d.project_id),
              dependencyType: String(d.dependency_type),
            })),
        };
      });
    }
    return invoke<CatalogVersion[]>("get_catalog_versions", params);
  },

  async installCatalogProject(params: {
    source: CatalogSource;
    instanceId: string;
    projectId: string;
    versionId?: string | null;
    projectType: string;
    mcVersion: string;
    loader?: string;
    installDeps?: boolean;
  }): Promise<InstallResult> {
    return invoke<InstallResult>("install_catalog_project", params);
  },

  async installCatalogModpack(params: {
    source: CatalogSource;
    projectId: string;
    versionId?: string | null;
    targetInstanceId?: string | null;
    taskId?: string | null;
    title?: string | null;
  }): Promise<PackInstallResult> {
    return invoke<PackInstallResult>("install_catalog_modpack", {
      source: params.source,
      projectId: params.projectId,
      versionId: params.versionId ?? null,
      targetInstanceId: params.targetInstanceId ?? null,
      taskId: params.taskId ?? null,
      title: params.title ?? null,
    });
  },

  async importMrpackDialog(taskId?: string): Promise<PackInstallResult | null> {
    if (!isTauri()) return null;
    const selected = await open({
      multiple: false,
      filters: [{ name: "Modpack (.mrpack, .zip)", extensions: ["mrpack", "zip"] }],
    });
    if (!selected || typeof selected !== "string") return null;
    return invoke<PackInstallResult>("import_mrpack", {
      filePath: selected,
      taskId: taskId ?? null,
    });
  },

  async getModpackRecord(instanceId: string): Promise<ModpackRecord | null> {
    if (!isTauri()) return null;
    return invoke<ModpackRecord | null>("get_modpack_record", { instanceId });
  },

  async getPendingDownloads(instanceId: string): Promise<PendingDownload[]> {
    if (!isTauri()) return [];
    return invoke<PendingDownload[]>("get_pending_downloads", { instanceId });
  },

  async resolvePendingDownloads(
    instanceId: string,
    extraPaths?: string[]
  ): Promise<PendingDownload[]> {
    if (!isTauri()) return [];
    return invoke<PendingDownload[]>("resolve_pending_downloads", {
      instanceId,
      extraPaths: extraPaths ?? null,
    });
  },

  async pickPendingFiles(title: string): Promise<string[]> {
    if (!isTauri()) return [];
    const selected = await open({
      multiple: true,
      directory: false,
      title,
      filters: [{ name: "Minecraft content (.jar, .zip)", extensions: ["jar", "zip"] }],
    });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  },

  async dismissPendingDownloads(instanceId: string): Promise<void> {
    if (!isTauri()) return;
    return invoke("dismiss_pending_downloads", { instanceId });
  },

  async onPackProgress(cb: (e: PackProgressEvent) => void): Promise<UnlistenFn> {
    if (!isTauri()) return () => {};
    return listen<PackProgressEvent>("pack-progress", (ev) => cb(ev.payload));
  },

  async exportMrpackDialog(instanceId: string, defaultName: string): Promise<boolean> {
    if (!isTauri()) return false;
    const dest = await save({
      defaultPath: `${defaultName.replace(/[^a-zA-Z0-9_-]/g, "_")}.mrpack`,
      filters: [{ name: "Modrinth Pack", extensions: ["mrpack"] }],
    });
    if (!dest) return false;
    await invoke("export_mrpack", { instanceId, destPath: dest });
    return true;
  },

  async onLaunchProgress(cb: (e: LaunchProgressEvent) => void): Promise<UnlistenFn> {
    if (!isTauri()) return () => {};
    return listen<LaunchProgressEvent>("launch-progress", (ev) => cb(ev.payload));
  },

  async onGameLog(cb: (e: GameLogEvent) => void): Promise<UnlistenFn> {
    if (!isTauri()) return () => {};
    return listen<GameLogEvent>("game-log", (ev) => cb(ev.payload));
  },

  async onInstanceStatus(cb: (e: InstanceStatusEvent) => void): Promise<UnlistenFn> {
    if (!isTauri()) return () => {};
    return listen<InstanceStatusEvent>("instance-status", (ev) => cb(ev.payload));
  },

  window: {
    minimize: () => isTauri() && getCurrentWindow().minimize(),
    toggleMaximize: () => isTauri() && getCurrentWindow().toggleMaximize(),
    close: () => isTauri() && getCurrentWindow().close(),
    hide: () => isTauri() && getCurrentWindow().hide(),
    async restore() {
      if (!isTauri()) return;
      const win = getCurrentWindow();
      await win.show();
      await win.unminimize();
      await win.setFocus();
    },
  },
};
