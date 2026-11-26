import { Minus, Square, X } from "lucide-react";
import launcherIcon from "../assets/launcher-icon.png";
import { api } from "../lib/api";

export function TitleBar() {
  return (
    <header
      data-tauri-drag-region
      className="h-9 shrink-0 bg-[#0f0f10] border-b border-[#ededed]/[0.08] flex items-center justify-between pl-4 pr-1 select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 pointer-events-none">
        <img
          src={launcherIcon}
          alt=""
          aria-hidden="true"
          className="w-[18px] h-[18px] rounded-[4px] object-cover"
        />
        <span className="text-[13px] font-medium tracking-[-0.01em] text-[#ededed]">
          Mono
        </span>
      </div>

      <div className="flex items-center gap-2 pr-1">
        <button
          type="button"
          onClick={() => api.window.minimize()}
          aria-label="Minimize"
          className="w-10 h-8 flex items-center justify-center rounded-[6px] text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06] transition-colors duration-150"
        >
          <Minus size={14} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={() => api.window.toggleMaximize()}
          aria-label="Maximize"
          className="w-10 h-8 flex items-center justify-center rounded-[6px] text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06] transition-colors duration-150"
        >
          <Square size={12} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={() => api.window.close()}
          aria-label="Close"
          className="w-10 h-8 flex items-center justify-center rounded-[6px] text-[#85858b] hover:text-[#ededed] hover:bg-[#e5484d]/20 hover:text-[#e5484d] transition-colors duration-150"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}
