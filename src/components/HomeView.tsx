import { useMemo } from "react";
import { ArrowUpRight, Clock, FolderOpen, Play, Plus, Square, Star } from "lucide-react";
import type { Dict } from "../i18n";
import type { Account, Instance, InstanceRuntimeStatus, Language } from "../types";

interface HomeViewProps {
  t: Dict;
  language: Language;
  instances: Instance[];
  statuses: Record<string, InstanceRuntimeStatus>;
  activeAccount: Account | null;
  onSelectInstance: (id: string) => void;
  onLaunchInstance: (id: string) => void;
  onStopInstance: (id: string) => void;
  onOpenInstanceFolder: (id: string) => void;
  onOpenAllInstances: () => void;
  onCreateInstance: () => void;
}

function pickGreeting(language: Language, username: string | null): string {
  const hour = new Date().getHours();
  const isMorning = hour >= 5 && hour < 12;
  const isDay = hour >= 12 && hour < 18;
  const isEvening = hour >= 18 && hour < 23;

  const ruPools = {
    morning: [
      "Доброе утро",
      "С добрым утром",
      "Бодрого утра",
      "Кофе и кубы",
      "Утро начинается с игры",
    ],
    day: [
      "Добрый день",
      "Хорошего дня",
      "Во что играем сегодня",
      "Время для пары чанков",
      "Отличный день для игры",
    ],
    evening: [
      "Добрый вечер",
      "Хорошего вечера",
      "Вечер в кубах",
      "Залетай на часок",
      "Спокойного вечера",
    ],
    night: [
      "Доброй ночи",
      "Не спится",
      "Ночная смена в шахте",
      "Ещё один блок и спать",
      "Тихая ночь для игры",
    ],
    any: [
      "Привет",
      "С возвращением",
      "Рад снова видеть",
      "Готов к игре",
      "Что строим сегодня",
      "Снова в деле",
      "Погнали",
      "Куда сегодня",
      "Мир ждёт",
    ],
  };

  const enPools = {
    morning: ["Good morning", "Morning", "Coffee and blocks", "Fresh start"],
    day: ["Good afternoon", "Ready to play", "What are we building today", "Time for a quick run"],
    evening: ["Good evening", "Evening session", "Unwind for a bit", "Good to see you"],
    night: ["Good night", "Still awake", "Late night mining", "One more block before bed"],
    any: ["Hey", "Welcome back", "Back in action", "Let's jump in", "Where to today", "The world awaits"],
  };

  const pools = language === "en" ? enPools : ruPools;
  const timePool = isMorning
    ? pools.morning
    : isDay
      ? pools.day
      : isEvening
        ? pools.evening
        : pools.night;
  const combined = [...timePool, ...pools.any];
  const base = combined[Math.floor(Math.random() * combined.length)];

  const questionLike =
    base.startsWith("Во что") ||
    base.startsWith("Не спится") ||
    base.startsWith("Ночная смена") ||
    base.startsWith("Вечер в кубах") ||
    base.startsWith("Готов") ||
    base.startsWith("Что строим") ||
    base.startsWith("Куда сегодня") ||
    base.startsWith("Still awake") ||
    base.startsWith("What are we") ||
    base.startsWith("Where to");

  if (!username) return questionLike ? `${base}?` : base;
  return questionLike ? `${base}, ${username}?` : `${base}, ${username}`;
}

