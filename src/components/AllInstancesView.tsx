import { useMemo, useState } from "react";
import {
  FolderOpen,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Square,
  Star,
  Trash2,
} from "lucide-react";
import type { Dict } from "../i18n";
import type { Instance, InstanceRuntimeStatus } from "../types";

type FilterKind = "all" | "favorites" | "java" | "rust";

interface AllInstancesViewProps {
  t: Dict;
  instances: Instance[];
  statuses: Record<string, InstanceRuntimeStatus>;
  onSelectInstance: (id: string, initialTab?: "mod" | "console" | "settings") => void;
  onLaunchInstance: (id: string) => void;
  onStopInstance: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onOpenInstanceFolder: (id: string) => void;
  onDeleteInstance: (id: string) => void;
  onCreateInstance: () => void;
}

function formatLoader(inst: Instance): string {
  if (inst.edition === "rust") return "Rust Edition";
  switch (inst.loader) {
    case "fabric":
      return "Fabric";
    case "quilt":
      return "Quilt";
    case "forge":
      return "Forge";
    case "neoforge":
      return "NeoForge";
    case "custom":
      return "Custom";
    default:
      return "Vanilla";
  }
}

function formatPlayTime(sec: number, t: Dict): string {
  if (sec < 60) return `0 ${t.minutesShort}`;
  const mins = Math.floor(sec / 60);
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs === 0) return `${rem} ${t.minutesShort}`;
  return `${hrs}${t.hoursShort} ${rem}${t.minutesShort}`;
}

