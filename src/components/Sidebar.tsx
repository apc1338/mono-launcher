import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Compass,
  CopyPlus,
  FolderOpen,
  Home,
  LayoutGrid,
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

export const SIDEBAR_COMPACT_WIDTH = 68;
export const SIDEBAR_DEFAULT_WIDTH = 256;
export const SIDEBAR_MIN_EXPANDED = 176;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_SNAP_THRESHOLD = 128;

export type ActiveView =
  | { type: "home" }
  | { type: "instances" }
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
  width: number;
  onResizeWidth: (width: number) => void;
  onOpenHome: () => void;
  onOpenAllInstances: () => void;
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

function formatLoader(inst: Instance): string {
  if (inst.edition === "rust") return "Rust";
  switch (inst.loader) {
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
  width,
  onResizeWidth,
  onOpenHome,
  onOpenAllInstances,
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
  const isAllInstances = activeView.type === "instances";
  const isModrinth = activeView.type === "modrinth";
  const isSettings = activeView.type === "settings";
  const isCompact = width <= SIDEBAR_COMPACT_WIDTH + 8;

  const favorites = instances.filter((i) => i.favorite);
  const regular = instances.filter((i) => !i.favorite);

  // Resize handle state
  const [resizing, setResizing] = useState(false);
  const resizeSessionRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeWidthRef = useRef(onResizeWidth);
  onResizeWidthRef.current = onResizeWidth;

  // Hover tooltip state (instant floating tooltip to the right of sidebar items)
  const [tooltip, setTooltip] = useState<{
    label: string;
    sub?: string;
    left: number;
    top: number;
  } | null>(null);

  const showTooltip = (el: HTMLElement, label: string, sub?: string) => {
    if (resizing || dragId) return;
    const rect = el.getBoundingClientRect();
    setTooltip({
      label,
      sub,
      left: rect.right + 10,
      top: rect.top + rect.height / 2,
    });
  };
  const hideTooltip = () => setTooltip(null);

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

  // Sidebar width resize listeners
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const sess = resizeSessionRef.current;
      if (!sess) return;
      const raw = sess.startWidth + (e.clientX - sess.startX);
      if (raw < SIDEBAR_SNAP_THRESHOLD) {
        onResizeWidthRef.current(SIDEBAR_COMPACT_WIDTH);
      } else {
        const clamped = Math.max(
          SIDEBAR_MIN_EXPANDED,
          Math.min(SIDEBAR_MAX_WIDTH, Math.round(raw))
        );
        onResizeWidthRef.current(clamped);
      }
    };
    const onUp = () => {
      resizeSessionRef.current = null;
      setResizing(false);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
    };
  }, [resizing]);

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
        setTooltip(null);
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
    const isRenaming = renamingId === inst.id && !isCompact;
    const isDragging = dragId === inst.id;
    const isDropBefore =
      dropTarget?.id === inst.id && dropTarget.position === "before" && dragId !== inst.id;
    const isDropAfter =
      dropTarget?.id === inst.id && dropTarget.position === "after" && dragId !== inst.id;
    const subLabel = `${inst.mcVersion} · ${formatLoader(inst)}`;

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
          hideTooltip();
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
              {subLabel}
            </div>
          </div>
        ) : isCompact ? (
          <button
            type="button"
            onClick={() => {
              if (justDraggedRef.current) return;
              onSelectInstance(inst.id);
            }}
            onMouseEnter={(e) => showTooltip(e.currentTarget, inst.name, subLabel)}
            onMouseLeave={hideTooltip}
            className={`relative w-10 h-10 mx-auto rounded-[8px] flex items-center justify-center transition-colors duration-150 ${
              isDragging ? "opacity-40" : ""
            } ${
              selected
                ? "bg-[#232325] text-[#ededed] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                : "text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.05]"
            }`}
          >
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

            {status !== "idle" && (
              <span
                className={`absolute bottom-1 right-1 w-2 h-2 rounded-full ring-2 ring-[#0f0f10] ${
                  status === "running"
                    ? "bg-[#4cc38a]"
                    : status === "crashed"
                      ? "bg-[#e5484d]"
                      : "bg-[#ededed]/70"
                }`}
              />
            )}

            {inst.favorite && (
              <Star
                size={9}
                strokeWidth={1.75}
                className="absolute top-1 right-1 text-[#d4a054] fill-[#d4a054]"
              />
            )}
          </button>
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
                  {subLabel}
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

  const accountName = activeAccount ? activeAccount.username : t.addAccount;
  const accountTypeText = activeAccount
    ? activeAccount.accountType === "microsoft"
      ? t.microsoft
      : activeAccount.accountType === "elyby"
        ? t.elyby
        : t.offline
    : t.noAccount;

  return (
    <aside
      style={{ width }}
      className="relative shrink-0 bg-[#0f0f10] border-r border-[#ededed]/[0.08] flex flex-col select-none"
    >
      {/* Primary navigation & quick actions */}
      <div className={isCompact ? "p-2.5 space-y-1 flex flex-col items-center" : "p-3 space-y-1"}>
        <button
          type="button"
          onClick={onOpenHome}
          onMouseEnter={(e) => isCompact && showTooltip(e.currentTarget, t.home)}
          onMouseLeave={hideTooltip}
          className={`${
            isCompact ? "w-10 h-9 justify-center" : "w-full h-9 px-2.5 gap-2.5"
          } rounded-[8px] flex items-center text-[14px] transition-colors duration-150 ${
            isHome
              ? "bg-[#232325] text-[#ededed] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
              : "text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.04]"
          }`}
        >
          <Home size={16} strokeWidth={1.5} className="shrink-0 text-[#85858b]" />
          {!isCompact && <span className="truncate">{t.home}</span>}
        </button>

        <button
          type="button"
          onClick={onOpenModrinth}
          onMouseEnter={(e) => isCompact && showTooltip(e.currentTarget, t.catalog)}
          onMouseLeave={hideTooltip}
          className={`${
            isCompact ? "w-10 h-9 justify-center" : "w-full h-9 px-2.5 gap-2.5"
          } rounded-[8px] flex items-center text-[14px] transition-colors duration-150 ${
            isModrinth
              ? "bg-[#232325] text-[#ededed] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
              : "text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.04]"
          }`}
        >
          <Compass size={16} strokeWidth={1.5} className="shrink-0 text-[#85858b]" />
          {!isCompact && <span className="truncate">{t.catalog}</span>}
        </button>

        <button
          type="button"
          onClick={onOpenCreateModal}
          onMouseEnter={(e) => isCompact && showTooltip(e.currentTarget, t.newInstance)}
          onMouseLeave={hideTooltip}
          className={`${
            isCompact ? "w-10 h-9 justify-center" : "w-full h-9 px-2.5 gap-2.5"
          } rounded-[8px] flex items-center text-[14px] text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.04] transition-colors duration-150`}
        >
          <Plus size={16} strokeWidth={1.5} className="shrink-0 text-[#85858b]" />
          {!isCompact && <span className="truncate">{t.newInstance}</span>}
        </button>
      </div>

      {/* Instances header + "All instances" button + Instances list */}
      <div
        ref={listContainerRef}
        onScroll={hideTooltip}
        className={`flex-1 overflow-y-auto pb-3 ${isCompact ? "px-2.5 pt-2" : "px-3 pt-4"}`}
      >
        {!isCompact && (
          <div className="px-2.5 mb-2 flex items-center justify-between">
            <span className="text-[12px] font-medium text-[#85858b]">{t.instances}</span>
            <span className="font-mono text-[12px] text-[#85858b]">{instances.length}</span>
          </div>
        )}

        {/* "All instances" button above all instances */}
        <div className={isCompact ? "mb-2.5 flex justify-center" : "mb-2"}>
          <button
            type="button"
            onClick={onOpenAllInstances}
            onMouseEnter={(e) => isCompact && showTooltip(e.currentTarget, t.allInstances)}
            onMouseLeave={hideTooltip}
            className={`${
              isCompact ? "w-10 h-9 justify-center" : "w-full h-9 px-2.5 gap-2.5"
            } rounded-[8px] flex items-center text-[14px] transition-colors duration-150 ${
              isAllInstances
                ? "bg-[#232325] text-[#ededed] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                : "text-[#a1a1a6] hover:text-[#ededed] hover:bg-[#ededed]/[0.04]"
            }`}
          >
            <div
              className={`${
                isCompact ? "" : "w-7 h-7"
              } flex items-center justify-center shrink-0`}
            >
              <LayoutGrid size={16} strokeWidth={1.5} className="text-[#85858b]" />
            </div>
            {!isCompact && <span className="truncate">{t.allInstances}</span>}
          </button>
        </div>

        {isCompact && instances.length > 0 && (
          <div className="h-px bg-[#ededed]/[0.08] mx-1.5 mb-2.5" />
        )}

        {instances.length === 0 ? (
          !isCompact && (
            <div className="px-2.5 py-6 text-[13px] text-[#85858b]">{t.noInstancesYet}</div>
          )
        ) : (
          <div className={isCompact ? "space-y-2" : "space-y-3"}>
            {favorites.length > 0 && (
              <div>
                {!isCompact && (
                  <div className="px-2.5 mb-1.5 text-[12px] font-medium text-[#85858b]">
                    {t.favorites}
                  </div>
                )}
                <div className="space-y-1">
                  {favorites.map((inst) => renderInstanceRow(inst, "favorite"))}
                </div>
              </div>
            )}

            {favorites.length > 0 && regular.length > 0 && (
              <div className={`h-px bg-[#ededed]/[0.08] ${isCompact ? "mx-1.5" : "mx-2"}`} />
            )}

            {regular.length > 0 && (
              <div className="space-y-1">
                {regular.map((inst) => renderInstanceRow(inst, "regular"))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom account + settings bar */}
      <div
        className={`border-t border-[#ededed]/[0.08] flex items-center ${
          isCompact ? "p-2.5 flex-col gap-1.5" : "p-3 gap-1.5"
        }`}
      >
        <button
          type="button"
          onClick={onOpenAccountsModal}
          onMouseEnter={(e) =>
            isCompact && showTooltip(e.currentTarget, accountName, accountTypeText)
          }
          onMouseLeave={hideTooltip}
          className={`${
            isCompact
              ? "w-10 h-10 justify-center"
              : "flex-1 min-w-0 h-11 px-2 gap-2.5 text-left"
          } rounded-[8px] flex items-center hover:bg-[#ededed]/[0.05] transition-colors duration-150`}
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
          {!isCompact && (
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[#ededed] truncate leading-4">
                {accountName}
              </div>
              <div className="text-[12px] text-[#85858b] truncate leading-4 mt-0.5">
                {accountTypeText}
              </div>
            </div>
          )}
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          onMouseEnter={(e) => showTooltip(e.currentTarget, t.settings)}
          onMouseLeave={hideTooltip}
          className={`${
            isCompact ? "w-10 h-9" : "w-9 h-9"
          } shrink-0 rounded-[8px] flex items-center justify-center transition-colors duration-150 ${
            isSettings
              ? "bg-[#232325] text-[#ededed]"
              : "text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.05]"
          }`}
        >
          <Settings size={16} strokeWidth={1.5} />
        </button>
      </div>

      {/* Vertical resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          hideTooltip();
          resizeSessionRef.current = { startX: e.clientX, startWidth: width };
          setResizing(true);
        }}
        onDoubleClick={() => {
          hideTooltip();
          onResizeWidth(isCompact ? SIDEBAR_DEFAULT_WIDTH : SIDEBAR_COMPACT_WIDTH);
        }}
        className="group absolute top-0 right-0 bottom-0 w-1.5 -mr-[3px] cursor-col-resize z-20 flex justify-center"
      >
        <div
          className={`w-[2px] h-full transition-colors duration-150 ${
            resizing ? "bg-[#ededed]/35" : "bg-transparent group-hover:bg-[#ededed]/20"
          }`}
        />
      </div>

      {/* Floating hover tooltip */}
      {tooltip &&
        !ctxMenu &&
        createPortal(
          <div
            style={{ left: tooltip.left, top: tooltip.top }}
            className="fixed -translate-y-1/2 z-[130] pointer-events-none px-2.5 py-1.5 rounded-[7px] bg-[#1d1d20] border border-[#ededed]/[0.14] shadow-[0_8px_24px_rgba(0,0,0,0.45)] max-w-[240px]"
          >
            <div className="text-[12px] font-medium text-[#ededed] leading-4 truncate">
              {tooltip.label}
            </div>
            {tooltip.sub && (
              <div className="font-mono text-[11px] text-[#85858b] leading-4 truncate mt-0.5">
                {tooltip.sub}
              </div>
            )}
          </div>,
          document.body
        )}

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
                if (isCompact) onResizeWidth(SIDEBAR_DEFAULT_WIDTH);
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
              className={`fixed z-[120] pointer-events-none rounded-[8px] bg-[#232325] border border-[#ededed]/[0.18] shadow-[0_12px_28px_rgba(0,0,0,0.55)] flex items-center scale-[1.02] select-none ${
                isCompact ? "h-10 justify-center" : "px-2.5 py-2 justify-between gap-2"
              }`}
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
                {!isCompact && (
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
                      {ghostInst.mcVersion} · {formatLoader(ghostInst)}
                    </div>
                  </div>
                )}
              </div>

              {!isCompact && ghostStatus !== "idle" && (
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
