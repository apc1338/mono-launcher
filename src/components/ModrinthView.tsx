import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  Layers,
  Loader2,
  Package,
  Search,
  X,
} from "lucide-react";
import type { Dict } from "../i18n";
import { api } from "../lib/api";
import { Checkbox, Select } from "./Select";
import type {
  BatchResolveItem,
  CatalogHit,
  CatalogSource,
  CatalogVersion,
  Instance,
  PackInstallResult,
  ResolvedBatchFile,
} from "../types";

type ProjectKind = "mod" | "shader" | "resourcepack" | "modpack";
type SortIndex = "relevance" | "downloads" | "updated" | "newest";

const PAGE_SIZE = 24;

interface ModrinthViewProps {
  t: Dict;
  instances: Instance[];
  initialKind?: ProjectKind;
  initialTargetInstanceId?: string;
  onModpackCreated: (res: PackInstallResult) => void;
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ModrinthView({
  t,
  instances,
  initialKind = "mod",
  initialTargetInstanceId,
  onModpackCreated,
}: ModrinthViewProps) {
  const [source, setSource] = useState<CatalogSource>("modrinth");
  const [kind, setKind] = useState<ProjectKind>(initialKind);
  const [sortIndex, setSortIndex] = useState<SortIndex>("relevance");
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<string>(
    initialTargetInstanceId ?? instances[0]?.id ?? ""
  );
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [installingIds, setInstallingIds] = useState<Record<string, boolean>>({});
  const [installedMap, setInstalledMap] = useState<Record<string, string>>({});
  const [installedOnDisk, setInstalledOnDisk] = useState<{
    keys: Set<string>;
    titles: Set<string>;
  }>({ keys: new Set(), titles: new Set() });
  const [error, setError] = useState<string | null>(null);

  // Version Picker Modal state
  const [versionsHit, setVersionsHit] = useState<CatalogHit | null>(null);
  const [versionsList, setVersionsList] = useState<CatalogVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [onlyCompatible, setOnlyCompatible] = useState(true);
  const [installDeps, setInstallDeps] = useState(true);
  const [installingVersionId, setInstallingVersionId] = useState<string | null>(null);

  // Batch selection & dependency confirmation modal state
  const [selectedMap, setSelectedMap] = useState<Record<string, BatchResolveItem>>({});
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchResolving, setBatchResolving] = useState(false);
  const [batchFiles, setBatchFiles] = useState<ResolvedBatchFile[]>([]);
  const [batchChecked, setBatchChecked] = useState<Record<string, boolean>>({});
  const [batchInstalling, setBatchInstalling] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const disallowsRust = kind === "mod";
  const availableInstances = disallowsRust
    ? instances.filter((i) => i.edition !== "rust")
    : instances;
  const targetInstance = availableInstances.find((i) => i.id === targetId) ?? null;

  useEffect(() => {
    setKind(initialKind);
  }, [initialKind]);

  useEffect(() => {
    if (
      initialTargetInstanceId &&
      availableInstances.some((i) => i.id === initialTargetInstanceId)
    ) {
      setTargetId(initialTargetInstanceId);
    } else if (!availableInstances.some((i) => i.id === targetId)) {
      setTargetId(availableInstances[0]?.id ?? "");
    }
  }, [initialTargetInstanceId, availableInstances, targetId]);

  const refreshInstalledOnDisk = useCallback(
    async (instanceId: string | undefined, projectKind: ProjectKind) => {
      if (!instanceId || projectKind === "modpack") {
        setInstalledOnDisk({ keys: new Set(), titles: new Set() });
        return;
      }
      const contentKind =
        projectKind === "shader"
          ? "shaderpack"
          : projectKind === "resourcepack"
            ? "resourcepack"
            : "mod";
      try {
        const items = await api.listContent(instanceId, contentKind);
        const keys = new Set<string>();
        const titles = new Set<string>();
        for (const it of items) {
          if (it.source && it.projectId) {
            keys.add(`${it.source}:${it.projectId}`);
          }
          const normTitle = it.displayName.trim().toLowerCase();
          if (normTitle) titles.add(normTitle);
        }
        setInstalledOnDisk({ keys, titles });
      } catch {
        setInstalledOnDisk({ keys: new Set(), titles: new Set() });
      }
    },
    []
  );

  useEffect(() => {
    setInstalledMap({});
  }, [targetInstance?.id]);

