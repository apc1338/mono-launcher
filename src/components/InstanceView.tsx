import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpCircle,
  Copy,
  CopyPlus,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Package,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Share,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Dict } from "../i18n";
import { api } from "../lib/api";
import { ScreenshotsTab, WorldsTab } from "./InstanceExtraTabs";
import { LoaderFields, loaderLabel as fmtLoader } from "./LoaderFields";
import { Checkbox, Select } from "./Select";
import type {
  CatalogSource,
  CatalogVersion,
  ContentUpdate,
  GameLogEvent,
  HorizonBuildStatus,
  InstalledContent,
  Instance,
  InstanceRuntimeStatus,
  LaunchProgressEvent,
  ModpackRecord,
  PackInstallResult,
  PendingDownload,
} from "../types";

type TabId =
  | "mod"
  | "resourcepack"
  | "shaderpack"
  | "worlds"
  | "screenshots"
  | "console"
  | "settings";

const JVM_PRESET_G1GC =
  "-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC";
const JVM_PRESET_ZGC = "-XX:+UseZGC -XX:+ZGenerational";

interface InstanceViewProps {
  t: Dict;
  instance: Instance;
  initialTab?: "mod" | "console" | "settings";
  status: InstanceRuntimeStatus;
  progress: LaunchProgressEvent | null;
  logs: GameLogEvent[];
  totalRamMb: number;
  onLaunch: (quickPlayWorld?: string | null) => void;
  onStop: () => void;
  onClearLogs: () => void;
  onInstanceReplaced: (updated: Instance) => void;
  onUpdateInstance: (updated: Instance) => Promise<void>;
  onDeleteInstance: (id: string) => Promise<void>;
  onCloneInstance: (id: string, newName: string) => Promise<void>;
  onOpenModrinthFor: (kind: "mod" | "shader" | "resourcepack") => void;
  onExportPack: () => void;
  pendingRefreshKey: number;
  onOpenPending: (items: PendingDownload[]) => void;
  onModpackSwitched: (res: PackInstallResult) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ContentSort = "name-asc" | "name-desc" | "enabled" | "disabled" | "size-desc" | "size-asc";

/**
 * Strips noisy MC version & loader prefixes/suffixes from mod/pack version strings
 * e.g. "mc26.3-0.9.4-beta.1-fabric" -> "0.9.4-beta.1", "0.167.0+26.3" -> "0.167.0"
 */
function formatCleanVersion(raw: string | null): string {
  if (!raw) return "—";
  let v = raw.trim();
  if (!v) return "—";
  // Strip trailing file extensions if CurseForge used filename
  v = v.replace(/\.(jar|zip)(\.disabled)?$/i, "");
  // Strip leading loader or mc version prefixes like "mc1.21.4-", "mc26.3-", "fabric-"
  v = v.replace(/^(?:(?:mc)?\d+\.\d+(?:\.\d+)?|fabric|forge|neoforge|quilt)[-_+]+/i, "");
  // Strip trailing "+mc1.21.4", "+26.3-fabric", "-fabric", "-neoforge", etc. (repeat in case both exist)
  for (let i = 0; i < 3; i++) {
    const next = v.replace(
      /[-_+]+(?:(?:mc)?\d+\.\d+(?:\.\d+)?|fabric|forge|neoforge|quilt|universal|client|server)$/i,
      ""
    );
    if (next === v || !next) break;
    v = next;
  }
  // If CurseForge filename had mod name prefix like "sodium-0.6.5", extract from first version-like token
  if (/^[a-z][a-z0-9_.\s-]*[-_ ]v?\d+\.\d+/i.test(v) && !/^v?\d/i.test(v)) {
    const m = v.match(/v?(\d+\.\d+(?:\.\d+)*(?:[-+][a-z0-9.]+)?)/i);
    if (m?.[1]) v = m[1];
  }
  return v || raw;
}

function formatPlayTime(sec: number, t: Dict): string {
  if (sec < 60) return `0 ${t.minutesShort}`;
  const mins = Math.floor(sec / 60);
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs === 0) return `${rem} ${t.minutesShort}`;
  return `${hrs}${t.hoursShort} ${rem}${t.minutesShort}`;
}

