import { Minus, Square, X } from "lucide-react";
import { api } from "../lib/api";

export function TitleBar() {
  return (
    <header
      data-tauri-drag-region
      className="h-9 shrink-0 bg-[#0f0f10] border-b border-[#ededed]/[0.08] flex items-center justify-between pl-4 pr-1 select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 pointer-events-none">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="text-[#ededed]"
        >
          <rect x="2" y="2.5" width="2.5" height="11" rx="0.5" fill="currentColor" />
          <rect x="11.5" y="2.5" width="2.5" height="11" rx="0.5" fill="currentColor" />
          <path
            d="M4 3.5L8 8.5L12 3.5"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
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
