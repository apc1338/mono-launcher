import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  mono?: boolean;
  align?: "left" | "right";
  minMenuWidth?: number;
}

export function Select({
  value,
  options,
  onChange,
  className = "",
  mono = false,
  align = "left",
  minMenuWidth = 0,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean }>({
    top: 0,
    left: 0,
    width: 0,
    up: false,
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected = options[selectedIdx];

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const menuH = Math.min(options.length * 36 + 8, 280);
    const up = window.innerHeight - r.bottom < menuH + 12 && r.top > menuH;
    const width = Math.max(r.width, minMenuWidth);
    const left = align === "right" ? Math.max(8, r.right - width) : r.left;
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left, width, up });
  }, [options.length, align, minMenuWidth]);

  useLayoutEffect(() => {
    if (open) {
      place();
      setMounted(true);
      return;
    }
    // keep mounted briefly so the exit animation can play
    const timer = setTimeout(() => setMounted(false), 130);
    return () => clearTimeout(timer);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, selectedIdx));
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (btnRef.current?.contains(n) || menuRef.current?.contains(n)) return;
      setOpen(false);
    };
    const close = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o.value);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          btnRef.current?.focus();
          setOpen((o) => !o);
        }}
        onKeyDown={onKeyDown}
        className={`h-9 pl-3 pr-2.5 rounded-[8px] bg-[#19191b] border text-[13px] flex items-center justify-between gap-2 transition-colors duration-150 focus:outline-none ${
          open
            ? "border-[#ededed]/25 text-[#ededed]"
            : "border-[#ededed]/[0.08] text-[#ededed] hover:border-[#ededed]/[0.16] focus-visible:border-[#ededed]/25"
        } ${mono ? "font-mono" : ""} ${className}`}
      >
        <span className="truncate">{selected?.label ?? ""}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          className={`shrink-0 text-[#85858b] transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {mounted &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            className={`fixed z-[100] max-h-[280px] overflow-y-auto p-1 rounded-[10px] bg-[#19191b] border border-[#ededed]/[0.12] shadow-[0_12px_32px_rgba(0,0,0,0.5)] ${open ? "mono-select-enter" : "mono-select-leave pointer-events-none"}`}
            style={{
              left: pos.left,
              width: pos.width,
              ...(pos.up
                ? { bottom: window.innerHeight - pos.top, transformOrigin: "bottom" }
                : { top: pos.top, transformOrigin: "top" }),
            }}
          >
            {options.map((o, i) => {
              const isSel = o.value === value;
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={isSel}
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    pick(o.value);
                  }}
                  className={`h-8 px-2.5 rounded-[6px] flex items-center justify-between gap-3 cursor-pointer text-[13px] ${
                    mono ? "font-mono" : ""
                  } ${i === active ? "bg-[#ededed]/[0.07]" : ""} ${
                    isSel ? "text-[#ededed] font-medium" : "text-[#a1a1a6]"
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {isSel && <Check size={14} strokeWidth={1.75} className="shrink-0 text-[#ededed]" />}
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

interface CheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}

export function Checkbox({ checked, onChange, label }: CheckboxProps) {
  return (
    <label className="inline-flex items-center gap-2.5 text-[13px] leading-none text-[#a1a1a6] hover:text-[#ededed] cursor-pointer select-none transition-colors duration-150">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        className={`w-4 h-4 shrink-0 rounded-[4px] border flex items-center justify-center transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-[#ededed]/30 ${
          checked ? "bg-[#ededed] border-[#ededed]" : "bg-[#141415] border-[#ededed]/[0.25]"
        }`}
      >
        {checked && <Check size={12} strokeWidth={2.5} className="text-[#141415]" />}
      </span>
      <span>{label}</span>
    </label>
  );
}
