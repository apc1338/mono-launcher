import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Compass,
  CopyPlus,
  FolderOpen,
  Home,
  Pencil,
  Play,
  Plus,
  Settings,
  SlidersHorizontal,
  Square,
  Star,
  Trash2,
  User,
} from "lucide-react";
import type { Dict } from "../i18n";
import type { Account, Instance, InstanceRuntimeStatus } from "../types";

export type ActiveView =
  | { type: "home" }
  | { type: "instance"; instanceId: string; initialTab?: "mod" | "console" | "settings" }
  | { type: "modrinth"; initialKind?: "mod" | "shader" | "resourcepack" | "modpack"; targetInstanceId?: string }
  | { type: "settings" };

type InstanceGroup = "favorite" | "regular";

interface SidebarProps {
  t: Dict;
  instances: Instance[];
  statuses: Record<string, InstanceRuntimeStatus>;
  activeView: ActiveView;
  activeAccount: Account | null;
  onOpenHome: () => void;
  onSelectInstance: (id: string, initialTab?: "mod" | "console" | "settings") => void;
  onOpenModrinth: () => void;
  onOpenSettings: () => void;
  onOpenCreateModal: () => void;
  onOpenAccountsModal: () => void;
  onLaunchInstance: (id: string) => void;
  onStopInstance: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onRenameInstance: (id: string, newName: string) => void;
  onCloneInstance: (id: string) => void;
  onOpenInstanceFolder: (id: string) => void;
  onDeleteInstance: (id: string) => void;
  onReorderGroup: (group: InstanceGroup, orderedIds: string[]) => void;
}

function formatLoader(loader: Instance["loader"]): string {
  switch (loader) {
    case "fabric":
      return "Fabric";
    case "quilt":
      return "Quilt";
    case "custom":
      return "Custom";
    case "forge":
      return "Forge";
    case "neoforge":
      return "NeoForge";
    default:
      return "Vanilla";
  }
}