export function InstanceView({
  t,
  instance,
  initialTab,
  status,
  progress,
  logs,
  totalRamMb,
  onLaunch,
  onStop,
  onClearLogs,
  onInstanceReplaced,
  onUpdateInstance,
  onDeleteInstance,
  onCloneInstance,
  onOpenModrinthFor,
  onExportPack,
  pendingRefreshKey,
  onOpenPending,
  onModpackSwitched,
}: InstanceViewProps) {
  const isRust = instance.edition === "rust";
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? "mod");
  const [content, setContent] = useState<InstalledContent[]>([]);
  const [filter, setFilter] = useState("");
  const [contentSort, setContentSort] = useState<ContentSort>("name-asc");
  const [logFilter, setLogFilter] = useState<"all" | "error" | "warn">("all");
  const [logSearch, setLogSearch] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  // Content item context menu state
  const [contentCtxMenu, setContentCtxMenu] = useState<{
    item: InstalledContent;
    x: number;
    y: number;
    confirmDelete: boolean;
  } | null>(null);
  const [contentMenuPos, setContentMenuPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
  const contentMenuRef = useRef<HTMLDivElement>(null);

  // Per-item version switcher modal state
  const [versionPickerItem, setVersionPickerItem] = useState<InstalledContent | null>(null);
  const [versionPickerList, setVersionPickerList] = useState<CatalogVersion[]>([]);
  const [versionPickerLoading, setVersionPickerLoading] = useState(false);
  const [versionPickerOnlyCompat, setVersionPickerOnlyCompat] = useState(true);
  const [versionPickerBusyId, setVersionPickerBusyId] = useState<string | null>(null);
  const [versionPickerErr, setVersionPickerErr] = useState<string | null>(null);

  // Settings form state
  const [name, setName] = useState(instance.name);
  const [ramMb, setRamMb] = useState(instance.ramMb);
  const [ramInput, setRamInput] = useState(String(instance.ramMb));
  const [windowWidth, setWindowWidth] = useState(instance.windowWidth || 1280);
  const [windowHeight, setWindowHeight] = useState(instance.windowHeight || 720);
  const [fullscreen, setFullscreen] = useState(Boolean(instance.fullscreen));
  const [jvmArgs, setJvmArgs] = useState(instance.jvmArgs);
  const [javaPath, setJavaPath] = useState(instance.javaPath ?? "");
  const [javaMajor, setJavaMajor] = useState<number | null>(instance.javaMajor ?? null);
  const [mcVersionDraft, setMcVersionDraft] = useState(instance.mcVersion);
  const [loaderDraft, setLoaderDraft] = useState<Instance["loader"]>(instance.loader);
  const [loaderVersionDraft, setLoaderVersionDraft] = useState(instance.loaderVersion ?? "");
  const [loaderError, setLoaderError] = useState<string | null>(null);
  const [savedFlag, setSavedFlag] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [horizonStatus, setHorizonStatus] = useState<HorizonBuildStatus | null>(null);
  const [importingBuild, setImportingBuild] = useState(false);
  const [horizonErr, setHorizonErr] = useState<string | null>(null);
  const [clientDownloading, setClientDownloading] = useState(false);
  const [clientDownloadPercent, setClientDownloadPercent] = useState(0);
  const autoDownloadUnlistenRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    if (!isRust) return;
    api.getHorizonStatus().then(setHorizonStatus).catch(() => {});
  }, [isRust, instance.id]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      autoDownloadUnlistenRef.current?.();
      autoDownloadUnlistenRef.current = null;
    };
  }, []);

  const handleAutoDownloadHorizonBuild = async () => {
    if (clientDownloading || importingBuild) return;
    setHorizonErr(null);
    setClientDownloading(true);
    setClientDownloadPercent(0);

    try {
      const unlisten = await api.onDownloadProgress(({ downloaded, total }) => {
        if (!isMountedRef.current) return;
        if (total > 0) {
          const pct = Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
          setClientDownloadPercent(pct);
        }
      });
      if (!isMountedRef.current) {
        unlisten();
        return;
      }
      autoDownloadUnlistenRef.current = unlisten;
      const st = await api.downloadLatestHorizonBuild();
      if (!isMountedRef.current) return;
      setClientDownloadPercent(100);
      setHorizonStatus(st);
    } catch (err) {
      if (isMountedRef.current) setHorizonErr(String(err));
    } finally {
      autoDownloadUnlistenRef.current?.();
      autoDownloadUnlistenRef.current = null;
      if (isMountedRef.current) setClientDownloading(false);
    }
  };

  const handlePickHorizonBuild = async (archive: boolean) => {
    setHorizonErr(null);
    const picked = await api.pickHorizonBuild(t.horizonBuildTitle, archive);
    if (!picked) return;
    setImportingBuild(true);
    try {
      const st = await api.importHorizonBuild(picked);
      setHorizonStatus(st);
    } catch (err) {
      setHorizonErr(String(err));
    } finally {
      setImportingBuild(false);
    }
  };

  // Modpack record + version switching + pending manual downloads
  const [modpackRecord, setModpackRecord] = useState<ModpackRecord | null>(null);
  const [packVersions, setPackVersions] = useState<CatalogVersion[]>([]);
  const [selectedPackVer, setSelectedPackVer] = useState("");
  const [switchingPack, setSwitchingPack] = useState(false);
  const [packSwitchErr, setPackSwitchErr] = useState<string | null>(null);
  const [pendingDownloads, setPendingDownloads] = useState<PendingDownload[]>([]);

  // Drag & drop + content updates state
  const [fileDragOver, setFileDragOver] = useState(false);
  const [updatesMap, setUpdatesMap] = useState<Record<string, ContentUpdate>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatesChecked, setUpdatesChecked] = useState(false);
  const [updatingFiles, setUpdatingFiles] = useState<Record<string, boolean>>({});

  const maxRamSlider = Math.max(4096, Math.min(32768, Math.floor(totalRamMb / 1024) * 1024));

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setName(instance.name);
    setRamMb(instance.ramMb);
    setRamInput(String(instance.ramMb));
    setWindowWidth(instance.windowWidth || 1280);
    setWindowHeight(instance.windowHeight || 720);
    setFullscreen(Boolean(instance.fullscreen));
    setJvmArgs(instance.jvmArgs);
    setJavaPath(instance.javaPath ?? "");
    setJavaMajor(instance.javaMajor ?? null);
    setMcVersionDraft(instance.mcVersion);
    setLoaderDraft(instance.loader);
    setLoaderVersionDraft(instance.loaderVersion ?? "");
    setLoaderError(null);
    setSavedFlag(false);
  }, [instance]);

  const loadContent = async (kind: "mod" | "resourcepack" | "shaderpack") => {
    const items = await api.listContent(instance.id, kind);
    setContent(items);
  };

  useEffect(() => {
    setUpdatesMap({});
    setUpdatesChecked(false);
    if (activeTab === "mod" || activeTab === "resourcepack" || activeTab === "shaderpack") {
      loadContent(activeTab);
    }
  }, [instance.id, activeTab, pendingRefreshKey]);

  // Native file drag-and-drop into Mods / Resourcepacks / Shaders tabs
  useEffect(() => {
    if (activeTab !== "mod" && activeTab !== "resourcepack" && activeTab !== "shaderpack") {
      setFileDragOver(false);
      return;
    }
    const tab = activeTab;
    let unlisten: (() => void) | undefined;
    api
      .onFileDrop(async (ev) => {
        if (ev.type === "enter" || ev.type === "over") {
          setFileDragOver(true);
        } else if (ev.type === "leave") {
          setFileDragOver(false);
        } else if (ev.type === "drop") {
          setFileDragOver(false);
          if (ev.paths.length > 0) {
            await api.addLocalContent(instance.id, tab, ev.paths);
            await loadContent(tab);
          }
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => {
      unlisten?.();
      setFileDragOver(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id, activeTab]);

  const handleCheckUpdates = async () => {
    if (activeTab !== "mod" && activeTab !== "resourcepack" && activeTab !== "shaderpack") return;
    setCheckingUpdates(true);
    try {
      const list = await api.checkContentUpdates(instance.id, activeTab);
      const next: Record<string, ContentUpdate> = {};
      for (const u of list) next[u.filename] = u;
      setUpdatesMap(next);
      setUpdatesChecked(true);
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleApplyOneUpdate = async (u: ContentUpdate) => {
    if (activeTab !== "mod" && activeTab !== "resourcepack" && activeTab !== "shaderpack") return;
    setUpdatingFiles((prev) => ({ ...prev, [u.filename]: true }));
    try {
      await api.applyContentUpdate({
        instanceId: instance.id,
        kind: activeTab,
        currentFilename: u.filename,
        source: u.source,
        projectId: u.projectId,
        versionId: u.latestVersionId,
      });
      setUpdatesMap((prev) => {
        const next = { ...prev };
        delete next[u.filename];
        return next;
      });
      await loadContent(activeTab);
    } finally {
      setUpdatingFiles((prev) => {
        const next = { ...prev };
        delete next[u.filename];
        return next;
      });
    }
  };

  const handleApplyAllUpdates = async () => {
    const list = Object.values(updatesMap);
    for (const u of list) {
      await handleApplyOneUpdate(u);
    }
  };

  useEffect(() => {
    let alive = true;
    api.getPendingDownloads(instance.id).then((list) => {
      if (alive) setPendingDownloads(list);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [instance.id, pendingRefreshKey]);

  useEffect(() => {
    let alive = true;
    setModpackRecord(null);
    setPackVersions([]);
    setPackSwitchErr(null);
    api
      .getModpackRecord(instance.id)
      .then(async (rec) => {
        if (!alive || !rec) return;
        setModpackRecord(rec);
        setSelectedPackVer(rec.versionId);
        try {
          const vers = await api.getCatalogVersions({
            source: rec.source,
            projectId: rec.projectId,
            projectType: "modpack",
          });
          if (alive) setPackVersions(vers);
        } catch {
          // offline or unavailable
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [instance.id, instance.mcVersion, instance.loaderVersion]);

  const handleSwitchPackVersion = async () => {
    if (!modpackRecord || !selectedPackVer || selectedPackVer === modpackRecord.versionId) return;
    setSwitchingPack(true);
    setPackSwitchErr(null);
    try {
      const res = await api.installCatalogModpack({
        source: modpackRecord.source,
        projectId: modpackRecord.projectId,
        versionId: selectedPackVer,
        targetInstanceId: instance.id,
        title: instance.name,
      });
      const rec = await api.getModpackRecord(instance.id);
      if (rec) setModpackRecord(rec);
      setPendingDownloads(res.pending);
      onModpackSwitched(res);
    } catch (e) {
      setPackSwitchErr(String(e));
    } finally {
      setSwitchingPack(false);
    }
  };

  useEffect(() => {
    if (activeTab === "console") {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs.length, activeTab]);

  useLayoutEffect(() => {
    if (!contentCtxMenu) return;
    const el = contentMenuRef.current;
    const w = el?.offsetWidth ?? 210;
    const h = el?.offsetHeight ?? 230;
    const left = Math.max(8, Math.min(contentCtxMenu.x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(contentCtxMenu.y, window.innerHeight - h - 8));
    setContentMenuPos({ left, top });
  }, [contentCtxMenu]);

  useEffect(() => {
    if (!contentCtxMenu) return;
    const onDown = (e: MouseEvent) => {
      if (contentMenuRef.current?.contains(e.target as Node)) return;
      setContentCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContentCtxMenu(null);
    };
    const close = () => setContentCtxMenu(null);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contentCtxMenu]);

  const openVersionPicker = async (item: InstalledContent) => {
    if (!item.source || !item.projectId) return;
    if (activeTab !== "mod" && activeTab !== "resourcepack" && activeTab !== "shaderpack") return;
    setVersionPickerItem(item);
    setVersionPickerList([]);
    setVersionPickerLoading(true);
    setVersionPickerErr(null);
    try {
      const projectType =
        activeTab === "shaderpack" ? "shader" : activeTab === "resourcepack" ? "resourcepack" : "mod";
      const list = await api.getCatalogVersions({
        source: item.source as CatalogSource,
        projectId: item.projectId,
        projectType,
        mcVersion: instance.mcVersion,
        loader:
          projectType === "mod" && instance.loader !== "vanilla" && instance.loader !== "custom"
            ? instance.loader
            : undefined,
      });
      setVersionPickerList(list);
    } catch (err) {
      setVersionPickerErr(String(err));
    } finally {
      setVersionPickerLoading(false);
    }
  };

  const handleSwitchContentVersion = async (ver: CatalogVersion) => {
    if (!versionPickerItem || !versionPickerItem.source || !versionPickerItem.projectId) return;
    if (activeTab !== "mod" && activeTab !== "resourcepack" && activeTab !== "shaderpack") return;
    setVersionPickerBusyId(ver.id);
    setVersionPickerErr(null);
    try {
      await api.applyContentUpdate({
        instanceId: instance.id,
        kind: activeTab,
        currentFilename: versionPickerItem.filename,
        source: versionPickerItem.source,
        projectId: versionPickerItem.projectId,
        versionId: ver.id,
      });
      setVersionPickerItem(null);
      await loadContent(activeTab);
    } catch (err) {
      setVersionPickerErr(String(err));
    } finally {
      setVersionPickerBusyId(null);
    }
  };

  const filteredContent = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? content.filter(
          (c) =>
            c.displayName.toLowerCase().includes(q) ||
            c.filename.toLowerCase().includes(q) ||
            (c.version?.toLowerCase().includes(q) ?? false)
        )
      : [...content];

    list.sort((a, b) => {
      switch (contentSort) {
        case "name-desc":
          return b.displayName.localeCompare(a.displayName);
        case "enabled":
          if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
          return a.displayName.localeCompare(b.displayName);
        case "disabled":
          if (a.enabled !== b.enabled) return a.enabled ? 1 : -1;
          return a.displayName.localeCompare(b.displayName);
        case "size-desc":
          return b.sizeBytes - a.sizeBytes;
        case "size-asc":
          return a.sizeBytes - b.sizeBytes;
        default:
          return a.displayName.localeCompare(b.displayName);
      }
    });
    return list;
  }, [content, filter, contentSort]);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return logs.filter((l) => {
      if (logFilter !== "all" && l.level !== logFilter) return false;
      if (q && !l.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, logFilter, logSearch]);

  const handleToggleItem = async (item: InstalledContent) => {
    if (activeTab !== "mod" && activeTab !== "resourcepack" && activeTab !== "shaderpack") return;
    await api.toggleContent(instance.id, activeTab, item.filename);
    await loadContent(activeTab);
  };

  const handleDeleteItem = async (item: InstalledContent) => {
    if (activeTab !== "mod" && activeTab !== "resourcepack" && activeTab !== "shaderpack") return;
    await api.deleteContent(instance.id, activeTab, item.filename);
    await loadContent(activeTab);
  };

  const commitRamInput = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      setRamInput(String(ramMb));
      return;
    }
    const clamped = Math.max(512, Math.min(totalRamMb, parsed));
    setRamMb(clamped);
    setRamInput(String(clamped));
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const clampedRam = Math.max(512, Math.min(totalRamMb, parseInt(ramInput, 10) || ramMb));
    setRamMb(clampedRam);
    setRamInput(String(clampedRam));
    setLoaderError(null);
    try {
      await onUpdateInstance({
        ...instance,
        name: name.trim() || instance.name,
        mcVersion: mcVersionDraft,
        loader: loaderDraft,
        loaderVersion: loaderDraft === "vanilla" ? null : loaderVersionDraft || null,
        ramMb: clampedRam,
        windowWidth: Math.max(640, windowWidth || 1280),
        windowHeight: Math.max(480, windowHeight || 720),
        fullscreen,
        jvmArgs: jvmArgs.trim(),
        javaPath: javaPath.trim() ? javaPath.trim() : null,
        javaMajor,
      });
    } catch (err) {
      setLoaderError(String(err));
      return;
    }
    setSavedFlag(true);
    setTimeout(() => setSavedFlag(false), 1800);
  };

  const handleClone = async () => {
    setCloning(true);
    try {
      await onCloneInstance(instance.id, `${instance.name} (Copy)`);
    } finally {
      setCloning(false);
    }
  };

  const loaderLabel = isRust
    ? "Rust"
    : instance.loader === "vanilla"
      ? "Vanilla"
      : `${fmtLoader(instance.loader, t)}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ""}`;

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;

  const allTabs: { id: TabId; label: string; count?: number; isErr?: boolean }[] = [
    { id: "mod", label: t.tabMods },
    { id: "resourcepack", label: t.tabResourcepacks },
    { id: "shaderpack", label: t.tabShaders },
    { id: "worlds", label: t.tabWorlds },
    { id: "screenshots", label: t.tabScreenshots },
    { id: "console", label: t.tabConsole },
    { id: "settings", label: t.tabSettings },
  ];
  const tabs = allTabs;

  const availableUpdatesCount = Object.keys(updatesMap).length;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#141415] mono-view-enter relative">
      {fileDragOver && (
        <div className="absolute inset-3 z-30 rounded-[14px] bg-[#141415]/90 border-2 border-dashed border-[#ededed]/40 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 pointer-events-none">
          <Upload size={26} strokeWidth={1.5} className="text-[#ededed]" />
          <span className="text-[14px] font-medium text-[#ededed]">{t.dropFilesHint}</span>
        </div>
      )}

      {/* Instance Header */}
      <div className="px-8 pt-6 pb-5 border-b border-[#ededed]/[0.08]">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-3.5">
            {instance.iconUrl ? (
              <img
                src={instance.iconUrl}
                alt=""
                className="w-10 h-10 rounded-[10px] bg-[#232325] object-cover shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-[10px] bg-[#1d1d20] border border-[#ededed]/[0.08] flex items-center justify-center shrink-0 font-mono text-[15px] text-[#85858b]">
                {instance.name.trim().charAt(0).toUpperCase() || "M"}
              </div>
            )}
            <h1 className="text-[28px] leading-8 font-medium tracking-[-0.02em] text-[#ededed] truncate">
              {instance.name}
            </h1>
            {status !== "idle" && (
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  status === "running"
                    ? "bg-[#4cc38a]"
                    : status === "crashed"
                      ? "bg-[#e5484d]"
                      : "bg-[#ededed]/70"
                }`}
              />
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => api.openInstanceFolder(instance.id)}
              title={t.openFolder}
              className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-2 text-[13px]"
            >
              <FolderOpen size={16} strokeWidth={1.5} className="text-[#a1a1a6]" />
              <span>{t.openFolder}</span>
            </button>

            <button
              type="button"
              onClick={onExportPack}
              title={t.exportPack}
              className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-2 text-[13px]"
            >
              <Share size={16} strokeWidth={1.5} className="text-[#a1a1a6]" />
              <span>{t.exportPack}</span>
            </button>

            {status === "running" ? (
              <button
                type="button"
                onClick={onStop}
                className="h-9 px-4 rounded-[8px] bg-[#e5484d]/15 text-[#e5484d] border border-[#e5484d]/30 hover:bg-[#e5484d]/25 transition-colors duration-150 flex items-center gap-2 text-[14px] font-medium"
              >
                <Square size={14} strokeWidth={1.5} fill="currentColor" />
                <span>{t.stop}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={status === "launching"}
                onClick={() => onLaunch(null)}
                className="mono-btn-primary h-9 px-4 rounded-[8px] flex items-center gap-2 text-[14px] font-medium disabled:opacity-60"
              >
                <Play size={14} strokeWidth={1.75} fill="currentColor" />
                <span>{status === "launching" ? t.launching : t.play}</span>
                {status !== "launching" && (
                  <kbd className="mono-keycap-dark ml-0.5">Ctrl+↵</kbd>
                )}
              </button>
            )}
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12px] text-[#85858b]">
          <span className="whitespace-nowrap">{instance.mcVersion}</span>
          <span className="text-[#ededed]/15">/</span>
          <span className="whitespace-nowrap">{loaderLabel}</span>
          {!isRust && (
            <>
              <span className="text-[#ededed]/15">/</span>
              <span className="whitespace-nowrap">{instance.ramMb} MB</span>
            </>
          )}
          <span className="text-[#ededed]/15">/</span>
          <span className="whitespace-nowrap">
            {t.playTime}: {formatPlayTime(instance.playTimeSec, t)}
          </span>
          {modpackRecord && (
            <>
              <span className="text-[#ededed]/15">/</span>
              <button
                type="button"
                onClick={() => setActiveTab("settings")}
                className="inline-flex items-center gap-1.5 text-[#a1a1a6] hover:text-[#ededed] transition-colors"
                title={t.modpackChangeVersion}
              >
                <Layers size={12} strokeWidth={1.5} />
                <span className="truncate max-w-[200px]">{modpackRecord.versionName}</span>
              </button>
            </>
          )}
        </div>

        {/* Progress strip during launch */}
        {status === "launching" && progress && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[12px] font-mono text-[#a1a1a6] mb-1.5">
              <span>
                {progress.stage} · {progress.message}
              </span>
              <span>
                {progress.current}/{progress.total} ({progressPct}%)
              </span>
            </div>
            <div className="h-0.5 w-full bg-[#ededed]/[0.08] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#ededed] transition-[width] duration-150"
                style={{ width: `${Math.max(4, progressPct)}%` }}
              />
            </div>
          </div>
        )}

        {/* Quiet Tab Bar */}
        <nav className="mt-5 -mb-5 flex items-center gap-6">
          {tabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`pb-3 text-[14px] border-b-[1.5px] transition-colors duration-150 flex items-center gap-2 ${
                  active
                    ? "border-[#ededed] text-[#ededed] font-medium"
                    : "border-transparent text-[#85858b] hover:text-[#a1a1a6]"
                }`}
              >
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span
                    className={`font-mono text-[11px] ${
                      tab.isErr ? "text-[#e5484d]" : "text-[#85858b]"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Pending manual downloads banner */}
      {pendingDownloads.length > 0 && (
        <div className="px-8 py-2.5 bg-[#d4a054]/10 border-b border-[#d4a054]/25 flex items-center justify-between gap-4">
          <span className="text-[13px] text-[#d4a054] truncate">
            {t.pendingBanner.replace("{count}", String(pendingDownloads.length))}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onOpenPending(pendingDownloads)}
              className="h-7 px-3 rounded-[6px] bg-[#d4a054] text-[#0f0f10] text-[12px] font-medium hover:opacity-90 transition-opacity"
            >
              {t.pendingOpenModal}
            </button>
            <button
              type="button"
              onClick={async () => {
                await api.dismissPendingDownloads(instance.id);
                setPendingDownloads([]);
              }}
              className="h-7 px-2.5 rounded-[6px] text-[12px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.06]"
            >
              {t.pendingDismiss}
            </button>
          </div>
        </div>
      )}

      {/* Tab Content */}
      <div key={activeTab} className="flex-1 overflow-y-auto px-8 py-6 mono-view-enter">
        {(activeTab === "mod" || activeTab === "resourcepack" || activeTab === "shaderpack") && (
          <div className="max-w-4xl">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2 flex-1 min-w-[260px]">
                <div className="relative flex-1 max-w-xs">
                  <Search
                    size={15}
                    strokeWidth={1.5}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-[#85858b]"
                  />
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t.searchFilter}
                    className="w-full h-9 pl-9 pr-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] text-[13px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25 transition-colors duration-150"
                  />
                </div>

                <Select
                  value={contentSort}
                  onChange={(v) => setContentSort(v as ContentSort)}
                  className="min-w-[165px]"
                  options={[
                    { value: "name-asc", label: t.sortNameAsc },
                    { value: "name-desc", label: t.sortNameDesc },
                    { value: "enabled", label: t.sortEnabledFirst },
                    { value: "disabled", label: t.sortDisabledFirst },
                    { value: "size-desc", label: t.sortSizeDesc },
                    { value: "size-asc", label: t.sortSizeAsc },
                  ]}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {content.length > 0 && !(isRust && activeTab === "mod") && (
                  <>
                    {availableUpdatesCount > 0 ? (
                      <button
                        type="button"
                        onClick={handleApplyAllUpdates}
                        className="mono-btn-primary h-9 px-3.5 rounded-[8px] flex items-center gap-1.5 text-[13px] font-medium"
                      >
                        <ArrowUpCircle size={15} strokeWidth={1.75} />
                        <span>
                          {t.updateAll.replace("{count}", String(availableUpdatesCount))}
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={checkingUpdates}
                        onClick={handleCheckUpdates}
                        className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px] disabled:opacity-50"
                      >
                        <RefreshCw
                          size={14}
                          strokeWidth={1.5}
                          className={`text-[#a1a1a6] ${checkingUpdates ? "animate-spin" : ""}`}
                        />
                        <span>
                          {checkingUpdates
                            ? t.checkingUpdates
                            : updatesChecked
                              ? t.noUpdatesFound
                              : t.checkUpdates}
                        </span>
                      </button>
                    )}
                  </>
                )}

                <button
                  type="button"
                  onClick={async () => {
                    const n = await api.pickAndAddLocalContent(
                      instance.id,
                      activeTab,
                      t.addFromFile,
                      isRust
                    );
                    if (n > 0) await loadContent(activeTab);
                  }}
                  className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px]"
                >
                  <Upload size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                  <span>{t.addFromFile}</span>
                </button>

                {!(isRust && activeTab === "mod") && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenModrinthFor(
                        activeTab === "shaderpack"
                          ? "shader"
                          : activeTab === "resourcepack"
                            ? "resourcepack"
                            : "mod"
                      )
                    }
                    className="mono-btn-secondary h-9 px-3.5 rounded-[8px] flex items-center gap-2 text-[13px]"
                  >
                    <Plus size={15} strokeWidth={1.5} className="text-[#a1a1a6]" />
                    <span>{t.addFromModrinth}</span>
                  </button>
                )}
              </div>
            </div>

            {filteredContent.length === 0 ? (
              <div className="py-16 text-center rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b]/50">
                <p className="text-[14px] text-[#ededed]">{t.emptyContent}</p>
                <p className="text-[13px] text-[#85858b] mt-1">
                  {isRust && activeTab === "mod" ? t.rustModsOnlyHmod : t.emptyContentHint}
                </p>
              </div>
            ) : (
              <div className="rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] divide-y divide-[#ededed]/[0.06]">
                {filteredContent.map((item) => {
                  const cleanVer = formatCleanVersion(item.version);
                  const canSwitchVersion = Boolean(item.source && item.projectId);
                  return (
                    <div
                      key={item.filename}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContentCtxMenu({
                          item,
                          x: e.clientX,
                          y: e.clientY,
                          confirmDelete: false,
                        });
                      }}
                      className="h-14 px-4 flex items-center gap-3.5 hover:bg-[#ededed]/[0.025] transition-colors duration-150"
                    >
                      {/* 1. Enable/Disable switch */}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={item.enabled}
                        onClick={() => handleToggleItem(item)}
                        className={`w-8 h-[18px] rounded-full p-0.5 transition-colors duration-150 shrink-0 ${
                          item.enabled ? "bg-[#ededed]" : "bg-[#232325] border border-[#ededed]/15"
                        }`}
                      >
                        <span
                          className={`block w-3.5 h-3.5 rounded-full transition-transform duration-150 ${
                            item.enabled
                              ? "translate-x-3.5 bg-[#0f0f10]"
                              : "translate-x-0 bg-[#85858b]"
                          }`}
                        />
                      </button>

                      {/* 2. Icon */}
                      {item.iconUrl ? (
                        <img
                          src={item.iconUrl}
                          alt={item.displayName}
                          className={`w-8 h-8 rounded-[6px] bg-[#232325] object-cover shrink-0 ${
                            item.enabled ? "" : "opacity-45 grayscale"
                          }`}
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-[6px] bg-[#232325] flex items-center justify-center shrink-0">
                          <Package size={15} strokeWidth={1.5} className="text-[#85858b]" />
                        </div>
                      )}

                      {/* 3. Name (takes available left space) */}
                      <span
                        title={item.filename}
                        className={`text-[14px] font-medium truncate flex-1 min-w-0 ${
                          item.enabled ? "text-[#ededed]" : "text-[#85858b] line-through"
                        }`}
                      >
                        {item.displayName}
                      </span>

                      {/* 4. Right side: version + size + actions */}
                      <div className="flex items-center gap-2 shrink-0 ml-auto">
                        {updatesMap[item.filename] && (
                          <button
                            type="button"
                            disabled={Boolean(updatingFiles[item.filename])}
                            onClick={() => handleApplyOneUpdate(updatesMap[item.filename])}
                            className="h-7 px-2.5 rounded-[6px] bg-[#4cc38a]/15 text-[#4cc38a] border border-[#4cc38a]/30 hover:bg-[#4cc38a]/25 text-[12px] font-medium flex items-center gap-1 transition-colors disabled:opacity-50"
                          >
                            <ArrowUpCircle size={13} strokeWidth={1.75} />
                            <span className="max-w-[130px] truncate">
                              {updatingFiles[item.filename]
                                ? t.updatingItem
                                : t.updateItem.replace(
                                    "{ver}",
                                    formatCleanVersion(updatesMap[item.filename].latestVersionNumber)
                                  )}
                            </span>
                          </button>
                        )}

                        {canSwitchVersion ? (
                          <button
                            type="button"
                            onClick={() => openVersionPicker(item)}
                            title={`${item.version ?? cleanVer} · ${t.ctxChangeVersion}`}
                            className="h-7 px-2 rounded-[6px] font-mono text-[12px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.06] inline-flex items-center gap-1.5 max-w-[140px] transition-colors"
                          >
                            <span className="truncate">{cleanVer}</span>
                            <Layers size={12} strokeWidth={1.5} className="shrink-0 text-[#85858b]" />
                          </button>
                        ) : (
                          <span
                            title={item.version ?? undefined}
                            className="font-mono text-[12px] text-[#a1a1a6] truncate max-w-[120px] px-1"
                          >
                            {cleanVer}
                          </span>
                        )}

                        <span className="font-mono text-[12px] text-[#85858b] w-16 text-right shrink-0">
                          {formatBytes(item.sizeBytes)}
                        </span>

                        <div className="flex items-center gap-1 pl-1">
                          {item.websiteUrl && (
                            <button
                              type="button"
                              onClick={() => api.openExternalUrl(item.websiteUrl!)}
                              title={t.openWebsite}
                              className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06] transition-colors duration-150"
                            >
                              <ExternalLink size={14} strokeWidth={1.5} />
                            </button>
                          )}
                          <button
                            type="button"
                            title={t.ctxDelete}
                            onClick={() => handleDeleteItem(item)}
                            className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[#85858b] hover:text-[#e5484d] hover:bg-[#e5484d]/10 transition-colors duration-150"
                          >
                            <Trash2 size={15} strokeWidth={1.5} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === "worlds" && (
          <WorldsTab
            t={t}
            instanceId={instance.id}
            mcVersion={instance.mcVersion}
            status={status}
            onQuickPlay={(folder) => onLaunch(folder)}
          />
        )}

        {activeTab === "screenshots" && (
          <ScreenshotsTab t={t} instanceId={instance.id} />
        )}

        {activeTab === "console" && (
          <div className="h-full flex flex-col min-h-[380px]">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-1 p-1 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08]">
                {(
                  [
                    ["all", t.allLogs],
                    ["error", t.errorsOnly],
                    ["warn", t.warningsOnly],
                  ] as const
                ).map(([lvl, label]) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setLogFilter(lvl)}
                    className={`h-7 px-3 rounded-[6px] text-[12px] transition-colors duration-150 ${
                      logFilter === lvl
                        ? "bg-[#232325] text-[#ededed] font-medium"
                        : "text-[#85858b] hover:text-[#a1a1a6]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  placeholder={t.searchFilter}
                  className="h-8 w-48 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] text-[12px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
                />
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      filteredLogs.map((l) => `[${l.timestamp}] ${l.text}`).join("\n")
                    )
                  }
                  className="mono-btn-secondary h-8 px-2.5 rounded-[8px] flex items-center gap-1.5 text-[12px]"
                >
                  <Copy size={13} strokeWidth={1.5} className="text-[#85858b]" />
                  <span>{t.copy}</span>
                </button>
                <button
                  type="button"
                  onClick={onClearLogs}
                  className="mono-btn-secondary h-8 px-2.5 rounded-[8px] text-[12px]"
                >
                  {t.clear}
                </button>
              </div>
            </div>

            <div className="flex-1 rounded-[12px] bg-[#0f0f10] border border-[#ededed]/[0.08] p-4 overflow-y-auto font-mono text-[12px] leading-5">
              {filteredLogs.length === 0 ? (
                <div className="text-[#85858b]">{t.noLogs}</div>
              ) : (
                filteredLogs.map((line, i) => (
                  <div
                    key={i}
                    className={`flex gap-3 py-0.5 break-all ${
                      line.level === "error"
                        ? "text-[#e5484d]"
                        : line.level === "warn"
                          ? "text-[#d4a054]"
                          : "text-[#a1a1a6]"
                    }`}
                  >
                    <span className="text-[#85858b]/60 shrink-0 select-none">
                      {line.timestamp}
                    </span>
                    <span>{line.text}</span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        )}

        {activeTab === "settings" && (
          <form onSubmit={handleSaveSettings} className="max-w-xl space-y-6">
            <div className="space-y-5">
              {/* Instance Icon + Name */}
              <div className="flex items-end gap-4">
                <div>
                  <label className="block text-[13px] text-[#a1a1a6] mb-1.5">
                    {t.instanceIcon}
                  </label>
                  <div className="flex items-center gap-2">
                    {instance.iconUrl ? (
                      <img
                        src={instance.iconUrl}
                        alt=""
                        className="w-9 h-9 rounded-[8px] bg-[#232325] object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] flex items-center justify-center shrink-0 font-mono text-[13px] text-[#85858b]">
                        {instance.name.trim().charAt(0).toUpperCase() || "M"}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        const updated = await api.pickInstanceIcon(instance.id, t.pickIcon);
                        if (updated) onInstanceReplaced(updated);
                      }}
                      className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px]"
                    >
                      <ImageIcon size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                      <span>{t.pickIcon}</span>
                    </button>
                    {instance.iconUrl && (
                      <button
                        type="button"
                        onClick={async () => {
                          const updated = await api.resetInstanceIcon(instance.id);
                          if (updated) onInstanceReplaced(updated);
                        }}
                        className="mono-btn-secondary h-9 px-2.5 rounded-[8px] text-[12px] text-[#85858b] hover:text-[#ededed]"
                      >
                        {t.resetIcon}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  <label className="block text-[13px] text-[#a1a1a6] mb-1.5">
                    {t.instanceName}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] text-[14px] text-[#ededed] focus:outline-none focus:border-[#ededed]/25"
                  />
                </div>
              </div>

              {modpackRecord && (
                <div className="rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] p-4 space-y-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[14px] font-medium text-[#ededed]">
                        {t.modpackSection}
                      </div>
                      <div className="text-[12px] text-[#85858b] mt-0.5 leading-[16px]">
                        {t.modpackSwitchHint}
                      </div>
                    </div>
                    {modpackRecord.websiteUrl && (
                      <button
                        type="button"
                        onClick={() => api.openExternalUrl(modpackRecord.websiteUrl!)}
                        className="mono-btn-secondary h-8 px-2.5 rounded-[8px] flex items-center gap-1.5 text-[12px] shrink-0"
                      >
                        <ExternalLink size={13} strokeWidth={1.5} />
                        <span>{t.openWebsite}</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedPackVer}
                      onChange={setSelectedPackVer}
                      mono
                      className="flex-1 !bg-[#141415]"
                      options={
                        packVersions.length === 0
                          ? [{ value: modpackRecord.versionId, label: modpackRecord.versionName }]
                          : (packVersions.some((v) => v.id === modpackRecord.versionId)
                              ? packVersions
                              : [
                                  {
                                    id: modpackRecord.versionId,
                                    name: modpackRecord.versionName,
                                    versionNumber: modpackRecord.versionName,
                                    versionType: "release",
                                    datePublished: "",
                                    gameVersions: [],
                                    loaders: [],
                                    compatible: true,
                                    filename: "",
                                    downloadUrl: "",
                                    fileSize: 0,
                                    dependencies: [],
                                  },
                                  ...packVersions,
                                ]
                            ).map((v) => ({
                              value: v.id,
                              label: `${v.name || v.versionNumber}${
                                v.gameVersions[0] ? ` (${v.gameVersions[0]})` : ""
                              }`,
                            }))
                      }
                    />
                    <button
                      type="button"
                      disabled={
                        switchingPack ||
                        !selectedPackVer ||
                        selectedPackVer === modpackRecord.versionId
                      }
                      onClick={handleSwitchPackVersion}
                      className="mono-btn-primary h-9 px-3.5 rounded-[8px] text-[13px] font-medium shrink-0 disabled:opacity-40"
                    >
                      {switchingPack ? t.modpackSwitching : t.modpackSwitchConfirm}
                    </button>
                  </div>

                  {packSwitchErr && (
                    <div className="text-[13px] text-[#e5484d]">{packSwitchErr}</div>
                  )}
                </div>
              )}

              {isRust ? (
                <div className="rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[14px] font-medium text-[#ededed]">
                        {t.horizonBuildTitle}
                      </div>
                      <div className="text-[12px] text-[#85858b] mt-0.5 leading-[16px]">
                        {horizonStatus?.found
                          ? `${horizonStatus.tag} · ${horizonStatus.prepared ? t.horizonPreparedYes : t.horizonPreparedNo}`
                          : t.horizonBuildMissing}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={importingBuild || clientDownloading}
                      onClick={handleAutoDownloadHorizonBuild}
                      className="mono-btn-secondary h-8 px-3 rounded-[8px] text-[12px] disabled:opacity-50"
                    >
                      {clientDownloading
                        ? `${t.horizonBuildDownloading} ${clientDownloadPercent}%`
                        : t.horizonBuildDownloadAuto}
                    </button>
                    <button
                      type="button"
                      disabled={importingBuild || clientDownloading}
                      onClick={() => handlePickHorizonBuild(false)}
                      className="mono-btn-secondary h-8 px-3 rounded-[8px] text-[12px] disabled:opacity-50"
                    >
                      {importingBuild ? t.horizonBuildImporting : t.horizonBuildPickFolder}
                    </button>
                    <button
                      type="button"
                      disabled={importingBuild || clientDownloading}
                      onClick={() => handlePickHorizonBuild(true)}
                      className="mono-btn-secondary h-8 px-3 rounded-[8px] text-[12px] disabled:opacity-50"
                    >
                      {t.horizonBuildPickZip}
                    </button>
                  </div>
                  {clientDownloading && (
                    <div className="h-1.5 w-full rounded-full bg-[#ededed]/[0.08] overflow-hidden">
                      <div
                        className="h-full bg-[#ededed] transition-[width] duration-150"
                        style={{ width: `${clientDownloadPercent}%` }}
                      />
                    </div>
                  )}
                  {horizonErr && <div className="text-[13px] text-[#e5484d]">{horizonErr}</div>}
                </div>
              ) : (
                <>
              {/* Minecraft version + loader */}
              <div className="rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] p-4 space-y-4">
                <div>
                  <div className="text-[14px] font-medium text-[#ededed]">{t.versionAndLoader}</div>
                  <div className="text-[12px] text-[#85858b] mt-0.5 leading-[16px]">
                    {t.versionAndLoaderHint}
                  </div>
                </div>
                <LoaderFields
                  t={t}
                  showSnapshots
                  mcVersion={mcVersionDraft}
                  onMcVersion={setMcVersionDraft}
                  loader={loaderDraft}
                  onLoader={setLoaderDraft}
                  loaderVersion={loaderVersionDraft}
                  onLoaderVersion={setLoaderVersionDraft}
                />
                {loaderError && <div className="text-[13px] text-[#e5484d]">{loaderError}</div>}
              </div>
              {/* RAM slider + manual keyboard input */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[13px] text-[#a1a1a6]">{t.memoryAllocation}</label>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center rounded-[6px] bg-[#19191b] border border-[#ededed]/[0.1] px-2 h-7 focus-within:border-[#ededed]/30">
                      <input
                        type="number"
                        min={512}
                        max={totalRamMb}
                        step={256}
                        value={ramInput}
                        onChange={(e) => {
                          setRamInput(e.target.value);
                          const n = parseInt(e.target.value, 10);
                          if (!Number.isNaN(n) && n >= 512 && n <= totalRamMb) {
                            setRamMb(n);
                          }
                        }}
                        onBlur={() => commitRamInput(ramInput)}
                        className="w-16 bg-transparent font-mono text-[13px] text-[#ededed] text-right focus:outline-none"
                      />
                      <span className="font-mono text-[12px] text-[#85858b] ml-1">MB</span>
                    </div>
                    <span className="font-mono text-[12px] text-[#85858b]">
                      / {totalRamMb} MB
                    </span>
                  </div>
                </div>
                <input
                  type="range"
                  min={1024}
                  max={maxRamSlider}
                  step={512}
                  value={Math.min(maxRamSlider, ramMb)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setRamMb(v);
                    setRamInput(String(v));
                  }}
                  className="w-full"
                />
              </div>
                </>
              )}

              {/* Game Window Size + Fullscreen */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[13px] text-[#a1a1a6]">{t.windowSize}</label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-[12px] text-[#85858b]">{t.fullscreen}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={fullscreen}
                      onClick={() => setFullscreen(!fullscreen)}
                      className={`w-8 h-[18px] rounded-full p-0.5 transition-colors duration-150 ${
                        fullscreen ? "bg-[#ededed]" : "bg-[#232325] border border-[#ededed]/15"
                      }`}
                    >
                      <span
                        className={`block w-3.5 h-3.5 rounded-full transition-transform duration-150 ${
                          fullscreen ? "translate-x-3.5 bg-[#0f0f10]" : "translate-x-0 bg-[#85858b]"
                        }`}
                      />
                    </button>
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    disabled={fullscreen}
                    value={windowWidth}
                    onChange={(e) => setWindowWidth(Number(e.target.value))}
                    placeholder={t.width}
                    className="w-28 h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] disabled:opacity-40 focus:outline-none focus:border-[#ededed]/25"
                  />
                  <span className="text-[#85858b] font-mono text-[12px]">×</span>
                  <input
                    type="number"
                    disabled={fullscreen}
                    value={windowHeight}
                    onChange={(e) => setWindowHeight(Number(e.target.value))}
                    placeholder={t.height}
                    className="w-28 h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] disabled:opacity-40 focus:outline-none focus:border-[#ededed]/25"
                  />
                  <button
                    type="button"
                    disabled={fullscreen}
                    onClick={() => {
                      setWindowWidth(1280);
                      setWindowHeight(720);
                    }}
                    className="mono-btn-secondary h-9 px-2.5 rounded-[8px] font-mono text-[12px] disabled:opacity-40"
                  >
                    720p
                  </button>
                  <button
                    type="button"
                    disabled={fullscreen}
                    onClick={() => {
                      setWindowWidth(1920);
                      setWindowHeight(1080);
                    }}
                    className="mono-btn-secondary h-9 px-2.5 rounded-[8px] font-mono text-[12px] disabled:opacity-40"
                  >
                    1080p
                  </button>
                </div>
              </div>

              {!isRust && (
                <>
              {/* JVM Args + Presets */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[13px] text-[#a1a1a6]">{t.jvmArguments}</label>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setJvmArgs(JVM_PRESET_G1GC)}
                      className="h-6 px-2 rounded-[6px] bg-[#232325] text-[11px] font-mono text-[#a1a1a6] hover:text-[#ededed] transition-colors"
                    >
                      G1GC
                    </button>
                    <button
                      type="button"
                      onClick={() => setJvmArgs(JVM_PRESET_ZGC)}
                      className="h-6 px-2 rounded-[6px] bg-[#232325] text-[11px] font-mono text-[#a1a1a6] hover:text-[#ededed] transition-colors"
                    >
                      ZGC
                    </button>
                    {jvmArgs && (
                      <button
                        type="button"
                        onClick={() => setJvmArgs("")}
                        className="h-6 px-2 rounded-[6px] text-[11px] text-[#85858b] hover:text-[#ededed] transition-colors"
                      >
                        {t.jvmReset}
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="text"
                  value={jvmArgs}
                  onChange={(e) => setJvmArgs(e.target.value)}
                  placeholder={t.jvmPlaceholder}
                  className="w-full h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
                />
              </div>

              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-1.5">
                  {t.javaVersionLabel}
                </label>
                <div className="grid grid-cols-5 gap-1 p-1 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08]">
                  {(
                    [
                      [null, t.javaAuto],
                      [8, "Java 8"],
                      [17, "Java 17"],
                      [21, "Java 21"],
                      [25, "Java 25"],
                    ] as [number | null, string][]
                  ).map(([val, label]) => (
                    <button
                      key={String(val)}
                      type="button"
                      onClick={() => setJavaMajor(val)}
                      className={`h-8 rounded-[6px] text-[12px] transition-colors duration-150 ${
                        javaMajor === val
                          ? "bg-[#232325] text-[#ededed] font-medium"
                          : "text-[#85858b] hover:text-[#a1a1a6]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-1.5">
                  {t.javaOverride}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={javaPath}
                    onChange={(e) => setJavaPath(e.target.value)}
                    placeholder={t.javaOverridePlaceholder}
                    className="flex-1 min-w-0 h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await api.pickJavaExecutable(t.javaPickTitle);
                      if (picked) setJavaPath(picked);
                    }}
                    className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px] shrink-0"
                  >
                    <FolderOpen size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                    <span>{t.javaBrowse}</span>
                  </button>
                </div>
              </div>
                </>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="mono-btn-primary h-9 px-4 rounded-[8px] text-[14px] font-medium"
              >
                {savedFlag ? t.saved : t.saveChanges}
              </button>
            </div>

            {/* Clone & Delete actions */}
            <div className="pt-6 border-t border-[#ededed]/[0.08] space-y-3">
              <div className="rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="text-[14px] font-medium text-[#ededed]">{t.cloneSection}</div>
                  <div className="text-[13px] text-[#85858b] mt-0.5">{t.cloneHint}</div>
                </div>
                <button
                  type="button"
                  disabled={cloning}
                  onClick={handleClone}
                  className="mono-btn-secondary h-9 px-3.5 rounded-[8px] flex items-center gap-1.5 text-[13px] shrink-0 disabled:opacity-50"
                >
                  <CopyPlus size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                  <span>{t.clonePack}</span>
                </button>
              </div>

              <div className="rounded-[12px] border border-[#e5484d]/25 bg-[#19191b] p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="text-[14px] font-medium text-[#ededed]">{t.dangerZone}</div>
                  <div className="text-[13px] text-[#85858b] mt-0.5">{t.dangerZoneHint}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onDeleteInstance(instance.id)}
                  className="h-9 px-3.5 rounded-[8px] bg-[#e5484d]/15 text-[#e5484d] border border-[#e5484d]/30 hover:bg-[#e5484d]/25 transition-colors duration-150 text-[13px] font-medium shrink-0"
                >
                  {t.deleteInstance}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Content right-click context menu */}
      {contentCtxMenu &&
        (activeTab === "mod" || activeTab === "resourcepack" || activeTab === "shaderpack") &&
        createPortal(
          <div
            ref={contentMenuRef}
            role="menu"
            style={{ left: contentMenuPos.left, top: contentMenuPos.top }}
            className="fixed z-[110] min-w-[215px] w-max max-w-[270px] p-1 rounded-[10px] bg-[#19191b] border border-[#ededed]/[0.12] shadow-[0_12px_32px_rgba(0,0,0,0.5)] mono-select-enter"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const target = contentCtxMenu.item;
                setContentCtxMenu(null);
                handleToggleItem(target);
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              <Power
                size={14}
                strokeWidth={1.5}
                className={`shrink-0 ${contentCtxMenu.item.enabled ? "text-[#85858b]" : "text-[#4cc38a]"}`}
              />
              <span>{contentCtxMenu.item.enabled ? t.ctxDisable : t.ctxEnable}</span>
            </button>

            {contentCtxMenu.item.source && contentCtxMenu.item.projectId && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const target = contentCtxMenu.item;
                  setContentCtxMenu(null);
                  openVersionPicker(target);
                }}
                className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
              >
                <Layers size={14} strokeWidth={1.5} className="shrink-0" />
                <span>{t.ctxChangeVersion}</span>
              </button>
            )}

            {contentCtxMenu.item.websiteUrl && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const url = contentCtxMenu.item.websiteUrl!;
                  setContentCtxMenu(null);
                  api.openExternalUrl(url);
                }}
                className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
              >
                <ExternalLink size={14} strokeWidth={1.5} className="shrink-0" />
                <span>{t.openWebsite}</span>
              </button>
            )}

            <div className="my-1 h-px bg-[#ededed]/[0.08]" />

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const fname = contentCtxMenu.item.filename;
                setContentCtxMenu(null);
                api.openContentFile(instance.id, activeTab, fname).catch(() => {});
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              <FolderOpen size={14} strokeWidth={1.5} className="shrink-0" />
              <span>{t.ctxShowInFolder}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const fname = contentCtxMenu.item.filename;
                setContentCtxMenu(null);
                navigator.clipboard.writeText(fname).catch(() => {});
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              <Copy size={14} strokeWidth={1.5} className="shrink-0" />
              <span>{t.ctxCopyFilename}</span>
            </button>

            <div className="my-1 h-px bg-[#ededed]/[0.08]" />

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (!contentCtxMenu.confirmDelete) {
                  setContentCtxMenu({ ...contentCtxMenu, confirmDelete: true });
                  return;
                }
                const target = contentCtxMenu.item;
                setContentCtxMenu(null);
                handleDeleteItem(target);
              }}
              className={`w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] transition-colors ${
                contentCtxMenu.confirmDelete
                  ? "bg-[#e5484d]/20 text-[#e5484d] font-medium"
                  : "text-[#e5484d] hover:bg-[#e5484d]/15"
              }`}
            >
              <Trash2 size={14} strokeWidth={1.5} className="shrink-0" />
              <span>{contentCtxMenu.confirmDelete ? t.ctxDeleteConfirm : t.ctxDelete}</span>
            </button>
          </div>,
          document.body
        )}

      {/* Per-item version switcher modal */}
      {versionPickerItem && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4 mono-backdrop-enter"
          onClick={() => !versionPickerBusyId && setVersionPickerItem(null)}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] rounded-[16px] bg-[#19191b] border border-[#ededed]/[0.1] flex flex-col overflow-hidden mono-modal-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[#ededed]/[0.08] flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                {versionPickerItem.iconUrl ? (
                  <img
                    src={versionPickerItem.iconUrl}
                    alt=""
                    className="w-8 h-8 rounded-[8px] bg-[#232325] shrink-0 object-cover"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-[8px] bg-[#232325] flex items-center justify-center shrink-0">
                    <Package size={15} strokeWidth={1.5} className="text-[#85858b]" />
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="text-[16px] font-medium text-[#ededed] truncate">
                    {versionPickerItem.displayName} – {t.versionsModalTitle}
                  </h2>
                  <div className="font-mono text-[12px] text-[#85858b]">
                    {instance.mcVersion} · {loaderLabel}
                  </div>
                </div>
              </div>

              <button
                type="button"
                disabled={Boolean(versionPickerBusyId)}
                onClick={() => setVersionPickerItem(null)}
                className="w-8 h-8 rounded-[8px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06]"
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>

            <div className="px-6 py-3 border-b border-[#ededed]/[0.06] flex items-center justify-between gap-4 bg-[#141415]/60">
              <Checkbox
                checked={versionPickerOnlyCompat}
                onChange={setVersionPickerOnlyCompat}
                label={t.onlyCompatible}
              />
              {versionPickerItem.version && (
                <span className="font-mono text-[12px] text-[#85858b]">
                  {t.currentVersionBadge}: {formatCleanVersion(versionPickerItem.version)}
                </span>
              )}
            </div>

            {versionPickerErr && (
              <div className="px-6 py-2.5 bg-[#e5484d]/10 border-b border-[#e5484d]/25 text-[13px] text-[#e5484d]">
                {versionPickerErr}
              </div>
            )}

            <div className="flex-1 overflow-y-auto divide-y divide-[#ededed]/[0.06]">
              {versionPickerLoading ? (
                <div className="p-8 text-center text-[13px] text-[#85858b]">{t.loadingMore}</div>
              ) : (
                (() => {
                  const list = versionPickerOnlyCompat
                    ? versionPickerList.filter((v) => v.compatible)
                    : versionPickerList;
                  if (list.length === 0) {
                    return (
                      <div className="p-8 text-center text-[13px] text-[#85858b]">{t.noResults}</div>
                    );
                  }
                  const curBase = versionPickerItem.filename.replace(/\.disabled$/i, "");
                  return list.map((ver) => {
                    const isCurrent =
                      ver.filename.toLowerCase() === curBase.toLowerCase() ||
                      (versionPickerItem.version &&
                        ver.versionNumber === versionPickerItem.version);
                    const busy = versionPickerBusyId === ver.id;
                    return (
                      <div
                        key={ver.id}
                        className="px-6 py-3 flex items-center justify-between gap-4 hover:bg-[#ededed]/[0.02]"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              title={ver.versionNumber}
                              className="text-[14px] font-medium text-[#ededed] truncate"
                            >
                              {formatCleanVersion(ver.versionNumber)}
                            </span>
                            {isCurrent && (
                              <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-[4px] bg-[#ededed]/10 text-[#ededed]">
                                {t.currentVersionBadge}
                              </span>
                            )}
                            <span
                              className={`text-[11px] font-mono px-1.5 py-0.5 rounded-[4px] ${
                                ver.compatible
                                  ? "bg-[#4cc38a]/15 text-[#4cc38a]"
                                  : "bg-[#e5484d]/15 text-[#e5484d]"
                              }`}
                            >
                              {ver.compatible ? t.compatible : t.incompatible}
                            </span>
                            <span className="font-mono text-[11px] text-[#85858b]">
                              {ver.versionType}
                            </span>
                          </div>
                          <div className="font-mono text-[12px] text-[#85858b] truncate mt-0.5">
                            {ver.gameVersions.slice(0, 4).join(", ")}
                            {ver.loaders.length > 0 ? ` · ${ver.loaders.join(", ")}` : ""}
                            {ver.fileSize ? ` · ${formatBytes(ver.fileSize)}` : ""}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={Boolean(versionPickerBusyId) || Boolean(isCurrent)}
                          onClick={() => handleSwitchContentVersion(ver)}
                          className={`h-8 px-3 rounded-[8px] text-[12px] font-medium shrink-0 disabled:opacity-45 ${
                            ver.compatible ? "mono-btn-primary" : "mono-btn-secondary"
                          }`}
                        >
                          {busy ? t.switchingVersion : isCurrent ? t.currentVersionBadge : t.selectVersionBtn}
                        </button>
                      </div>
                    );
                  });
                })()
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
