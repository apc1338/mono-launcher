import { ArrowUpRight, Clock, Layers, Play, Plus, Square, Terminal } from "lucide-react";
import type { Dict } from "../i18n";
import type { Account, Instance, InstanceRuntimeStatus, SystemInfo } from "../types";

interface HomeViewProps {
  t: Dict;
  instances: Instance[];
  statuses: Record<string, InstanceRuntimeStatus>;
  activeAccount: Account | null;
  systemInfo: SystemInfo;
  onSelectInstance: (id: string) => void;
  onLaunchInstance: (id: string) => void;
  onStopInstance: (id: string) => void;
  onCreateInstance: () => void;
  onOpenModrinth: () => void;
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
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function HomeView({
  t,
  instances,
  statuses,
  activeAccount,
  systemInfo,
  onSelectInstance,
  onLaunchInstance,
  onStopInstance,
  onCreateInstance,
  onOpenModrinth,
}: HomeViewProps) {
  const sorted = [...instances].sort((a, b) => {
    if (a.lastPlayed && b.lastPlayed) return b.lastPlayed.localeCompare(a.lastPlayed);
    if (a.lastPlayed) return -1;
    if (b.lastPlayed) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const featured = sorted[0] ?? null;
  const recent = sorted.slice(1, 7);
  const totalPlaySec = instances.reduce((acc, i) => acc + i.playTimeSec, 0);
  const featuredStatus = featured ? statuses[featured.id] ?? "idle" : "idle";

  return (
    <div className="flex-1 overflow-y-auto mono-home-pattern mono-view-enter relative">
      {/* Subtle radial vignette so the geometric pattern fades quietly at edges */}
      <div
        className="pointer-events-none fixed inset-0 left-64 top-9"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, transparent 0%, rgba(20,20,21,0.72) 100%)",
        }}
      />

      <div className="relative z-10 max-w-4xl mx-auto px-8 py-8 space-y-6">
        {/* Page Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[28px] leading-8 font-medium tracking-[-0.02em] text-[#ededed]">
              {t.homeTitle}
            </h1>
            <p className="text-[13px] text-[#85858b] mt-1">
              {activeAccount
                ? `${activeAccount.username} · ${
                    activeAccount.accountType === "microsoft"
                      ? t.microsoft
                      : activeAccount.accountType === "elyby"
                        ? t.elyby
                        : t.offline
                  }`
                : t.noAccount}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenModrinth}
              className="mono-btn-secondary h-9 px-3.5 rounded-[8px] text-[13px] flex items-center gap-1.5"
            >
              <span>{t.catalog}</span>
              <ArrowUpRight size={14} strokeWidth={1.5} className="text-[#85858b]" />
            </button>
            <button
              type="button"
              onClick={onCreateInstance}
              className="mono-btn-primary h-9 px-3.5 rounded-[8px] text-[13px] font-medium flex items-center gap-1.5"
            >
              <Plus size={15} strokeWidth={1.75} />
              <span>{t.newInstance}</span>
            </button>
          </div>
        </div>

        {/* Featured Last Played Instance */}
        {featured ? (
          <section className="rounded-[16px] bg-[#19191b]/95 border border-[#ededed]/[0.09] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <div className="flex items-start justify-between gap-6">
              <div className="flex items-start gap-4 min-w-0">
                {featured.iconUrl ? (
                  <img
                    src={featured.iconUrl}
                    alt=""
                    className="w-14 h-14 rounded-[12px] bg-[#232325] object-cover shrink-0 mt-0.5"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-[12px] bg-[#232325] border border-[#ededed]/[0.08] flex items-center justify-center shrink-0 mt-0.5 font-mono text-[20px] text-[#85858b]">
                    {featured.name.trim().charAt(0).toUpperCase() || "M"}
                  </div>
                )}

                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[12px] text-[#85858b]">
                    <span>{t.lastInstance}</span>
                    {featuredStatus !== "idle" && (
                      <span
                        className={`w-2 h-2 rounded-full ${
                          featuredStatus === "running"
                            ? "bg-[#4cc38a]"
                            : featuredStatus === "crashed"
                              ? "bg-[#e5484d]"
                              : "bg-[#ededed]/70"
                        }`}
                      />
                    )}
                  </div>

                  <h2 className="mt-1.5 text-[24px] leading-7 font-medium tracking-[-0.02em] text-[#ededed] truncate">
                    {featured.name}
                  </h2>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-[#a1a1a6]">
                    <span>{featured.mcVersion}</span>
                    <span className="text-[#ededed]/15">/</span>
                    <span>
                      {formatLoader(featured.loader)}
                      {featured.loaderVersion ? ` ${featured.loaderVersion}` : ""}
                    </span>
                    <span className="text-[#ededed]/15">/</span>
                    <span>{featured.ramMb} MB</span>
                  </div>
                  <div className="mt-1.5 font-mono text-[12px] text-[#85858b]">
                    {t.lastPlayed}: {formatLastPlayed(featured.lastPlayed, t)}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onSelectInstance(featured.id)}
                  className="mono-btn-secondary h-10 px-3.5 rounded-[8px] text-[13px] flex items-center gap-2"
                >
                  <Terminal size={15} strokeWidth={1.5} className="text-[#85858b]" />
                  <span>{t.openInstance}</span>
                </button>

                {featuredStatus === "running" ? (
                  <button
                    type="button"
                    onClick={() => onStopInstance(featured.id)}
                    className="h-10 px-4 rounded-[8px] bg-[#e5484d]/15 text-[#e5484d] border border-[#e5484d]/30 hover:bg-[#e5484d]/25 transition-colors duration-150 flex items-center gap-2 text-[14px] font-medium"
                  >
                    <Square size={14} strokeWidth={1.5} fill="currentColor" />
                    <span>{t.stop}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={featuredStatus === "launching"}
                    onClick={() => onLaunchInstance(featured.id)}
                    className="mono-btn-primary h-10 px-5 rounded-[8px] flex items-center gap-2 text-[14px] font-medium disabled:opacity-60"
                  >
                    <Play size={14} strokeWidth={1.75} fill="currentColor" />
                    <span>{featuredStatus === "launching" ? t.launching : t.play}</span>
                  </button>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="rounded-[16px] bg-[#19191b]/95 border border-[#ededed]/[0.09] p-10 text-center">
            <p className="text-[15px] text-[#ededed] font-medium">{t.noInstancesYet}</p>
            <p className="text-[13px] text-[#85858b] mt-1">{t.selectOrCreate}</p>
            <button
              type="button"
              onClick={onCreateInstance}
              className="mono-btn-primary mt-5 h-9 px-4 rounded-[8px] inline-flex items-center gap-2 text-[14px] font-medium"
            >
              <Plus size={15} strokeWidth={1.75} />
              <span>{t.createFirst}</span>
            </button>
          </section>
        )}

        {/* Quiet 3-column stat row (unslop: numbers + labels only) */}
        <section className="grid grid-cols-3 gap-4">
          <div className="rounded-[12px] bg-[#19191b]/90 border border-[#ededed]/[0.08] p-5">
            <div className="text-[12px] text-[#85858b] flex items-center gap-1.5">
              <Layers size={14} strokeWidth={1.5} />
              <span>{t.statInstances}</span>
            </div>
            <div className="mt-2 font-mono text-[28px] leading-8 font-medium text-[#ededed]">
              {instances.length}
            </div>
          </div>

          <div className="rounded-[12px] bg-[#19191b]/90 border border-[#ededed]/[0.08] p-5">
            <div className="text-[12px] text-[#85858b] flex items-center gap-1.5">
              <Clock size={14} strokeWidth={1.5} />
              <span>{t.statPlayTime}</span>
            </div>
            <div className="mt-2 font-mono text-[28px] leading-8 font-medium text-[#ededed]">
              {formatPlayTime(totalPlaySec, t)}
            </div>
          </div>

          <div className="rounded-[12px] bg-[#19191b]/90 border border-[#ededed]/[0.08] p-5">
            <div className="text-[12px] text-[#85858b]">{t.statJavas}</div>
            <div className="mt-2 font-mono text-[28px] leading-8 font-medium text-[#ededed]">
              {systemInfo.detectedJavas.length > 0
                ? systemInfo.detectedJavas.map((j) => j.major).join(" · ")
                : "—"}
            </div>
          </div>
        </section>

        {/* Recent Instances Grid */}
        {recent.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[13px] font-medium text-[#85858b]">{t.recentInstances}</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {recent.map((inst) => {
                const st = statuses[inst.id] ?? "idle";
                return (
                  <div
                    key={inst.id}
                    onClick={() => onSelectInstance(inst.id)}
                    className="rounded-[12px] bg-[#19191b]/90 border border-[#ededed]/[0.08] hover:border-[#ededed]/[0.16] hover:bg-[#1f1f22] p-4 flex items-center justify-between gap-3 cursor-pointer transition-colors duration-150"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {inst.iconUrl ? (
                        <img
                          src={inst.iconUrl}
                          alt=""
                          className="w-9 h-9 rounded-[8px] bg-[#232325] object-cover shrink-0"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-[8px] bg-[#232325] border border-[#ededed]/[0.06] flex items-center justify-center shrink-0 font-mono text-[13px] text-[#85858b]">
                          {inst.name.trim().charAt(0).toUpperCase() || "M"}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium text-[#ededed] truncate">
                            {inst.name}
                          </span>
                          {st !== "idle" && (
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                st === "running"
                                  ? "bg-[#4cc38a]"
                                  : st === "crashed"
                                    ? "bg-[#e5484d]"
                                    : "bg-[#ededed]/70"
                              }`}
                            />
                          )}
                        </div>
                        <div className="font-mono text-[12px] text-[#85858b] mt-1 truncate">
                          {inst.mcVersion} · {formatLoader(inst.loader)} · {inst.ramMb} MB
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (st === "running") onStopInstance(inst.id);
                        else onLaunchInstance(inst.id);
                      }}
                      className="mono-btn-secondary w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0"
                      title={st === "running" ? t.stop : t.play}
                    >
                      {st === "running" ? (
                        <Square size={12} strokeWidth={1.5} fill="currentColor" className="text-[#e5484d]" />
                      ) : (
                        <Play size={13} strokeWidth={1.5} fill="currentColor" className="text-[#ededed]" />
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
  );
}
