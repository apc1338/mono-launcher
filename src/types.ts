export type LoaderType = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge" | "custom";
export type AccountType = "offline" | "elyby" | "microsoft";
export type InstanceRuntimeStatus = "idle" | "launching" | "running" | "crashed";
export type Language = "ru" | "en";

export interface Instance {
  id: string;
  name: string;
  mcVersion: string;
  loader: LoaderType;
  loaderVersion: string | null;
  ramMb: number;
  jvmArgs: string;
  javaPath: string | null;
  windowWidth: number;
  windowHeight: number;
  fullscreen: boolean;
  createdAt: string;
  lastPlayed: string | null;
  playTimeSec: number;
  favorite: boolean;
  sortOrder?: number | null;
  iconUrl?: string | null;
}

export interface Account {
  id: string;
  username: string;
  uuid: string;
  accountType: AccountType;
  accessToken: string | null;
  clientToken: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
}

export interface MsaDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface AccountsStore {
  activeId: string | null;
  accounts: Account[];
}

export interface LauncherSettings {
  language: Language;
  dataDir: string;
  defaultRamMb: number;
  closeOnLaunch: boolean;
  showSnapshots: boolean;
  openConsoleOnCrash: boolean;
  defaultWidth: number;
  defaultHeight: number;
  defaultFullscreen: boolean;
  maxConcurrentDownloads: number;
  java8Path: string | null;
  java17Path: string | null;
  java21Path: string | null;
  java25Path: string | null;
  curseforgeApiKey: string | null;
  msaClientId: string | null;
}

export interface InstalledContent {
  filename: string;
  displayName: string;
  version: string | null;
  iconUrl: string | null;
  websiteUrl: string | null;
  source: string | null;
  projectId: string | null;
  enabled: boolean;
  sizeBytes: number;
  kind: "mod" | "resourcepack" | "shaderpack";
}

export interface McVersionInfo {
  id: string;
  versionType: string;
  releaseTime: string;
}

export type CatalogSource = "modrinth" | "curseforge";

export interface CatalogHit {
  source: CatalogSource;
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  websiteUrl: string;
  projectType: string;
  categories: string[];
}

export interface CatalogSearchResponse {
  hits: CatalogHit[];
  totalHits: number;
}

export interface CatalogVersionDependency {
  projectId: string;
  dependencyType: string;
}

export interface CatalogVersion {
  id: string;
  name: string;
  versionNumber: string;
  versionType: "release" | "beta" | "alpha";
  datePublished: string;
  gameVersions: string[];
  loaders: string[];
  compatible: boolean;
  filename: string;
  downloadUrl: string;
  fileSize: number;
  dependencies: CatalogVersionDependency[];
}

export interface InstallResult {
  filename: string;
  installedDependencies: string[];
}

export interface DetectedJava {
  major: number;
  versionString: string;
  path: string;
  managed: boolean;
}

export interface SystemInfo {
  totalRamMb: number;
  detectedJavas: DetectedJava[];
}

export interface LaunchProgressEvent {
  instanceId: string;
  stage: string;
  current: number;
  total: number;
  message: string;
}

export interface GameLogEvent {
  instanceId: string;
  level: "info" | "warn" | "error";
  text: string;
  timestamp: string;
}

export interface InstanceStatusEvent {
  instanceId: string;
  status: InstanceRuntimeStatus;
  exitCode: number | null;
}

export interface PackProgressEvent {
  taskId: string;
  title: string;
  stage: "prepare" | "download-pack" | "files" | "overrides" | "done" | "error" | string;
  current: number;
  total: number;
  message: string;
  instanceId: string | null;
}

export interface ModpackRecord {
  source: CatalogSource;
  projectId: string;
  versionId: string;
  versionName: string;
  iconUrl: string | null;
  websiteUrl: string | null;
  files: string[];
}

export interface PendingDownload {
  projectId: string;
  fileId: string;
  fileName: string;
  displayName: string;
  pageUrl: string;
  targetDir: "mods" | "resourcepacks" | "shaderpacks" | string;
  sha1: string | null;
  size: number;
}

export interface PackInstallResult {
  instance: Instance;
  pending: PendingDownload[];
}

export interface ContentUpdate {
  filename: string;
  source: CatalogSource;
  projectId: string;
  currentVersion: string | null;
  latestVersionId: string;
  latestVersionNumber: string;
  latestFilename: string;
}

export interface WorldInfo {
  folderName: string;
  displayName: string;
  iconDataUrl: string | null;
  lastPlayed: string | null;
  sizeBytes: number;
}

export interface ScreenshotInfo {
  filename: string;
  modifiedAt: string | null;
  sizeBytes: number;
}
