import { useEffect, useState } from "react";
import { Check, ExternalLink, FolderOpen, Loader2, RefreshCw, X } from "lucide-react";
import type { Dict } from "../i18n";
import { api } from "../lib/api";
import type { PackProgressEvent, PendingDownload } from "../types";

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindBadge(targetDir: string, t: Dict): string {
  if (targetDir === "shaderpacks") return t.typeShader;
  if (targetDir === "resourcepacks") return t.typeResourcepack;
  return t.typeMod;
}

interface PackProgressTrayProps {
  t: Dict;
  tasks: PackProgressEvent[];
  onDismiss: (taskId: string) => void;
}

export function PackProgressTray({ t, tasks, onDismiss }: PackProgressTrayProps) {
  if (tasks.length === 0) return null;

  const stageLabel = (ev: PackProgressEvent): string => {
    switch (ev.stage) {
      case "prepare":
        return t.packStagePrepare;
      case "download-pack":
        return ev.total > 0
          ? `${t.packStageDownload} · ${formatBytes(ev.current)} / ${formatBytes(ev.total)}`
          : t.packStageDownload;
      case "files":
        return ev.total > 0
          ? `${t.packStageFiles} · ${ev.current} / ${ev.total}`
          : t.packStageFiles;
      case "overrides":
        return t.packStageOverrides;
      case "done":
        return t.packStageDone;
      case "error":
        return t.packStageError;
      default:
        return ev.stage;
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 space-y-2 pointer-events-none">
      {tasks.map((ev) => {
        const isDone = ev.stage === "done";
        const isError = ev.stage === "error";
        const pct =
          ev.total > 0
            ? Math.min(100, Math.round((ev.current / ev.total) * 100))
            : isDone
              ? 100
              : null;

        return (
          <div
            key={ev.taskId}
            className="pointer-events-auto rounded-[12px] bg-[#19191b] border border-[#ededed]/[0.12] shadow-[0_12px_32px_rgba(0,0,0,0.55)] p-3.5 mono-select-enter"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {isDone ? (
                  <Check size={14} strokeWidth={2} className="shrink-0 text-[#4cc38a]" />
                ) : isError ? (
                  <X size={14} strokeWidth={2} className="shrink-0 text-[#e5484d]" />
                ) : (
                  <Loader2
                    size={14}
                    strokeWidth={1.75}
                    className="shrink-0 text-[#ededed] animate-spin"
                  />
                )}
                <span className="text-[13px] font-medium text-[#ededed] truncate">
                  {ev.title}
                </span>
              </div>

              {(isDone || isError) && (
                <button
                  type="button"
                  onClick={() => onDismiss(ev.taskId)}
                  className="w-6 h-6 rounded-[6px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06] shrink-0"
                >
                  <X size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>

            <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px]">
              <span className={isError ? "text-[#e5484d] truncate" : "text-[#a1a1a6] truncate"}>
                {isError && ev.message ? ev.message : stageLabel(ev)}
              </span>
              {pct !== null && !isError && (
                <span className="font-mono text-[11px] text-[#85858b] shrink-0">{pct}%</span>
              )}
            </div>

            {ev.stage === "files" && ev.message && (
              <div className="mt-0.5 font-mono text-[11px] text-[#85858b] truncate">
                {ev.message}
              </div>
            )}

            {!isError && (
              <div className="mt-2.5 h-1.5 rounded-full bg-[#232325] overflow-hidden">
                {pct !== null ? (
                  <div
                    className={`h-full rounded-full transition-[width] duration-200 ${
                      isDone ? "bg-[#4cc38a]" : "bg-[#ededed]"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                ) : (
                  <div className="mono-skel h-full w-full rounded-full" />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface PendingDownloadsModalProps {
  t: Dict;
  instanceId: string;
  instanceName: string;
  items: PendingDownload[];
  onUpdated: (remaining: PendingDownload[]) => void;
  onClose: () => void;
}

export function PendingDownloadsModal({
  t,
  instanceId,
  instanceName,
  items,
  onUpdated,
  onClose,
}: PendingDownloadsModalProps) {
  const [checking, setChecking] = useState(false);
  const [openedIds, setOpenedIds] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Auto-watch the user's Downloads folder while this dialog is open
  useEffect(() => {
    if (items.length === 0) return;
    const timer = setInterval(async () => {
      try {
        const rem = await api.resolvePendingDownloads(instanceId);
        if (rem.length !== items.length) {
          onUpdated(rem);
          if (rem.length === 0) onClose();
        }
      } catch {
        // ignore background poll errors
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [instanceId, items.length, onUpdated, onClose]);

  const handleOpenOne = async (item: PendingDownload) => {
    setOpenedIds((prev) => ({ ...prev, [item.fileId]: true }));
    await api.openExternalUrl(item.pageUrl);
  };

  const handleOpenAll = async () => {
    const next: Record<string, boolean> = {};
    for (const it of items) next[it.fileId] = true;
    setOpenedIds((prev) => ({ ...prev, ...next }));
    for (const it of items) {
      await api.openExternalUrl(it.pageUrl);
      await new Promise((r) => setTimeout(r, 180));
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const rem = await api.resolvePendingDownloads(instanceId);
      onUpdated(rem);
      if (rem.length === 0) onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  const handlePickFiles = async () => {
    setError(null);
    const paths = await api.pickPendingFiles(t.pendingPickFiles);
    if (paths.length === 0) return;
    setChecking(true);
    try {
      const rem = await api.resolvePendingDownloads(instanceId, paths);
      onUpdated(rem);
      if (rem.length === 0) onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4 mono-backdrop-enter"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[82vh] rounded-[16px] bg-[#19191b] border border-[#ededed]/[0.1] flex flex-col overflow-hidden mono-modal-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[#ededed]/[0.08] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-medium text-[#ededed] truncate">
              {t.pendingTitle} · {instanceName}
            </h2>
            <p className="text-[12px] text-[#85858b] mt-0.5 font-mono">
              {items.length}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-[8px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06] shrink-0"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="px-6 py-3.5 border-b border-[#ededed]/[0.06] bg-[#141415]/60">
          <p className="text-[13px] leading-[19px] text-[#a1a1a6]">{t.pendingHint}</p>
          {error && <div className="mt-2 text-[12px] text-[#e5484d]">{error}</div>}
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-[#ededed]/[0.06]">
          {items.map((it) => {
            const opened = Boolean(openedIds[it.fileId]);
            return (
              <div
                key={`${it.projectId}:${it.fileId}`}
                className="px-6 py-3 flex items-center justify-between gap-4 hover:bg-[#ededed]/[0.02]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-[#ededed] truncate">
                      {it.displayName}
                    </span>
                    <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-[4px] bg-[#232325] text-[#a1a1a6] shrink-0">
                      {kindBadge(it.targetDir, t)}
                    </span>
                  </div>
                  <div className="font-mono text-[12px] text-[#85858b] truncate mt-0.5">
                    {it.fileName}
                    {it.size ? ` · ${formatBytes(it.size)}` : ""}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleOpenOne(it)}
                  className={`h-8 px-3 rounded-[8px] text-[12px] flex items-center gap-1.5 shrink-0 ${
                    opened ? "mono-btn-secondary" : "mono-btn-primary font-medium"
                  }`}
                >
                  <ExternalLink size={13} strokeWidth={1.5} />
                  <span>{t.openWebsite}</span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="px-6 py-3.5 border-t border-[#ededed]/[0.08] flex flex-wrap items-center justify-between gap-2 bg-[#141415]/40">
          <button
            type="button"
            onClick={onClose}
            className="mono-btn-secondary h-9 px-3.5 rounded-[8px] text-[13px]"
          >
            {t.pendingSkip}
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePickFiles}
              disabled={checking}
              className="mono-btn-secondary h-9 px-3.5 rounded-[8px] flex items-center gap-1.5 text-[13px] disabled:opacity-50"
            >
              <FolderOpen size={14} strokeWidth={1.5} />
              <span>{t.pendingPickFiles}</span>
            </button>

            <button
              type="button"
              onClick={handleCheck}
              disabled={checking}
              className="mono-btn-secondary h-9 px-3.5 rounded-[8px] flex items-center gap-1.5 text-[13px] disabled:opacity-50"
            >
              <RefreshCw
                size={14}
                strokeWidth={1.5}
                className={checking ? "animate-spin" : ""}
              />
              <span>{t.pendingCheckDownloads}</span>
            </button>

            <button
              type="button"
              onClick={handleOpenAll}
              className="mono-btn-primary h-9 px-4 rounded-[8px] flex items-center gap-1.5 text-[13px] font-medium"
            >
              <ExternalLink size={14} strokeWidth={1.5} />
              <span>{t.pendingOpenAll}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