  useEffect(() => {
    refreshInstalledOnDisk(targetInstance?.id, kind);
  }, [targetInstance?.id, kind, refreshInstalledOnDisk]);

  const [debouncedQuery, setDebouncedQuery] = useState("");
  const reqIdRef = useRef(0);
  const cacheRef = useRef<Map<string, { hits: CatalogHit[]; total: number }>>(new Map());

  // Debounce only the text input, so tab/sort switches fire instantly.
  useEffect(() => {
    if (query === debouncedQuery) return;
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query, debouncedQuery]);

  const keyFor = (k: ProjectKind) =>
    `${source}|${debouncedQuery}|${k}|${sortIndex}|${
      k !== "modpack" ? targetInstance?.mcVersion ?? "" : ""
    }|${k === "mod" ? targetInstance?.loader ?? "" : ""}`;
  const cacheKey = keyFor(kind);
  const prefetchingRef = useRef<Set<string>>(new Set());

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      const reqId = ++reqIdRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await api.searchCatalog({
          source,
          query: debouncedQuery,
          projectType: kind,
          mcVersion: kind !== "modpack" ? targetInstance?.mcVersion : undefined,
          loader:
            kind === "mod" && targetInstance && targetInstance.loader !== "vanilla" && targetInstance.loader !== "custom"
              ? targetInstance.loader
              : undefined,
          sortIndex,
          limit: PAGE_SIZE,
          offset,
        });
        // Drop stale responses (user already switched tab/query)
        if (reqId !== reqIdRef.current) return;
        setTotalHits(res.totalHits);
        setHits((prev) => {
          if (!append) {
            cacheRef.current.set(cacheKey, { hits: res.hits, total: res.totalHits });
            return res.hits;
          }
          const seen = new Set(prev.map((h) => `${h.source}:${h.projectId}`));
          const merged = [...prev];
          for (const item of res.hits) {
            const key = `${item.source}:${item.projectId}`;
            if (!seen.has(key)) merged.push(item);
          }
          cacheRef.current.set(cacheKey, { hits: merged, total: res.totalHits });
          return merged;
        });
      } catch (e) {
        if (reqId === reqIdRef.current) setError(String(e));
      } finally {
        if (reqId === reqIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cacheKey]
  );

  useEffect(() => {
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      // show instantly, no refetch
      reqIdRef.current++;
      setHits(cached.hits);
      setTotalHits(cached.total);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      return;
    }
    setHits([]);
    setTotalHits(0);
    fetchPage(0, false);
  }, [cacheKey, fetchPage]);
  // Prefetch first page of the other tabs once the current one is loaded.
  useEffect(() => {
    if (loading || hits.length === 0) return;
    let cancelled = false;
    const others = (["mod", "shader", "resourcepack", "modpack"] as ProjectKind[]).filter(
      (k) => k !== kind
    );
    const timer = setTimeout(async () => {
      for (const k of others) {
        if (cancelled) return;
        const key = keyFor(k);
        if (cacheRef.current.has(key) || prefetchingRef.current.has(key)) continue;
        prefetchingRef.current.add(key);
        try {
          const res = await api.searchCatalog({
            source,
            query: debouncedQuery,
            projectType: k,
            mcVersion: k !== "modpack" ? targetInstance?.mcVersion : undefined,
            loader:
              k === "mod" && targetInstance && targetInstance.loader !== "vanilla" && targetInstance.loader !== "custom"
                ? targetInstance.loader
                : undefined,
            sortIndex,
            limit: PAGE_SIZE,
            offset: 0,
          });
          if (!cacheRef.current.has(key)) {
            cacheRef.current.set(key, { hits: res.hits, total: res.totalHits });
          }
        } catch {
          // prefetch failures are silent
        } finally {
          prefetchingRef.current.delete(key);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, loading, hits.length > 0]);
  const hasMore = hits.length < totalHits;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loading || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore && hits.length < totalHits) {
          fetchPage(hits.length, true);
        }
      },
      { rootMargin: "240px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, hits.length, totalHits, fetchPage]);

  const handleQuickInstall = async (hit: CatalogHit) => {
    const key = `${hit.source}:${hit.projectId}`;
    setInstallingIds((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      if (kind === "modpack") {
        const res = await api.installCatalogModpack({
          source: hit.source,
          projectId: hit.projectId,
          title: hit.title,
        });
        setInstalledMap((prev) => ({ ...prev, [key]: t.installed }));
        onModpackCreated(res);
      } else {
        if (!targetInstance) {
          throw new Error("Select a target instance first");
        }
        const res = await api.installCatalogProject({
          source: hit.source,
          instanceId: targetInstance.id,
          projectId: hit.projectId,
          projectType: kind,
          mcVersion: targetInstance.mcVersion,
          loader: targetInstance.loader !== "vanilla" && targetInstance.loader !== "custom" ? targetInstance.loader : undefined,
          installDeps: true,
        });
        const label =
          res.installedDependencies.length > 0
            ? `${t.installed} (+${res.installedDependencies.length})`
            : t.installed;
        setInstalledMap((prev) => ({ ...prev, [key]: label }));
        refreshInstalledOnDisk(targetInstance.id, kind);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setInstallingIds((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const openVersionsModal = async (hit: CatalogHit) => {
    setVersionsHit(hit);
    setVersionsList([]);
    setVersionsLoading(true);
    setError(null);
    try {
      const list = await api.getCatalogVersions({
        source: hit.source,
        projectId: hit.projectId,
        projectType: kind,
        mcVersion: kind !== "modpack" ? targetInstance?.mcVersion : undefined,
        loader:
          kind === "mod" && targetInstance && targetInstance.loader !== "vanilla" && targetInstance.loader !== "custom"
            ? targetInstance.loader
            : undefined,
      });
      setVersionsList(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleInstallSpecificVersion = async (ver: CatalogVersion) => {
    if (!versionsHit) return;
    if (kind !== "modpack" && !targetInstance) return;
    setInstallingVersionId(ver.id);
    setError(null);
    try {
      const key = `${versionsHit.source}:${versionsHit.projectId}`;
      if (kind === "modpack") {
        const res = await api.installCatalogModpack({
          source: versionsHit.source,
          projectId: versionsHit.projectId,
          versionId: ver.id,
          title: versionsHit.title,
        });
        setInstalledMap((prev) => ({ ...prev, [key]: t.installed }));
        setVersionsHit(null);
        onModpackCreated(res);
        return;
      }
      const res = await api.installCatalogProject({
        source: versionsHit.source,
        instanceId: targetInstance!.id,
        projectId: versionsHit.projectId,
        versionId: ver.id,
        projectType: kind,
        mcVersion: targetInstance!.mcVersion,
        loader: targetInstance!.loader !== "vanilla" && targetInstance!.loader !== "custom" ? targetInstance!.loader : undefined,
        installDeps,
      });
      const label =
        res.installedDependencies.length > 0
          ? `${t.installed} (+${res.installedDependencies.length})`
          : t.installed;
      setInstalledMap((prev) => ({ ...prev, [key]: label }));
      setVersionsHit(null);
      refreshInstalledOnDisk(targetInstance!.id, kind);
    } catch (e) {
      setError(String(e));
    } finally {
      setInstallingVersionId(null);
    }
  };

  const selectedList = Object.values(selectedMap);
  const batchFileKey = (f: ResolvedBatchFile) => `${f.source}:${f.projectId}:${f.versionId || "err"}`;

  const toggleSelectHit = (hit: CatalogHit) => {
    if (kind === "modpack") return;
    const key = `${hit.source}:${hit.projectId}`;
    setSelectedMap((prev) => {
      if (prev[key]) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return {
        ...prev,
        [key]: {
          source: hit.source,
          projectId: hit.projectId,
          projectType: kind,
          title: hit.title,
          iconUrl: hit.iconUrl,
        },
      };
    });
  };

  const openBatchConfirm = async () => {
    if (!targetInstance || selectedList.length === 0) return;
    setBatchModalOpen(true);
    setBatchResolving(true);
    setBatchFiles([]);
    setBatchChecked({});
    setBatchError(null);
    try {
      const files = await api.resolveCatalogBatch(targetInstance.id, selectedList);
      setBatchFiles(files);
      const checked: Record<string, boolean> = {};
      for (const f of files) {
        checked[batchFileKey(f)] = !f.error && !f.alreadyInstalled;
      }
      setBatchChecked(checked);
    } catch (e) {
      setBatchError(String(e));
    } finally {
      setBatchResolving(false);
    }
  };

  const handleConfirmBatchInstall = async () => {
    if (!targetInstance) return;
    const toInstall = batchFiles.filter((f) => !f.error && batchChecked[batchFileKey(f)]);
    if (toInstall.length === 0) return;
    setBatchError(null);
    setBatchInstalling({ current: 0, total: toInstall.length });
    const installedKeys: string[] = [];
    try {
      for (let i = 0; i < toInstall.length; i++) {
        const f = toInstall[i];
        setBatchInstalling({ current: i + 1, total: toInstall.length });
        await api.installCatalogProject({
          source: f.source,
          instanceId: targetInstance.id,
          projectId: f.projectId,
          versionId: f.versionId,
          projectType: f.projectType,
          mcVersion: targetInstance.mcVersion,
          loader:
            targetInstance.loader !== "vanilla" && targetInstance.loader !== "custom"
              ? targetInstance.loader
              : undefined,
          installDeps: false,
        });
        installedKeys.push(`${f.source}:${f.projectId}`);
      }
      setInstalledMap((prev) => {
        const next = { ...prev };
        for (const k of installedKeys) next[k] = t.installed;
        return next;
      });
      setSelectedMap({});
      setBatchModalOpen(false);
      refreshInstalledOnDisk(targetInstance.id, kind);
    } catch (e) {
      setBatchError(String(e));
    } finally {
      setBatchInstalling(null);
    }
  };

  const kinds: [ProjectKind, string][] = [
    ["mod", t.typeMod],
    ["shader", t.typeShader],
    ["resourcepack", t.typeResourcepack],
    ["modpack", t.typeModpack],
  ];

  const sorts: [SortIndex, string][] = [
    ["relevance", t.sortRelevance],
    ["downloads", t.sortDownloads],
    ["updated", t.sortUpdated],
    ["newest", t.sortNewest],
  ];

  const displayedVersions =
    kind !== "modpack" && onlyCompatible
      ? versionsList.filter((v) => v.compatible)
      : versionsList;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#141415] mono-view-enter">
      <div className="px-8 pt-6 pb-5 border-b border-[#ededed]/[0.08]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-baseline gap-3">
              <h1 className="text-[28px] leading-8 font-medium tracking-[-0.02em] text-[#ededed]">
                {t.modrinthTitle}
              </h1>
            </div>

            {/* Source toggle: Modrinth | CurseForge */}
            <div className="flex items-center gap-1 p-1 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08]">
              {(
                [
                  ["modrinth", "Modrinth"],
                  ["curseforge", "CurseForge"],
                ] as [CatalogSource, string][]
              ).map(([src, label]) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setSource(src)}
                  className={`h-7 px-3 rounded-[6px] text-[12px] transition-colors duration-150 ${
                    source === src
                      ? "bg-[#232325] text-[#ededed] font-medium"
                      : "text-[#85858b] hover:text-[#a1a1a6]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {kind !== "modpack" && availableInstances.length > 0 && (
            <div className="flex items-center gap-2.5">
              <span className="text-[12px] text-[#85858b]">{t.targetInstance}</span>
              <Select
                value={targetId}
                onChange={setTargetId}
                options={availableInstances.map((i) => ({
                  value: i.id,
                  label: `${i.name} (${i.mcVersion})`,
                }))}
                className="min-w-[160px] max-w-[260px]"
                align="right"
                minMenuWidth={220}
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search
              size={15}
              strokeWidth={1.5}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[#85858b]"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.searchModrinth}
              className="w-full h-9 pl-9 pr-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] text-[14px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
            />
          </div>

          <div className="flex items-center gap-1 p-1 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08]">
            {kinds.map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`h-7 px-3 rounded-[6px] text-[13px] transition-colors duration-150 ${
                  kind === k
                    ? "bg-[#232325] text-[#ededed] font-medium"
                    : "text-[#85858b] hover:text-[#a1a1a6]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <Select
            value={sortIndex}
            onChange={(v) => setSortIndex(v as SortIndex)}
            options={sorts.map(([id, label]) => ({ value: id, label }))}
            className="min-w-[150px]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {error && (
          <div className="mb-4 px-4 py-3 rounded-[8px] bg-[#e5484d]/10 border border-[#e5484d]/25 text-[13px] text-[#e5484d]">
            {error}
          </div>
        )}

        {loading && hits.length === 0 ? (
          <div className="max-w-4xl rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] divide-y divide-[#ededed]/[0.06]">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
              <div
                key={n}
                className="p-4 flex items-center justify-between gap-4 mono-row-enter"
                style={{ animationDelay: `${n * 35}ms`, opacity: 1 - n * 0.06 }}
              >
                <div className="flex items-center gap-3.5 min-w-0 flex-1">
                  <div className="mono-skel w-11 h-11 rounded-[10px] shrink-0" />
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="mono-skel h-3.5 rounded-[4px]" style={{ width: `${30 + ((n * 17) % 25)}%` }} />
                    <div className="mono-skel h-3 rounded-[4px]" style={{ width: `${55 + ((n * 13) % 35)}%` }} />
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="mono-skel w-10 h-3 rounded-[4px]" />
                  <div className="mono-skel w-8 h-8 rounded-[8px]" />
                  <div className="mono-skel w-20 h-8 rounded-[8px]" />
                  <div className="mono-skel w-24 h-8 rounded-[8px]" />
                </div>
              </div>
            ))}
          </div>        ) : hits.length === 0 ? (
          <div className="py-16 text-center text-[14px] text-[#85858b]">{t.noResults}</div>
        ) : (
          <div className="max-w-4xl">
            <div className="rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] divide-y divide-[#ededed]/[0.06]">
              {hits.map((hit) => {
                const key = `${hit.source}:${hit.projectId}`;
                const busy = Boolean(installingIds[key]);
                const isAlreadyInstalled =
                  kind !== "modpack" &&
                  (installedOnDisk.keys.has(key) ||
                    installedOnDisk.titles.has(hit.title.trim().toLowerCase()));
                const doneLabel = installedMap[key] ?? (isAlreadyInstalled ? t.installed : null);
                const isSelected = Boolean(selectedMap[key]);
                return (
                  <div
                    key={key}
                    className={`p-4 flex items-center justify-between gap-4 transition-colors duration-150 mono-row-enter ${
                      isSelected ? "bg-[#ededed]/[0.04]" : "hover:bg-[#ededed]/[0.02]"
                    }`}
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      {kind !== "modpack" && (
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isSelected}
                          title={isSelected ? t.selectedItem : t.selectItem}
                          onClick={() => toggleSelectHit(hit)}
                          className={`w-5 h-5 rounded-[6px] border flex items-center justify-center shrink-0 transition-colors ${
                            isSelected
                              ? "bg-[#ededed] border-[#ededed] text-[#0f0f10]"
                              : "bg-[#141415] border-[#ededed]/[0.18] hover:border-[#ededed]/40"
                          }`}
                        >
                          {isSelected && <Check size={13} strokeWidth={2.5} />}
                        </button>
                      )}
                      {hit.iconUrl ? (
                        <img
                          src={hit.iconUrl}
                          alt={hit.title}
                          className="w-11 h-11 rounded-[10px] bg-[#232325] object-cover shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-11 h-11 rounded-[10px] bg-[#232325] flex items-center justify-center shrink-0">
                          <Package size={18} strokeWidth={1.5} className="text-[#85858b]" />
                        </div>
                      )}

                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[14px] font-medium text-[#ededed] truncate">
                            {hit.title}
                          </span>
                          <span className="text-[12px] text-[#85858b] truncate">
                            {hit.author}
                          </span>
                        </div>
                        <p className="text-[13px] text-[#a1a1a6] truncate mt-0.5">
                          {hit.description}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-[12px] text-[#85858b] w-14 text-right mr-1">
                        {formatDownloads(hit.downloads)}
                      </span>

                      <button
                        type="button"
                        onClick={() => api.openExternalUrl(hit.websiteUrl)}
                        title={t.openWebsite}
                        className="mono-btn-secondary w-8 h-8 rounded-[8px] flex items-center justify-center text-[#85858b] hover:text-[#ededed]"
                      >
                        <ExternalLink size={14} strokeWidth={1.5} />
                      </button>

                      <button
                        type="button"
                        onClick={() => openVersionsModal(hit)}
                        title={t.versionsBtn}
                        className="mono-btn-secondary h-8 px-2.5 rounded-[8px] flex items-center gap-1.5 text-[12px] text-[#a1a1a6] hover:text-[#ededed]"
                      >
                        <Layers size={13} strokeWidth={1.5} />
                        <span>{t.versionsBtn}</span>
                      </button>

                      <button
                        type="button"
                        disabled={busy || Boolean(doneLabel) || (kind !== "modpack" && !targetInstance)}
                        onClick={() => handleQuickInstall(hit)}
                        className={`h-8 ${
                          kind === "modpack" ? "w-[144px]" : "w-[122px]"
                        } px-2.5 rounded-[8px] text-[13px] font-medium flex items-center justify-center gap-1.5 transition-colors duration-150 shrink-0 ${
                          doneLabel
                            ? "bg-[#4cc38a]/15 text-[#4cc38a] border border-[#4cc38a]/25 cursor-default"
                            : "mono-btn-primary disabled:opacity-50"
                        }`}
                      >
                        {doneLabel ? (
                          <>
                            <Check size={14} strokeWidth={1.5} className="shrink-0" />
                            <span className="truncate">{doneLabel}</span>
                          </>
                        ) : (
                          <>
                            {busy ? (
                              <Loader2 size={14} strokeWidth={1.75} className="animate-spin shrink-0" />
                            ) : (
                              <Download size={14} strokeWidth={1.5} className="shrink-0" />
                            )}
                            <span className="truncate">
                              {busy
                                ? t.installing
                                : kind === "modpack"
                                  ? t.createFromPack
                                  : t.install}
                            </span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div ref={sentinelRef} className="py-6 flex items-center justify-center">
              {hasMore ? (
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => fetchPage(hits.length, true)}
                  className="mono-btn-secondary h-9 px-4 rounded-[8px] text-[13px] disabled:opacity-50"
                >
                  {loadingMore ? t.loadingMore : t.loadMore}
                </button>
              ) : (
                <span className="font-mono text-[12px] text-[#85858b]">
                  {t.shownCount}: {hits.length}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom selection bar for batch install */}
      {kind !== "modpack" && selectedList.length > 0 && (
        <div className="px-8 py-3 border-t border-[#ededed]/[0.1] bg-[#19191b] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[13px] font-medium text-[#ededed]">
              {t.selectedCount.replace("{count}", String(selectedList.length))}
            </span>
            {targetInstance && (
              <span className="font-mono text-[12px] text-[#85858b] truncate">
                → {targetInstance.name} ({targetInstance.mcVersion})
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setSelectedMap({})}
              className="mono-btn-secondary h-8 px-3 rounded-[8px] text-[13px] text-[#a1a1a6] hover:text-[#ededed]"
            >
              {t.clearSelection}
            </button>
            <button
              type="button"
              disabled={!targetInstance}
              onClick={openBatchConfirm}
              className="mono-btn-primary h-8 px-3.5 rounded-[8px] text-[13px] font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Download size={14} strokeWidth={1.6} />
              <span>{t.installSelected}</span>
            </button>
          </div>
        </div>
      )}

      {/* Batch Confirmation Modal */}
      {batchModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4 mono-backdrop-enter"
          onClick={() => !batchInstalling && setBatchModalOpen(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[82vh] rounded-[16px] bg-[#19191b] border border-[#ededed]/[0.1] flex flex-col overflow-hidden mono-modal-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[#ededed]/[0.08] flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-[16px] font-medium text-[#ededed]">{t.confirmBatchTitle}</h2>
                {targetInstance && (
                  <p className="text-[12px] text-[#85858b] mt-0.5 truncate">
                    {t.confirmBatchHint.replace("{instance}", targetInstance.name)}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={Boolean(batchInstalling)}
                onClick={() => setBatchModalOpen(false)}
                className="w-8 h-8 rounded-[8px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06]"
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>

            {batchError && (
              <div className="px-6 py-2.5 bg-[#e5484d]/10 border-b border-[#e5484d]/25 text-[13px] text-[#e5484d]">
                {batchError}
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {batchResolving ? (
                <div className="py-14 flex flex-col items-center justify-center gap-3 text-[13px] text-[#85858b]">
                  <Loader2 size={20} strokeWidth={1.75} className="animate-spin text-[#ededed]" />
                  <span>{t.checkingDependencies}</span>
                </div>
              ) : batchFiles.length === 0 ? (
                <div className="py-12 text-center text-[13px] text-[#85858b]">
                  {t.batchNothingToInstall}
                </div>
              ) : (
                (() => {
                  const primary = batchFiles.filter((f) => !f.isDependency);
                  const deps = batchFiles.filter((f) => f.isDependency);
                  const renderRow = (f: ResolvedBatchFile) => {
                    const fk = batchFileKey(f);
                    const checked = Boolean(batchChecked[fk]);
                    const folderLabel =
                      f.projectType === "resourcepack"
                        ? "resourcepacks"
                        : f.projectType === "shader"
                          ? "shaderpacks"
                          : "mods";
                    return (
                      <div
                        key={fk}
                        className="px-3.5 py-2.5 flex items-center justify-between gap-3 hover:bg-[#ededed]/[0.02]"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={checked}
                            disabled={Boolean(f.error) || Boolean(batchInstalling)}
                            onClick={() =>
                              setBatchChecked((prev) => ({ ...prev, [fk]: !prev[fk] }))
                            }
                            className={`w-4 h-4 rounded-[4px] border flex items-center justify-center shrink-0 transition-colors disabled:opacity-35 ${
                              checked
                                ? "bg-[#ededed] border-[#ededed] text-[#0f0f10]"
                                : "bg-[#141415] border-[#ededed]/[0.2]"
                            }`}
                          >
                            {checked && <Check size={11} strokeWidth={2.5} />}
                          </button>

                          {f.iconUrl ? (
                            <img
                              src={f.iconUrl}
                              alt=""
                              className="w-8 h-8 rounded-[6px] bg-[#232325] object-cover shrink-0"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-[6px] bg-[#232325] flex items-center justify-center shrink-0">
                              <Package size={14} strokeWidth={1.5} className="text-[#85858b]" />
                            </div>
                          )}

                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[13px] font-medium text-[#ededed] truncate">
                                {f.title}
                              </span>
                              {f.alreadyInstalled && !f.error && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded-[4px] bg-[#ededed]/[0.08] text-[#a1a1a6] shrink-0">
                                  {t.batchAlreadyInstalled}
                                </span>
                              )}
                              {f.requiredBy && (
                                <span className="text-[11px] text-[#85858b] truncate">
                                  {t.batchRequiredBy.replace("{name}", f.requiredBy)}
                                </span>
                              )}
                            </div>

                            {f.error ? (
                              <div className="text-[12px] text-[#e5484d] flex items-center gap-1 mt-0.5">
                                <AlertCircle size={12} strokeWidth={1.6} className="shrink-0" />
                                <span className="truncate">{f.error}</span>
                              </div>
                            ) : (
                              <div className="font-mono text-[11px] text-[#85858b] truncate mt-0.5">
                                {f.filename} · {folderLabel}
                                {f.fileSize ? ` · ${formatBytes(f.fileSize)}` : ""}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  };

                  return (
                    <>
                      {primary.length > 0 && (
                        <div>
                          <div className="text-[12px] font-medium text-[#85858b] mb-2">
                            {t.batchSelectedSection} ({primary.length})
                          </div>
                          <div className="rounded-[10px] border border-[#ededed]/[0.08] bg-[#141415] divide-y divide-[#ededed]/[0.06]">
                            {primary.map(renderRow)}
                          </div>
                        </div>
                      )}

                      {deps.length > 0 && (
                        <div>
                          <div className="text-[12px] font-medium text-[#85858b] mb-2">
                            {t.batchDepsSection} ({deps.length})
                          </div>
                          <div className="rounded-[10px] border border-[#ededed]/[0.08] bg-[#141415] divide-y divide-[#ededed]/[0.06]">
                            {deps.map(renderRow)}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()
              )}
            </div>

            <div className="px-6 py-4 border-t border-[#ededed]/[0.08] flex items-center justify-between gap-4 bg-[#141415]/60">
              <div className="text-[12px] text-[#85858b] font-mono">
                {batchInstalling
                  ? t.batchInstallingProgress
                      .replace("{current}", String(batchInstalling.current))
                      .replace("{total}", String(batchInstalling.total))
                  : (() => {
                      const active = batchFiles.filter(
                        (f) => !f.error && batchChecked[batchFileKey(f)]
                      );
                      const totalBytes = active.reduce((acc, f) => acc + f.fileSize, 0);
                      return totalBytes > 0 ? formatBytes(totalBytes) : "";
                    })()}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={Boolean(batchInstalling)}
                  onClick={() => setBatchModalOpen(false)}
                  className="mono-btn-secondary h-9 px-4 rounded-[8px] text-[13px] disabled:opacity-50"
                >
                  {t.cancel}
                </button>
                <button
                  type="button"
                  disabled={
                    batchResolving ||
                    Boolean(batchInstalling) ||
                    batchFiles.filter((f) => !f.error && batchChecked[batchFileKey(f)]).length === 0
                  }
                  onClick={handleConfirmBatchInstall}
                  className="mono-btn-primary h-9 px-4 rounded-[8px] text-[13px] font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  {batchInstalling ? (
                    <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
                  ) : (
                    <Download size={14} strokeWidth={1.6} />
                  )}
                  <span>
                    {t.batchInstallBtn.replace(
                      "{count}",
                      String(
                        batchFiles.filter((f) => !f.error && batchChecked[batchFileKey(f)]).length
                      )
                    )}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Version Picker Modal */}
      {versionsHit && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4 mono-backdrop-enter"
          onClick={() => setVersionsHit(null)}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] rounded-[16px] bg-[#19191b] border border-[#ededed]/[0.1] flex flex-col overflow-hidden mono-modal-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[#ededed]/[0.08] flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                {versionsHit.iconUrl && (
                  <img
                    src={versionsHit.iconUrl}
                    alt={versionsHit.title}
                    className="w-8 h-8 rounded-[8px] bg-[#232325] shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <h2 className="text-[16px] font-medium text-[#ededed] truncate">
                    {versionsHit.title} — {t.versionsModalTitle}
                  </h2>
                  {kind !== "modpack" && targetInstance && (
                    <div className="font-mono text-[12px] text-[#85858b]">
                      {targetInstance.name} ({targetInstance.mcVersion} · {targetInstance.loader})
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => api.openExternalUrl(versionsHit.websiteUrl)}
                  className="mono-btn-secondary h-8 px-2.5 rounded-[8px] flex items-center gap-1.5 text-[12px]"
                >
                  <ExternalLink size={13} strokeWidth={1.5} />
                  <span>{t.openWebsite}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setVersionsHit(null)}
                  className="w-8 h-8 rounded-[8px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06]"
                >
                  <X size={16} strokeWidth={1.5} />
                </button>
              </div>
            </div>

            {kind !== "modpack" && (
              <div className="px-6 py-3 border-b border-[#ededed]/[0.06] flex flex-wrap items-center justify-between gap-4 bg-[#141415]/60">
                <Checkbox checked={onlyCompatible} onChange={setOnlyCompatible} label={t.onlyCompatible} />

                <Checkbox checked={installDeps} onChange={setInstallDeps} label={t.installDependencies} />
              </div>
            )}

            <div className="flex-1 overflow-y-auto divide-y divide-[#ededed]/[0.06]">
              {versionsLoading ? (
                <div className="p-8 text-center text-[13px] text-[#85858b]">
                  {t.loadingMore}
                </div>
              ) : displayedVersions.length === 0 ? (
                <div className="p-8 text-center text-[13px] text-[#85858b]">{t.noResults}</div>
              ) : (
                displayedVersions.map((ver) => {
                  const reqCount = ver.dependencies.filter(
                    (d) => d.dependencyType === "required"
                  ).length;
                  const busy = installingVersionId === ver.id;
                  return (
                    <div
                      key={ver.id}
                      className="px-6 py-3 flex items-center justify-between gap-4 hover:bg-[#ededed]/[0.02]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium text-[#ededed] truncate">
                            {ver.versionNumber}
                          </span>
                          {kind !== "modpack" && (
                            <span
                              className={`text-[11px] font-mono px-1.5 py-0.5 rounded-[4px] ${
                                ver.compatible
                                  ? "bg-[#4cc38a]/15 text-[#4cc38a]"
                                  : "bg-[#e5484d]/15 text-[#e5484d]"
                              }`}
                            >
                              {ver.compatible ? t.compatible : t.incompatible}
                            </span>
                          )}
                          <span className="font-mono text-[11px] text-[#85858b]">
                            {ver.versionType}
                          </span>
                          {reqCount > 0 && (
                            <span className="font-mono text-[11px] text-[#85858b]">
                              +{reqCount} {t.depsRequired}
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[12px] text-[#85858b] truncate mt-0.5">
                          {ver.gameVersions.slice(0, 4).join(", ")}
                          {ver.loaders.length > 0 ? ` · ${ver.loaders.join(", ")}` : ""}
                          {ver.fileSize ? ` · ${formatBytes(ver.fileSize)}` : ""}
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={busy || (kind !== "modpack" && !targetInstance)}
                        onClick={() => handleInstallSpecificVersion(ver)}
                        className={`h-8 px-3 rounded-[8px] text-[12px] font-medium shrink-0 disabled:opacity-50 ${
                          kind === "modpack" || ver.compatible ? "mono-btn-primary" : "mono-btn-secondary"
                        }`}
                      >
                        {busy
                          ? t.installing
                          : kind === "modpack"
                            ? t.createFromPack
                            : t.install}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