function formatLastPlayed(iso: string | null, t: Dict): string {
  if (!iso) return t.never;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t.never;
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AllInstancesView({
  t,
  instances,
  statuses,
  onSelectInstance,
  onLaunchInstance,
  onStopInstance,
  onToggleFavorite,
  onOpenInstanceFolder,
  onDeleteInstance,
  onCreateInstance,
}: AllInstancesViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const hasRust = instances.some((i) => i.edition === "rust");
  const hasFavs = instances.some((i) => i.favorite);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return instances.filter((inst) => {
      if (filter === "favorites" && !inst.favorite) return false;
      if (filter === "rust" && inst.edition !== "rust") return false;
      if (filter === "java" && inst.edition === "rust") return false;
      if (!q) return true;
      return (
        inst.name.toLowerCase().includes(q) ||
        inst.mcVersion.toLowerCase().includes(q) ||
        formatLoader(inst).toLowerCase().includes(q)
      );
    });
  }, [instances, query, filter]);

  const filterTabs: [FilterKind, string][] = [
    ["all", t.filterAll],
    ...(hasFavs ? ([["favorites", t.favorites]] as [FilterKind, string][]) : []),
    ...(hasRust
      ? ([
          ["java", t.editionJava],
          ["rust", t.editionRust],
        ] as [FilterKind, string][])
      : []),
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#141415] mono-view-enter">
      {/* Header */}
      <div className="px-8 pt-6 pb-5 border-b border-[#ededed]/[0.08]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h1 className="text-[28px] leading-8 font-medium tracking-[-0.02em] text-[#ededed]">
              {t.allInstances}
            </h1>
            <span className="font-mono text-[13px] text-[#85858b]">{instances.length}</span>
          </div>

          <button
            type="button"
            onClick={onCreateInstance}
            className="mono-btn-primary h-9 px-3.5 rounded-[8px] text-[13px] font-medium flex items-center gap-1.5"
          >
            <Plus size={15} strokeWidth={1.75} />
            <span>{t.newInstance}</span>
          </button>
        </div>

        {instances.length > 0 && (
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
                placeholder={t.searchInstances}
                className="w-full h-9 pl-9 pr-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] text-[14px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
              />
            </div>

            {filterTabs.length > 1 && (
              <div className="flex items-center gap-1 p-1 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08]">
                {filterTabs.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFilter(id)}
                    className={`h-7 px-3 rounded-[6px] text-[13px] transition-colors duration-150 ${
                      filter === id
                        ? "bg-[#232325] text-[#ededed] font-medium"
                        : "text-[#85858b] hover:text-[#a1a1a6]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {instances.length === 0 ? (
          <div className="max-w-md mx-auto py-16 text-center">
            <p className="text-[15px] font-medium text-[#ededed]">{t.noInstancesYet}</p>
            <p className="text-[13px] text-[#85858b] mt-1">{t.selectOrCreate}</p>
            <button
              type="button"
              onClick={onCreateInstance}
              className="mono-btn-primary mt-5 h-9 px-4 rounded-[8px] inline-flex items-center gap-2 text-[14px] font-medium"
            >
              <Plus size={15} strokeWidth={1.75} />
              <span>{t.createFirst}</span>
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-[14px] text-[#85858b]">
            {t.noMatchingInstances}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5 max-w-6xl">
            {filtered.map((inst) => {
              const st = statuses[inst.id] ?? "idle";
              const isRunning = st === "running";
              const isLaunching = st === "launching";
              const isConfirmDelete = confirmDeleteId === inst.id;

              return (
                <div
                  key={inst.id}
                  onClick={() => onSelectInstance(inst.id)}
                  onMouseLeave={() => {
                    if (confirmDeleteId === inst.id) setConfirmDeleteId(null);
                  }}
                  className="group rounded-[12px] bg-[#19191b] border border-[#ededed]/[0.08] hover:border-[#ededed]/[0.16] hover:bg-[#1d1d20] flex flex-col justify-between overflow-hidden cursor-pointer transition-colors duration-150"
                >
                  <div className="p-4 flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      {inst.iconUrl ? (
                        <img
                          src={inst.iconUrl}
                          alt=""
                          className="w-11 h-11 rounded-[10px] bg-[#232325] object-cover shrink-0"
                        />
                      ) : (
                        <div className="w-11 h-11 rounded-[10px] bg-[#232325] border border-[#ededed]/[0.06] flex items-center justify-center shrink-0 font-mono text-[15px] text-[#85858b]">
                          {inst.name.trim().charAt(0).toUpperCase() || "M"}
                        </div>
                      )}

                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[15px] font-medium text-[#ededed] truncate">
                            {inst.name}
                          </span>
                          {st !== "idle" && (
                            <span
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                isRunning
                                  ? "bg-[#4cc38a]"
                                  : st === "crashed"
                                    ? "bg-[#e5484d]"
                                    : "bg-[#ededed]/70"
                              }`}
                            />
                          )}
                        </div>
                        <div className="font-mono text-[12px] text-[#a1a1a6] truncate mt-1">
                          {inst.mcVersion} · {formatLoader(inst)}
                          {inst.loaderVersion && inst.edition !== "rust"
                            ? ` ${inst.loaderVersion}`
                            : ""}
                        </div>
                        <div className="font-mono text-[11px] text-[#85858b] truncate mt-1">
                          {t.playTime}: {formatPlayTime(inst.playTimeSec, t)} ·{" "}
                          {formatLastPlayed(inst.lastPlayed, t)}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      title={inst.favorite ? t.ctxFavoriteRemove : t.ctxFavoriteAdd}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite(inst.id);
                      }}
                      className={`w-7 h-7 -mr-1 -mt-0.5 rounded-[6px] flex items-center justify-center shrink-0 transition-colors ${
                        inst.favorite
                          ? "text-[#d4a054] hover:bg-[#ededed]/[0.06]"
                          : "text-[#85858b]/60 hover:text-[#ededed] hover:bg-[#ededed]/[0.06]"
                      }`}
                    >
                      <Star
                        size={14}
                        strokeWidth={1.6}
                        className={inst.favorite ? "fill-[#d4a054]" : ""}
                      />
                    </button>
                  </div>

                  <div className="px-4 py-2.5 border-t border-[#ededed]/[0.06] bg-[#141415]/40 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        title={t.ctxOpenFolder}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenInstanceFolder(inst.id);
                        }}
                        className="mono-btn-secondary w-8 h-8 rounded-[7px] flex items-center justify-center text-[#85858b] hover:text-[#ededed]"
                      >
                        <FolderOpen size={14} strokeWidth={1.5} />
                      </button>

                      <button
                        type="button"
                        title={t.ctxSettings}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectInstance(inst.id, "settings");
                        }}
                        className="mono-btn-secondary w-8 h-8 rounded-[7px] flex items-center justify-center text-[#85858b] hover:text-[#ededed]"
                      >
                        <SlidersHorizontal size={14} strokeWidth={1.5} />
                      </button>

                      <button
                        type="button"
                        title={isConfirmDelete ? t.ctxDeleteConfirm : t.ctxDelete}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!isConfirmDelete) {
                            setConfirmDeleteId(inst.id);
                            return;
                          }
                          setConfirmDeleteId(null);
                          onDeleteInstance(inst.id);
                        }}
                        className={`h-8 rounded-[7px] flex items-center justify-center gap-1.5 transition-colors ${
                          isConfirmDelete
                            ? "px-2.5 bg-[#e5484d]/20 border border-[#e5484d]/30 text-[#e5484d] text-[12px] leading-none font-medium"
                            : "mono-btn-secondary w-8 text-[#85858b] hover:text-[#e5484d] hover:!border-[#e5484d]/30 hover:!bg-[#e5484d]/10"
                        }`}
                      >
                        <Trash2 size={14} strokeWidth={1.5} />
                        {isConfirmDelete && <span>{t.ctxDeleteConfirm}</span>}
                      </button>
                    </div>

                    {isRunning ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStopInstance(inst.id);
                        }}
                        className="h-8 px-3.5 rounded-[7px] bg-[#e5484d]/15 text-[#e5484d] border border-[#e5484d]/30 hover:bg-[#e5484d]/25 transition-colors inline-flex items-center justify-center gap-1.5 text-[13px] leading-none font-medium"
                      >
                        <Square size={12} strokeWidth={1.5} fill="currentColor" className="shrink-0" />
                        <span>{t.stop}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isLaunching}
                        onClick={(e) => {
                          e.stopPropagation();
                          onLaunchInstance(inst.id);
                        }}
                        className="mono-btn-primary h-8 px-3.5 rounded-[7px] inline-flex items-center justify-center gap-1.5 text-[13px] leading-none font-medium disabled:opacity-60"
                      >
                        <Play size={12} strokeWidth={1.75} fill="currentColor" className="shrink-0" />
                        <span>{isLaunching ? t.launching : t.play}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