function formatLoader(inst: Instance): string {
  if (inst.edition === "rust") return "Rust Edition";
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

export function HomeView({
  t,
  language,
  instances,
  statuses,
  activeAccount,
  onSelectInstance,
  onLaunchInstance,
  onStopInstance,
  onOpenInstanceFolder,
  onOpenAllInstances,
  onCreateInstance,
}: HomeViewProps) {
  const greeting = useMemo(
    () => pickGreeting(language, activeAccount?.username ?? null),
    [language, activeAccount?.username]
  );

  const sorted = [...instances].sort((a, b) => {
    if (a.lastPlayed && b.lastPlayed) return b.lastPlayed.localeCompare(a.lastPlayed);
    if (a.lastPlayed) return -1;
    if (b.lastPlayed) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const featured = sorted[0] ?? null;
  // Quick-access shelf: favorites first, then recent (excluding featured), max 3
  const quickList = [
    ...sorted.filter((i) => i.id !== featured?.id && i.favorite),
    ...sorted.filter((i) => i.id !== featured?.id && !i.favorite),
  ].slice(0, 3);

  const featuredStatus = featured ? statuses[featured.id] ?? "idle" : "idle";

  return (
    <div className="relative flex-1 flex flex-col overflow-y-auto mono-home-pattern mono-view-enter">
      {/* Soft monochrome radial glow rising from the bottom */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 85% 65% at 50% 100%, rgba(255,255,255,0.035) 0%, transparent 55%, rgba(20,20,21,0.82) 100%)",
        }}
      />

      <div className="relative z-10 flex-1 w-full max-w-4xl px-10 py-10 flex flex-col justify-between gap-10">
        {/* Top editorial header */}
        <header className="pt-2">
          <div className="text-[13px] text-[#85858b]">
            {t.homeTitle}
          </div>
          <h1 className="mt-1.5 text-[36px] leading-[42px] font-medium tracking-[-0.02em] text-[#ededed]">
            {greeting}
          </h1>
        </header>

        {/* Bottom-anchored main focus + quick access */}
        <div className="space-y-6">
          {featured ? (
            <section
              onClick={() => onSelectInstance(featured.id)}
              className="group rounded-[16px] bg-[#19191b]/95 border border-[#ededed]/[0.09] hover:border-[#ededed]/[0.16] shadow-[0_12px_40px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.06)] overflow-hidden cursor-pointer transition-colors duration-150"
            >
              {/* Card top meta strip */}
              <div className="px-6 py-3 border-b border-[#ededed]/[0.06] flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[#85858b]">
                    {t.lastInstance}
                  </span>
                  {featuredStatus !== "idle" && (
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        featuredStatus === "running"
                          ? "bg-[#4cc38a]"
                          : featuredStatus === "crashed"
                            ? "bg-[#e5484d]"
                            : "bg-[#ededed]/70"
                      }`}
                    />
                  )}
                </div>
                <span className="font-mono text-[11px] text-[#85858b]">
                  {formatLastPlayed(featured.lastPlayed, t)}
                </span>
              </div>

              {/* Card body */}
              <div className="p-6 flex items-center justify-between gap-6">
                <div className="flex items-center gap-4 min-w-0">
                  {featured.iconUrl ? (
                    <img
                      src={featured.iconUrl}
                      alt=""
                      className="w-14 h-14 rounded-[12px] bg-[#232325] object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-[12px] bg-[#232325] border border-[#ededed]/[0.07] flex items-center justify-center shrink-0 font-mono text-[20px] text-[#85858b]">
                      {featured.name.trim().charAt(0).toUpperCase() || "M"}
                    </div>
                  )}

                  <div className="min-w-0">
                    <h2 className="text-[24px] leading-8 font-medium tracking-[-0.02em] text-[#ededed] truncate">
                      {featured.name}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12px] text-[#85858b]">
                      <span className="text-[#a1a1a6]">{featured.mcVersion}</span>
                      <span className="text-[#ededed]/15">·</span>
                      <span>
                        {formatLoader(featured)}
                        {featured.loaderVersion && featured.edition !== "rust"
                          ? ` ${featured.loaderVersion}`
                          : ""}
                      </span>
                      <span className="text-[#ededed]/15">·</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} strokeWidth={1.6} />
                        {formatPlayTime(featured.playTimeSec, t)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    title={t.openFolder}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenInstanceFolder(featured.id);
                    }}
                    className="mono-btn-secondary w-10 h-10 rounded-[9px] flex items-center justify-center text-[#85858b] hover:text-[#ededed]"
                  >
                    <FolderOpen size={15} strokeWidth={1.5} />
                  </button>

                  {featuredStatus === "running" ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStopInstance(featured.id);
                      }}
                      className="h-10 px-5 rounded-[9px] bg-[#e5484d]/15 text-[#e5484d] border border-[#e5484d]/30 hover:bg-[#e5484d]/25 transition-colors duration-150 inline-flex items-center justify-center gap-2 text-[14px] leading-none font-medium"
                    >
                      <Square size={12} strokeWidth={1.5} fill="currentColor" className="shrink-0" />
                      <span>{t.stop}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={featuredStatus === "launching"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onLaunchInstance(featured.id);
                      }}
                      className="mono-btn-primary h-10 px-5 rounded-[9px] inline-flex items-center justify-center gap-2 text-[14px] leading-none font-medium disabled:opacity-60"
                    >
                      <Play size={13} strokeWidth={1.75} fill="currentColor" className="shrink-0" />
                      <span>{featuredStatus === "launching" ? t.launching : t.play}</span>
                    </button>
                  )}
                </div>
              </div>
            </section>
          ) : (
            <section className="rounded-[16px] bg-[#19191b]/95 border border-[#ededed]/[0.09] py-14 px-6 text-center">
              <p className="text-[16px] text-[#ededed] font-medium">{t.noInstancesYet}</p>
              <p className="text-[13px] text-[#85858b] mt-1">{t.selectOrCreate}</p>
              <button
                type="button"
                onClick={onCreateInstance}
                className="mono-btn-primary mt-5 h-9 px-4 rounded-[8px] inline-flex items-center justify-center gap-2 text-[13px] leading-none font-medium"
              >
                <Plus size={14} strokeWidth={1.75} />
                <span>{t.createFirst}</span>
              </button>
            </section>
          )}

          {/* Compact quick-jump row (max 3 other instances) */}
          {quickList.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2.5 px-0.5">
                <span className="text-[12px] font-medium text-[#85858b]">
                  {t.instances}
                </span>
                <button
                  type="button"
                  onClick={onOpenAllInstances}
                  className="text-[12px] text-[#85858b] hover:text-[#ededed] inline-flex items-center gap-1 transition-colors"
                >
                  <span>{t.allInstances}</span>
                  <ArrowUpRight size={13} strokeWidth={1.6} />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {quickList.map((inst) => {
                  const st = statuses[inst.id] ?? "idle";
                  const isRunning = st === "running";
                  const isLaunching = st === "launching";
                  return (
                    <div
                      key={inst.id}
                      onClick={() => onSelectInstance(inst.id)}
                      className="group rounded-[12px] bg-[#19191b]/90 border border-[#ededed]/[0.08] hover:border-[#ededed]/[0.16] hover:bg-[#1d1d20] px-3.5 py-3 flex items-center justify-between gap-2.5 cursor-pointer transition-colors duration-150"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {inst.iconUrl ? (
                          <img
                            src={inst.iconUrl}
                            alt=""
                            className="w-8 h-8 rounded-[7px] bg-[#232325] object-cover shrink-0"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-[7px] bg-[#232325] border border-[#ededed]/[0.06] flex items-center justify-center shrink-0 font-mono text-[12px] text-[#85858b]">
                            {inst.name.trim().charAt(0).toUpperCase() || "M"}
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {inst.favorite && (
                              <Star
                                size={11}
                                strokeWidth={1.75}
                                className="shrink-0 text-[#d4a054] fill-[#d4a054]"
                              />
                            )}
                            <span className="text-[13px] font-medium text-[#ededed] truncate">
                              {inst.name}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-[#85858b] truncate">
                            {inst.mcVersion} · {formatLoader(inst)}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={isLaunching}
                        title={isRunning ? t.stop : t.play}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isRunning) onStopInstance(inst.id);
                          else onLaunchInstance(inst.id);
                        }}
                        className="mono-btn-secondary w-7 h-7 rounded-[7px] flex items-center justify-center shrink-0 opacity-75 group-hover:opacity-100 transition-opacity disabled:opacity-40"
                      >
                        {isRunning ? (
                          <Square
                            size={10}
                            strokeWidth={1.5}
                            fill="currentColor"
                            className="text-[#e5484d]"
                          />
                        ) : (
                          <Play
                            size={11}
                            strokeWidth={1.5}
                            fill="currentColor"
                            className="text-[#ededed]"
                          />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
