import { useEffect, useMemo, useRef, useState } from "react";
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
  RefreshCw,
  Search,
  Share,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import type { Dict } from "../i18n";
import { api } from "../lib/api";
import { ScreenshotsTab, WorldsTab } from "./InstanceExtraTabs";
import { LoaderFields, loaderLabel as fmtLoader } from "./LoaderFields";
import { Select } from "./Select";
import type {
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
  onUpdateInstance: (updated: Instance, customLoaderPath?: string | null) => Promise<void>;
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
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? (isRust ? "console" : "mod"));
  const [content, setContent] = useState<InstalledContent[]>([]);
  const [filter, setFilter] = useState("");
  const [logFilter, setLogFilter] = useState<"all" | "error" | "warn">("all");
  const [logSearch, setLogSearch] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  // Settings form state
  const [name, setName] = useState(instance.name);
  const [ramMb, setRamMb] = useState(instance.ramMb);
  const [ramInput, setRamInput] = useState(String(instance.ramMb));
  const [windowWidth, setWindowWidth] = useState(instance.windowWidth || 1280);
  const [windowHeight, setWindowHeight] = useState(instance.windowHeight || 720);
  const [fullscreen, setFullscreen] = useState(Boolean(instance.fullscreen));
  const [jvmArgs, setJvmArgs] = useState(instance.jvmArgs);
  const [javaPath, setJavaPath] = useState(instance.javaPath ?? "");
  const [mcVersionDraft, setMcVersionDraft] = useState(instance.mcVersion);
  const [loaderDraft, setLoaderDraft] = useState<Instance["loader"]>(instance.loader);
  const [loaderVersionDraft, setLoaderVersionDraft] = useState(instance.loaderVersion ?? "");
  const [customLoaderPath, setCustomLoaderPath] = useState<string | null>(null);
  const [loaderError, setLoaderError] = useState<string | null>(null);
  const [savedFlag, setSavedFlag] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [horizonStatus, setHorizonStatus] = useState<HorizonBuildStatus | null>(null);
  const [importingBuild, setImportingBuild] = useState(false);
  const [horizonErr, setHorizonErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isRust) return;
    api.getHorizonStatus().then(setHorizonStatus).catch(() => {});
  }, [isRust, instance.id]);

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
    setMcVersionDraft(instance.mcVersion);
    setLoaderDraft(instance.loader);
    setLoaderVersionDraft(instance.loaderVersion ?? "");
    setCustomLoaderPath(null);
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

  const filteredContent = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return content;
    return content.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.filename.toLowerCase().includes(q)
    );
  }, [content, filter]);

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
    if (loaderDraft === "custom" && instance.loader !== "custom" && !customLoaderPath) {
      setLoaderError(t.customLoaderNone);
      return;
    }
    setLoaderError(null);
    try {
      await onUpdateInstance(
        {
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
        },
        loaderDraft === "custom" ? customLoaderPath : null
      );
    } catch (err) {
      setLoaderError(String(err));
      return;
    }
    setCustomLoaderPath(null);
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

  const loaderLabel =
    instance.loader === "vanilla"
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
  // Rust Edition (Horizon) has no Java mods, packs or per-instance game folder: console + settings only.
  const tabs = isRust ? allTabs.filter((x) => x.id === "console" || x.id === "settings") : allTabs;

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
          <span className="text-[#ededed]/15">/</span>
          <span className="whitespace-nowrap">{instance.ramMb} MB</span>
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
            <div className="flex items-center justify-between gap-3 mb-4">
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

              <div className="flex flex-wrap items-center gap-2">
                {content.length > 0 && (
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
                      t.addFromFile
                    );
                    if (n > 0) await loadContent(activeTab);
                  }}
                  className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px]"
                >
                  <Upload size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                  <span>{t.addFromFile}</span>
                </button>

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
              </div>
            </div>

            {filteredContent.length === 0 ? (
              <div className="py-16 text-center rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b]/50">
                <p className="text-[14px] text-[#ededed]">{t.emptyContent}</p>
                <p className="text-[13px] text-[#85858b] mt-1">{t.emptyContentHint}</p>
              </div>
            ) : (
              <div className="rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] divide-y divide-[#ededed]/[0.06]">
                {filteredContent.map((item) => (
                  <div
                    key={item.filename}
                    className="h-14 px-4 flex items-center gap-3.5 hover:bg-[#ededed]/[0.02] transition-colors duration-150"
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

                    {/* 2. Mod Icon */}
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

                    {/* 3. Proper Mod Name */}
                    <span
                      className={`text-[14px] font-medium truncate min-w-[110px] max-w-[220px] shrink-0 ${
                        item.enabled ? "text-[#ededed]" : "text-[#85858b] line-through"
                      }`}
                    >
                      {item.displayName}
                    </span>

                    {/* 4. Version */}
                    <span className="font-mono text-[12px] text-[#a1a1a6] truncate max-w-[140px] shrink-0">
                      {item.version ?? "—"}
                    </span>

                    {/* 5. File Size */}
                    <span className="font-mono text-[12px] text-[#85858b] w-16 text-right shrink-0">
                      {formatBytes(item.sizeBytes)}
                    </span>

                    {/* 6. Filename (takes remaining space if it fits) */}
                    <span
                      title={item.filename}
                      className="font-mono text-[12px] text-[#85858b]/70 truncate flex-1 min-w-0 hidden md:block"
                    >
                      {item.filename}
                    </span>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 shrink-0 ml-auto">
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
                                  updatesMap[item.filename].latestVersionNumber
                                )}
                          </span>
                        </button>
                      )}
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
                        onClick={() => handleDeleteItem(item)}
                        className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[#85858b] hover:text-[#e5484d] hover:bg-[#e5484d]/10 transition-colors duration-150"
                      >
                        <Trash2 size={15} strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                ))}
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
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={importingBuild}
                      onClick={() => handlePickHorizonBuild(false)}
                      className="mono-btn-secondary h-8 px-3 rounded-[8px] text-[12px] disabled:opacity-50"
                    >
                      {importingBuild ? t.horizonBuildImporting : t.horizonBuildPickFolder}
                    </button>
                    <button
                      type="button"
                      disabled={importingBuild}
                      onClick={() => handlePickHorizonBuild(true)}
                      className="mono-btn-secondary h-8 px-3 rounded-[8px] text-[12px] disabled:opacity-50"
                    >
                      {t.horizonBuildPickZip}
                    </button>
                  </div>
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
                  customPath={customLoaderPath}
                  onCustomPath={setCustomLoaderPath}
                  hasExistingCustom={instance.loader === "custom"}
                  onError={setLoaderError}
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
                  {t.javaOverride}
                </label>
                <input
                  type="text"
                  value={javaPath}
                  onChange={(e) => setJavaPath(e.target.value)}
                  placeholder={t.javaOverridePlaceholder}
                  className="w-full h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
                />
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
    </div>
  );
}