export function Sidebar({
  t,
  instances,
  statuses,
  activeView,
  activeAccount,
  onOpenHome,
  onSelectInstance,
  onOpenModrinth,
  onOpenSettings,
  onOpenCreateModal,
  onOpenAccountsModal,
  onLaunchInstance,
  onStopInstance,
  onToggleFavorite,
  onRenameInstance,
  onCloneInstance,
  onOpenInstanceFolder,
  onDeleteInstance,
  onReorderGroup,
}: SidebarProps) {
  const isHome = activeView.type === "home";
  const isModrinth = activeView.type === "modrinth";
  const isSettings = activeView.type === "settings";

  const favorites = instances.filter((i) => i.favorite);
  const regular = instances.filter((i) => !i.favorite);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{
    instanceId: string;
    x: number;
    y: number;
    confirmDelete: boolean;
  } | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelledRef = useRef(false);

  // Pointer-based drag-and-drop state
  const listContainerRef = useRef<HTMLDivElement>(null);
  const dragSessionRef = useRef<{
    id: string;
    group: InstanceGroup;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    active: boolean;
  } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<{
    x: number;
    y: number;
    width: number;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: "before" | "after";
  } | null>(null);
  const dropTargetRef = useRef<{ id: string; position: "before" | "after" } | null>(null);
  const justDraggedRef = useRef(false);

  useLayoutEffect(() => {
    if (!ctxMenu) return;
    const el = menuRef.current;
    const w = el?.offsetWidth ?? 210;
    const h = el?.offsetHeight ?? 280;
    const left = Math.max(8, Math.min(ctxMenu.x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(ctxMenu.y, window.innerHeight - h - 8));
    setMenuPos({ left, top });
  }, [ctxMenu]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    const close = () => setCtxMenu(null);
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
  }, [ctxMenu]);

  useEffect(() => {
    if (renamingId) {
      renameCancelledRef.current = false;
      requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    }
  }, [renamingId]);

  // Keep fresh group arrays in refs for pointerup handler
  const groupsRef = useRef({ favorites, regular });
  groupsRef.current = { favorites, regular };
  const onReorderRef = useRef(onReorderGroup);
  onReorderRef.current = onReorderGroup;

  useEffect(() => {
    const computeDropTarget = (
      clientY: number,
      group: InstanceGroup
    ): { id: string; position: "before" | "after" } | null => {
      const container = listContainerRef.current;
      if (!container) return null;
      const nodes = Array.from(
        container.querySelectorAll<HTMLElement>(`[data-inst-group="${group}"]`)
      );
      if (nodes.length === 0) return null;

      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (clientY <= mid) {
          const id = node.dataset.instId;
          return id ? { id, position: "before" } : null;
        }
      }
      const lastId = nodes[nodes.length - 1]?.dataset.instId;
      return lastId ? { id: lastId, position: "after" } : null;
    };

    const onPointerMove = (e: PointerEvent) => {
      const sess = dragSessionRef.current;
      if (!sess) return;
      if (!sess.active) {
        if (Math.abs(e.clientY - sess.startY) < 5) return;
        sess.active = true;
        setDragId(sess.id);
        setCtxMenu(null);
        document.body.style.cursor = "grabbing";
      }
      setDragGhost({
        x: e.clientX - sess.offsetX,
        y: e.clientY - sess.offsetY,
        width: sess.width,
      });
      const target = computeDropTarget(e.clientY, sess.group);
      dropTargetRef.current = target;
      setDropTarget(target);
    };

    const finishDrag = () => {
      const sess = dragSessionRef.current;
      if (!sess) return;
      dragSessionRef.current = null;
      document.body.style.cursor = "";

      if (sess.active) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 0);

        const target = dropTargetRef.current;
        if (target && target.id !== sess.id) {
          const list =
            sess.group === "favorite"
              ? groupsRef.current.favorites
              : groupsRef.current.regular;
          const ids = list.map((i) => i.id).filter((id) => id !== sess.id);
          const idx = ids.indexOf(target.id);
          if (idx !== -1) {
            const insertAt = target.position === "after" ? idx + 1 : idx;
            ids.splice(insertAt, 0, sess.id);
            onReorderRef.current(sess.group, ids);
          }
        }
      }

      dropTargetRef.current = null;
      setDragId(null);
      setDragGhost(null);
      setDropTarget(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      document.body.style.cursor = "";
    };
  }, []);

  const commitRename = () => {
    if (!renamingId) return;
    const id = renamingId;
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (renameCancelledRef.current || !trimmed) return;
    const inst = instances.find((i) => i.id === id);
    if (inst && inst.name !== trimmed) {
      onRenameInstance(id, trimmed);
    }
  };

  const renderInstanceRow = (inst: Instance, group: InstanceGroup) => {
    const selected = activeView.type === "instance" && activeView.instanceId === inst.id;
    const status = statuses[inst.id] ?? "idle";
    const isRenaming = renamingId === inst.id;
    const isDragging = dragId === inst.id;
    const isDropBefore =
      dropTarget?.id === inst.id && dropTarget.position === "before" && dragId !== inst.id;
    const isDropAfter =
      dropTarget?.id === inst.id && dropTarget.position === "after" && dragId !== inst.id;

    return (
      <div
        key={inst.id}
        data-inst-id={inst.id}
        data-inst-group={group}
        onPointerDown={(e) => {
          if (e.button !== 0 || isRenaming) return;
          const rect = e.currentTarget.getBoundingClientRect();
          dragSessionRef.current = {
            id: inst.id,
            group,
            startY: e.clientY,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
            width: rect.width,
            active: false,
          };
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({
            instanceId: inst.id,
            x: e.clientX,
            y: e.clientY,
            confirmDelete: false,
          });
        }}
        className="relative"
      >
        {isDropBefore && (
          <div className="absolute -top-0.5 left-2 right-2 h-0.5 rounded-full bg-[#ededed] pointer-events-none z-10" />
        )}

        {isRenaming ? (
          <div className="w-full px-2.5 py-2 rounded-[8px] bg-[#232325] border border-[#ededed]/25">
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  renameCancelledRef.current = true;
                  setRenamingId(null);
                }
              }}
              onBlur={commitRename}
              className="w-full bg-transparent text-[14px] leading-5 text-[#ededed] focus:outline-none"
            />
            <div className="font-mono text-[12px] leading-4 text-[#85858b] truncate mt-0.5">
              {inst.mcVersion} · {formatLoader(inst.loader)}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (justDraggedRef.current) return;
              onSelectInstance(inst.id);
            }}
            className={`w-full px-2.5 py-2 rounded-[8px] text-left flex items-center justify-between gap-2 transition-colors duration-150 ${
              isDragging ? "opacity-40" : ""
            } ${
              selected
                ? "bg-[#232325] text-[#ededed] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                : "text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.04]"
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {inst.iconUrl ? (
                <img
                  src={inst.iconUrl}
                  alt=""
                  className="w-7 h-7 rounded-[6px] bg-[#232325] object-cover shrink-0"
                />
              ) : (
                <div className="w-7 h-7 rounded-[6px] bg-[#1d1d20] border border-[#ededed]/[0.06] flex items-center justify-center shrink-0 font-mono text-[11px] text-[#85858b]">
                  {inst.name.trim().charAt(0).toUpperCase() || "M"}
                </div>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  {inst.favorite && (
                    <Star
                      size={12}
                      strokeWidth={1.75}
                      className="shrink-0 text-[#d4a054] fill-[#d4a054]"
                    />
                  )}
                  <span
                    className={`text-[14px] leading-5 truncate ${
                      selected ? "font-medium text-[#ededed]" : "font-normal text-[#ededed]/90"
                    }`}
                  >
                    {inst.name}
                  </span>
                </div>
                <div className="font-mono text-[12px] leading-4 text-[#85858b] truncate mt-0.5">
                  {inst.mcVersion} · {formatLoader(inst.loader)}
                </div>
              </div>
            </div>

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
          </button>
        )}

        {isDropAfter && (
          <div className="absolute -bottom-0.5 left-2 right-2 h-0.5 rounded-full bg-[#ededed] pointer-events-none z-10" />
        )}
      </div>
    );
  };

  const ctxInstance = ctxMenu
    ? instances.find((i) => i.id === ctxMenu.instanceId) ?? null
    : null;
  const ctxStatus = ctxInstance ? statuses[ctxInstance.id] ?? "idle" : "idle";
  const ctxIsRunning = ctxStatus === "running" || ctxStatus === "launching";

  return (
    <aside className="w-64 shrink-0 bg-[#0f0f10] border-r border-[#ededed]/[0.08] flex flex-col select-none">
      {/* Primary navigation & quick actions */}
      <div className="p-3 space-y-1">
        <button
          type="button"
          onClick={onOpenHome}
          className={`w-full h-9 px-2.5 rounded-[8px] flex items-center gap-2.5 text-[14px] transition-colors duration-150 ${
            isHome
              ? "bg-[#232325] text-[#ededed] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
              : "text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.04]"
          }`}
        >
          <Home size={16} strokeWidth={1.5} className="shrink-0 text-[#85858b]" />
          <span className="truncate">{t.home}</span>
        </button>

        <button
          type="button"
          onClick={onOpenModrinth}
          className={`w-full h-9 px-2.5 rounded-[8px] flex items-center gap-2.5 text-[14px] transition-colors duration-150 ${
            isModrinth
              ? "bg-[#232325] text-[#ededed] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
              : "text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.04]"
          }`}
        >
          <Compass size={16} strokeWidth={1.5} className="shrink-0 text-[#85858b]" />
          <span className="truncate">{t.catalog}</span>
        </button>

        <button
          type="button"
          onClick={onOpenCreateModal}
          className="w-full h-9 px-2.5 rounded-[8px] flex items-center justify-between text-[14px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.04] transition-colors duration-150"
        >
          <span className="flex items-center gap-2.5 truncate">
            <Plus size={16} strokeWidth={1.5} className="shrink-0 text-[#85858b]" />
            <span className="truncate">{t.newInstance}</span>
          </span>
          <kbd className="mono-keycap">Ctrl+N</kbd>
        </button>
      </div>

      {/* Instances list */}
      <div ref={listContainerRef} className="flex-1 overflow-y-auto px-3 pt-4 pb-3">
        {instances.length === 0 ? (
          <>
            <div className="px-2.5 mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium text-[#85858b]">{t.instances}</span>
              <span className="font-mono text-[12px] text-[#85858b]">0</span>
            </div>
            <div className="px-2.5 py-6 text-[13px] text-[#85858b]">{t.noInstancesYet}</div>
          </>
        ) : (
          <div className="space-y-4">
            {favorites.length > 0 && (
              <div>
                <div className="px-2.5 mb-2 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-[#85858b]">{t.favorites}</span>
                  <span className="font-mono text-[12px] text-[#85858b]">
                    {favorites.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {favorites.map((inst) => renderInstanceRow(inst, "favorite"))}
                </div>
              </div>
            )}

            <div>
              <div className="px-2.5 mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium text-[#85858b]">{t.instances}</span>
                <span className="font-mono text-[12px] text-[#85858b]">
                  {favorites.length > 0 ? regular.length : instances.length}
                </span>
              </div>
              <div className="space-y-1">
                {regular.map((inst) => renderInstanceRow(inst, "regular"))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom account + settings bar */}
      <div className="p-3 border-t border-[#ededed]/[0.08] flex items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenAccountsModal}
          className="flex-1 min-w-0 h-11 px-2 rounded-[8px] flex items-center gap-2.5 hover:bg-[#ededed]/[0.05] transition-colors duration-150 text-left"
        >
          {activeAccount ? (
            <img
              src={`https://mc-heads.net/avatar/${encodeURIComponent(activeAccount.username)}/32`}
              alt={activeAccount.username}
              className="w-7 h-7 rounded-[6px] bg-[#232325] shrink-0 object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="w-7 h-7 rounded-[6px] bg-[#232325] flex items-center justify-center shrink-0">
              <User size={14} strokeWidth={1.5} className="text-[#85858b]" />
            </div>
          )}
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[#ededed] truncate leading-4">
              {activeAccount ? activeAccount.username : t.addAccount}
            </div>
            <div className="text-[12px] text-[#85858b] truncate leading-4 mt-0.5">
              {activeAccount
                ? activeAccount.accountType === "microsoft"
                  ? t.microsoft
                  : activeAccount.accountType === "elyby"
                    ? t.elyby
                    : t.offline
                : t.noAccount}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          title={t.settings}
          className={`w-9 h-9 shrink-0 rounded-[8px] flex items-center justify-center transition-colors duration-150 ${
            isSettings
              ? "bg-[#232325] text-[#ededed]"
              : "text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.05]"
          }`}
        >
          <Settings size={16} strokeWidth={1.5} />
        </button>
      </div>

      {/* Right-click context menu */}
      {ctxMenu &&
        ctxInstance &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ left: menuPos.left, top: menuPos.top }}
            className="fixed z-[110] min-w-[220px] w-max max-w-[280px] p-1 rounded-[10px] bg-[#19191b] border border-[#ededed]/[0.12] shadow-[0_12px_32px_rgba(0,0,0,0.5)] mono-select-enter"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                if (ctxIsRunning) onStopInstance(ctxInstance.id);
                else onLaunchInstance(ctxInstance.id);
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              {ctxIsRunning ? (
                <Square size={14} strokeWidth={1.5} className="shrink-0 text-[#e5484d]" />
              ) : (
                <Play size={14} strokeWidth={1.5} className="shrink-0 text-[#4cc38a]" />
              )}
              <span>{ctxIsRunning ? t.ctxStop : t.ctxPlay}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                onToggleFavorite(ctxInstance.id);
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              <Star
                size={14}
                strokeWidth={1.5}
                className={`shrink-0 ${ctxInstance.favorite ? "text-[#d4a054] fill-[#d4a054]" : ""}`}
              />
              <span>{ctxInstance.favorite ? t.ctxFavoriteRemove : t.ctxFavoriteAdd}</span>
            </button>

            <div className="my-1 h-px bg-[#ededed]/[0.08]" />

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                setRenameValue(ctxInstance.name);
                setRenamingId(ctxInstance.id);
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              <Pencil size={14} strokeWidth={1.5} className="shrink-0" />
              <span>{t.ctxRename}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                onCloneInstance(ctxInstance.id);
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              <CopyPlus size={14} strokeWidth={1.5} className="shrink-0" />
              <span>{t.ctxDuplicate}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                onOpenInstanceFolder(ctxInstance.id);
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              <FolderOpen size={14} strokeWidth={1.5} className="shrink-0" />
              <span>{t.ctxOpenFolder}</span>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                onSelectInstance(ctxInstance.id, "settings");
              }}
              className="w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.07] transition-colors"
            >
              <SlidersHorizontal size={14} strokeWidth={1.5} className="shrink-0" />
              <span>{t.ctxSettings}</span>
            </button>

            <div className="my-1 h-px bg-[#ededed]/[0.08]" />

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (!ctxMenu.confirmDelete) {
                  setCtxMenu({ ...ctxMenu, confirmDelete: true });
                  return;
                }
                setCtxMenu(null);
                onDeleteInstance(ctxInstance.id);
              }}
              className={`w-full h-8 px-2.5 rounded-[6px] flex items-center gap-2.5 text-left whitespace-nowrap text-[13px] transition-colors ${
                ctxMenu.confirmDelete
                  ? "bg-[#e5484d]/20 text-[#e5484d] font-medium"
                  : "text-[#e5484d] hover:bg-[#e5484d]/15"
              }`}
            >
              <Trash2 size={14} strokeWidth={1.5} className="shrink-0" />
              <span>{ctxMenu.confirmDelete ? t.ctxDeleteConfirm : t.ctxDelete}</span>
            </button>
          </div>,
          document.body
        )}

      {/* Floating drag preview */}
      {dragId &&
        dragGhost &&
        (() => {
          const ghostInst = instances.find((i) => i.id === dragId);
          if (!ghostInst) return null;
          const ghostStatus = statuses[ghostInst.id] ?? "idle";
          return createPortal(
            <div
              style={{
                left: dragGhost.x,
                top: dragGhost.y,
                width: dragGhost.width,
              }}
              className="fixed z-[120] pointer-events-none px-2.5 py-2 rounded-[8px] bg-[#232325] border border-[#ededed]/[0.18] shadow-[0_12px_28px_rgba(0,0,0,0.55)] flex items-center justify-between gap-2 scale-[1.02] select-none"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {ghostInst.iconUrl ? (
                  <img
                    src={ghostInst.iconUrl}
                    alt=""
                    className="w-7 h-7 rounded-[6px] bg-[#19191b] object-cover shrink-0"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-[6px] bg-[#19191b] border border-[#ededed]/[0.08] flex items-center justify-center shrink-0 font-mono text-[11px] text-[#85858b]">
                    {ghostInst.name.trim().charAt(0).toUpperCase() || "M"}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {ghostInst.favorite && (
                      <Star
                        size={12}
                        strokeWidth={1.75}
                        className="shrink-0 text-[#d4a054] fill-[#d4a054]"
                      />
                    )}
                    <span className="text-[14px] leading-5 truncate font-medium text-[#ededed]">
                      {ghostInst.name}
                    </span>
                  </div>
                  <div className="font-mono text-[12px] leading-4 text-[#85858b] truncate mt-0.5">
                    {ghostInst.mcVersion} · {formatLoader(ghostInst.loader)}
                  </div>
                </div>
              </div>

              {ghostStatus !== "idle" && (
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    ghostStatus === "running"
                      ? "bg-[#4cc38a]"
                      : ghostStatus === "crashed"
                        ? "bg-[#e5484d]"
                        : "bg-[#ededed]/70"
                  }`}
                />
              )}
            </div>,
            document.body
          );
        })()}
    </aside>
  );
}
