import { useEffect, useRef, useState } from "react";
import { ExternalLink, FolderOpen, Globe, Image as ImageIcon, Play, Trash2, X } from "lucide-react";
import type { Dict } from "../i18n";
import { api } from "../lib/api";
import type { InstanceRuntimeStatus, ScreenshotInfo, WorldInfo } from "../types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateShort(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function supportsQuickPlay(mcVersion: string): boolean {
  const parts = mcVersion
    .split(".")
    .map((p) => parseInt(p, 10))
    .filter((n) => !Number.isNaN(n));
  if (parts.length > 0) {
    if (parts[0] >= 26) return true;
    if (parts[0] === 1) return (parts[1] ?? 0) >= 20;
  }
  const snap = mcVersion.match(/^(\d+)w/);
  if (snap) return parseInt(snap[1], 10) >= 23;
  return false;
}

interface WorldsTabProps {
  t: Dict;
  instanceId: string;
  mcVersion: string;
  status: InstanceRuntimeStatus;
  onQuickPlay: (folderName: string) => void;
}

export function WorldsTab({
  t,
  instanceId,
  mcVersion,
  status,
  onQuickPlay,
}: WorldsTabProps) {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null);
  const canQuickPlay = supportsQuickPlay(mcVersion);
  const canLaunch = status === "idle" || status === "crashed";

  const reload = () => {
    api.listWorlds(instanceId).then(setWorlds).catch(() => {});
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  if (worlds.length === 0) {
    return (
      <div className="max-w-4xl py-16 text-center rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b]/50">
        <p className="text-[14px] text-[#ededed]">{t.emptyWorlds}</p>
        <p className="text-[13px] text-[#85858b] mt-1">{t.emptyWorldsHint}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] divide-y divide-[#ededed]/[0.06]">
      {worlds.map((w) => {
        const confirming = confirmFolder === w.folderName;
        const played = formatDateShort(w.lastPlayed);
        return (
          <div
            key={w.folderName}
            className="p-4 flex items-center justify-between gap-4 hover:bg-[#ededed]/[0.02] transition-colors duration-150"
          >
            <div className="flex items-center gap-3.5 min-w-0">
              {w.iconDataUrl ? (
                <img
                  src={w.iconDataUrl}
                  alt={w.displayName}
                  className="w-11 h-11 rounded-[8px] bg-[#232325] object-cover shrink-0"
                />
              ) : (
                <div className="w-11 h-11 rounded-[8px] bg-[#232325] flex items-center justify-center shrink-0">
                  <Globe size={18} strokeWidth={1.5} className="text-[#85858b]" />
                </div>
              )}

              <div className="min-w-0">
                <div className="text-[14px] font-medium text-[#ededed] truncate">
                  {w.displayName}
                </div>
                <div className="font-mono text-[12px] text-[#85858b] truncate mt-0.5">
                  {w.folderName} · {formatBytes(w.sizeBytes)}
                  {played ? ` · ${played}` : ""}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => api.openWorldFolder(instanceId, w.folderName)}
                title={t.openFolder}
                className="mono-btn-secondary w-8 h-8 rounded-[8px] flex items-center justify-center text-[#85858b] hover:text-[#ededed]"
              >
                <FolderOpen size={14} strokeWidth={1.5} />
              </button>

              <button
                type="button"
                onClick={async () => {
                  if (!confirming) {
                    setConfirmFolder(w.folderName);
                    return;
                  }
                  setConfirmFolder(null);
                  await api.deleteWorld(instanceId, w.folderName);
                  reload();
                }}
                onMouseLeave={() => {
                  if (confirming) setConfirmFolder(null);
                }}
                title={t.ctxDelete}
                className={`h-8 rounded-[8px] flex items-center justify-center gap-1.5 text-[12px] transition-colors ${
                  confirming
                    ? "px-2.5 bg-[#e5484d]/20 text-[#e5484d] border border-[#e5484d]/30 font-medium"
                    : "w-8 mono-btn-secondary text-[#85858b] hover:text-[#e5484d]"
                }`}
              >
                <Trash2 size={14} strokeWidth={1.5} />
                {confirming && <span>{t.deleteWorldConfirm}</span>}
              </button>

              {canQuickPlay && (
                <button
                  type="button"
                  disabled={!canLaunch}
                  onClick={() => onQuickPlay(w.folderName)}
                  className="mono-btn-primary h-8 px-3 rounded-[8px] flex items-center gap-1.5 text-[12px] font-medium disabled:opacity-50"
                >
                  <Play size={12} strokeWidth={1.75} fill="currentColor" />
                  <span>{t.playInWorld}</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface ScreenshotCardProps {
  instanceId: string;
  item: ScreenshotInfo;
  onSelect: (item: ScreenshotInfo, dataUrl: string) => void;
  onDelete: (filename: string) => void;
}

function ScreenshotCard({ instanceId, item, onSelect, onDelete }: ScreenshotCardProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let alive = true;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          obs.disconnect();
          api
            .getScreenshotData(instanceId, item.filename)
            .then((url) => {
              if (alive) setDataUrl(url);
            })
            .catch(() => {});
        }
      },
      { rootMargin: "200px" }
    );
    obs.observe(node);
    return () => {
      alive = false;
      obs.disconnect();
    };
  }, [instanceId, item.filename]);

  return (
    <div
      ref={ref}
      onClick={() => dataUrl && onSelect(item, dataUrl)}
      className="group rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] overflow-hidden cursor-pointer hover:border-[#ededed]/[0.18] transition-colors"
    >
      <div className="aspect-video bg-[#141415] relative flex items-center justify-center overflow-hidden">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={item.filename}
            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
          />
        ) : (
          <ImageIcon size={20} strokeWidth={1.5} className="text-[#85858b]/60" />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(item.filename);
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-2 right-2 w-7 h-7 rounded-[6px] bg-black/70 text-[#ededed] hover:text-[#e5484d] flex items-center justify-center"
        >
          <Trash2 size={13} strokeWidth={1.5} />
        </button>
      </div>
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-[#a1a1a6] truncate">{item.filename}</span>
        <span className="font-mono text-[11px] text-[#85858b] shrink-0">
          {formatBytes(item.sizeBytes)}
        </span>
      </div>
    </div>
  );
}

interface ScreenshotsTabProps {
  t: Dict;
  instanceId: string;
}

export function ScreenshotsTab({ t, instanceId }: ScreenshotsTabProps) {
  const [items, setItems] = useState<ScreenshotInfo[]>([]);
  const [preview, setPreview] = useState<{ item: ScreenshotInfo; url: string } | null>(null);

  const reload = () => {
    api.listScreenshots(instanceId).then(setItems).catch(() => {});
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  const handleDelete = async (filename: string) => {
    await api.deleteScreenshot(instanceId, filename);
    if (preview?.item.filename === filename) setPreview(null);
    reload();
  };

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-end mb-4">
        <button
          type="button"
          onClick={() => api.openScreenshotsFolder(instanceId)}
          className="mono-btn-secondary h-9 px-3.5 rounded-[8px] flex items-center gap-2 text-[13px]"
        >
          <FolderOpen size={15} strokeWidth={1.5} className="text-[#a1a1a6]" />
          <span>{t.openFolder}</span>
        </button>
      </div>

      {items.length === 0 ? (
        <div className="py-16 text-center rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b]/50">
          <p className="text-[14px] text-[#ededed]">{t.emptyScreenshots}</p>
          <p className="text-[13px] text-[#85858b] mt-1">{t.emptyScreenshotsHint}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3.5">
          {items.map((it) => (
            <ScreenshotCard
              key={it.filename}
              instanceId={instanceId}
              item={it}
              onSelect={(item, url) => setPreview({ item, url })}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-[2px] flex items-center justify-center p-6 mono-backdrop-enter"
          onClick={() => setPreview(null)}
        >
          <div
            className="max-w-5xl w-full rounded-[14px] bg-[#19191b] border border-[#ededed]/[0.12] overflow-hidden mono-modal-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-[#ededed]/[0.08] flex items-center justify-between gap-3">
              <span className="font-mono text-[13px] text-[#ededed] truncate">
                {preview.item.filename}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => api.openScreenshot(instanceId, preview.item.filename)}
                  className="mono-btn-secondary h-8 px-2.5 rounded-[8px] flex items-center gap-1.5 text-[12px]"
                >
                  <ExternalLink size={13} strokeWidth={1.5} />
                  <span>{t.openFolder}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(preview.item.filename)}
                  className="mono-btn-secondary w-8 h-8 rounded-[8px] flex items-center justify-center text-[#85858b] hover:text-[#e5484d]"
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="w-8 h-8 rounded-[8px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06]"
                >
                  <X size={16} strokeWidth={1.5} />
                </button>
              </div>
            </div>
            <div className="bg-[#0f0f10] flex items-center justify-center max-h-[78vh]">
              <img
                src={preview.url}
                alt={preview.item.filename}
                className="max-h-[78vh] w-auto object-contain"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
