import { useState } from "react";
import { Download, FolderOpen, Trash2 } from "lucide-react";
import type { Dict } from "../i18n";
import { api } from "../lib/api";
import { Select } from "./Select";
import type { Language, LauncherSettings, SystemInfo } from "../types";

interface SettingsViewProps {
  t: Dict;
  settings: LauncherSettings;
  systemInfo: SystemInfo;
  onSaveSettings: (s: LauncherSettings) => Promise<void>;
  onRefreshSystemInfo: () => Promise<void>;
}

export function SettingsView({
  t,
  settings,
  systemInfo,
  onSaveSettings,
  onRefreshSystemInfo,
}: SettingsViewProps) {
  const [draft, setDraft] = useState<LauncherSettings>(settings);
  const [ramInput, setRamInput] = useState(String(settings.defaultRamMb));
  const [downloadingJava, setDownloadingJava] = useState<number | null>(null);
  const [javaError, setJavaError] = useState<{ major: number; msg: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [cacheMsg, setCacheMsg] = useState(false);

  const maxRam = Math.max(4096, Math.min(32768, Math.floor(systemInfo.totalRamMb / 1024) * 1024));

  const handleSave = async (next: LauncherSettings) => {
    setDraft(next);
    setRamInput(String(next.defaultRamMb));
    await onSaveSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const commitRamInput = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      setRamInput(String(draft.defaultRamMb));
      return;
    }
    const clamped = Math.max(512, Math.min(systemInfo.totalRamMb, parsed));
    handleSave({ ...draft, defaultRamMb: clamped });
  };

  const handleInstallJava = async (major: number) => {
    setDownloadingJava(major);
    try {
      await api.installJavaRuntime(major);
      await onRefreshSystemInfo();
    } finally {
      setDownloadingJava(null);
    }
  };

  const handlePickJava = async (major: number) => {
    setJavaError(null);
    const picked = await api.pickJavaExecutable(t.javaPickTitle);
    if (!picked) return;
    try {
      const info = await api.probeJava(picked);
      if (info.major !== major) {
        setJavaError({
          major,
          msg: t.javaWrongMajor
            .replace("{found}", String(info.major))
            .replace("{need}", String(major)),
        });
        return;
      }
      await handleSelectJava(major, info.path);
    } catch (e) {
      setJavaError({ major, msg: String(e) });
    }
  };

  const handleSelectJava = async (major: number, path: string) => {
    const key = `java${major}Path` as "java8Path" | "java17Path" | "java21Path" | "java25Path";
    setJavaError(null);
    await handleSave({ ...draft, [key]: path });
    await onRefreshSystemInfo();
  };

  const handleResetJava = async (major: number) => {
    const key = `java${major}Path` as "java8Path" | "java17Path" | "java21Path" | "java25Path";
    setJavaError(null);
    await handleSave({ ...draft, [key]: null });
    await onRefreshSystemInfo();
  };

  const handleClearCache = async () => {
    await api.clearCache();
    setCacheMsg(true);
    setTimeout(() => setCacheMsg(false), 1800);
  };

  const javaSlots = [8, 17, 21, 25];
  const dlOptions = [4, 8, 12, 16];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#141415] mono-view-enter">
      <div className="px-8 pt-6 pb-5 border-b border-[#ededed]/[0.08] flex items-center justify-between">
        <h1 className="text-[28px] leading-8 font-medium tracking-[-0.02em] text-[#ededed]">
          {t.globalSettingsTitle}
        </h1>
        {saved && <span className="text-[13px] text-[#4cc38a]">{t.saved}</span>}
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-2xl space-y-8">
          {/* General */}
          <section className="space-y-5">
            <div className="flex items-center justify-between">
              <span className="text-[14px] text-[#ededed]">{t.language}</span>
              <div className="flex items-center gap-1 p-1 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08]">
                {(
                  [
                    ["ru", "Русский"],
                    ["en", "English"],
                  ] as [Language, string][]
                ).map(([code, label]) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => handleSave({ ...draft, language: code })}
                    className={`h-7 px-3 rounded-[6px] text-[13px] transition-colors duration-150 ${
                      draft.language === code
                        ? "bg-[#232325] text-[#ededed] font-medium"
                        : "text-[#85858b] hover:text-[#a1a1a6]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Default RAM with manual keyboard entry */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[14px] text-[#ededed]">{t.defaultRam}</span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center rounded-[6px] bg-[#19191b] border border-[#ededed]/[0.1] px-2 h-7 focus-within:border-[#ededed]/30">
                    <input
                      type="number"
                      min={512}
                      max={systemInfo.totalRamMb}
                      step={256}
                      value={ramInput}
                      onChange={(e) => setRamInput(e.target.value)}
                      onBlur={() => commitRamInput(ramInput)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRamInput(ramInput);
                      }}
                      className="w-16 bg-transparent font-mono text-[13px] text-[#ededed] text-right focus:outline-none"
                    />
                    <span className="font-mono text-[12px] text-[#85858b] ml-1">MB</span>
                  </div>
                  <span className="font-mono text-[12px] text-[#85858b]">
                    / {systemInfo.totalRamMb} MB
                  </span>
                </div>
              </div>
              <input
                type="range"
                min={1024}
                max={maxRam}
                step={512}
                value={Math.min(maxRam, draft.defaultRamMb)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDraft({ ...draft, defaultRamMb: v });
                  setRamInput(String(v));
                }}
                onMouseUp={() => handleSave(draft)}
                className="w-full"
              />
            </div>

            {/* Default Minecraft Window */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[14px] text-[#ededed]">{t.defaultWindow}</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-[12px] text-[#85858b]">{t.fullscreen}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.defaultFullscreen}
                    onClick={() =>
                      handleSave({ ...draft, defaultFullscreen: !draft.defaultFullscreen })
                    }
                    className={`w-8 h-[18px] rounded-full p-0.5 transition-colors duration-150 ${
                      draft.defaultFullscreen
                        ? "bg-[#ededed]"
                        : "bg-[#232325] border border-[#ededed]/15"
                    }`}
                  >
                    <span
                      className={`block w-3.5 h-3.5 rounded-full transition-transform duration-150 ${
                        draft.defaultFullscreen
                          ? "translate-x-3.5 bg-[#0f0f10]"
                          : "translate-x-0 bg-[#85858b]"
                      }`}
                    />
                  </button>
                </label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  disabled={draft.defaultFullscreen}
                  value={draft.defaultWidth}
                  onChange={(e) => setDraft({ ...draft, defaultWidth: Number(e.target.value) })}
                  onBlur={() => handleSave(draft)}
                  className="w-28 h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] disabled:opacity-40 focus:outline-none focus:border-[#ededed]/25"
                />
                <span className="font-mono text-[12px] text-[#85858b]">×</span>
                <input
                  type="number"
                  disabled={draft.defaultFullscreen}
                  value={draft.defaultHeight}
                  onChange={(e) => setDraft({ ...draft, defaultHeight: Number(e.target.value) })}
                  onBlur={() => handleSave(draft)}
                  className="w-28 h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] disabled:opacity-40 focus:outline-none focus:border-[#ededed]/25"
                />
              </div>
            </div>

            {/* Concurrent Downloads */}
            <div className="flex items-center justify-between">
              <span className="text-[14px] text-[#ededed]">{t.concurrentDownloads}</span>
              <div className="flex items-center gap-1 p-1 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08]">
                {dlOptions.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => handleSave({ ...draft, maxConcurrentDownloads: n })}
                    className={`h-7 px-3 rounded-[6px] font-mono text-[12px] transition-colors duration-150 ${
                      draft.maxConcurrentDownloads === n
                        ? "bg-[#232325] text-[#ededed] font-medium"
                        : "text-[#85858b] hover:text-[#a1a1a6]"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Data Folder + actions */}
            <div>
              <label className="block text-[13px] text-[#a1a1a6] mb-1.5">{t.dataFolder}</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={draft.dataDir}
                  onChange={(e) => setDraft({ ...draft, dataDir: e.target.value })}
                  onBlur={() => handleSave(draft)}
                  className="flex-1 h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] focus:outline-none focus:border-[#ededed]/25"
                />
                <button
                  type="button"
                  onClick={() => api.openDataFolder()}
                  className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px] shrink-0"
                >
                  <FolderOpen size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                  <span>{t.openDataDir}</span>
                </button>
                <button
                  type="button"
                  onClick={handleClearCache}
                  className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px] shrink-0"
                >
                  <Trash2 size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                  <span>{cacheMsg ? t.cacheCleared : t.clearCache}</span>
                </button>
              </div>
            </div>

            {/* Optional CurseForge API key override */}
            <div>
              <label className="block text-[13px] text-[#a1a1a6] mb-1.5">
                {t.curseforgeApiKey}
              </label>
              <input
                type="password"
                value={draft.curseforgeApiKey ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    curseforgeApiKey: e.target.value.trim() ? e.target.value : null,
                  })
                }
                onBlur={() => handleSave(draft)}
                placeholder="•••••••• (built-in)"
                className="w-full h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
              />
              <p className="text-[12px] text-[#85858b] mt-1">{t.curseforgeApiKeyHint}</p>
            </div>

            {/* Azure Application (client) ID for Microsoft login */}
            <div>
              <label className="block text-[13px] text-[#a1a1a6] mb-1.5">
                {t.msaClientIdLabel}
              </label>
              <input
                type="text"
                value={draft.msaClientId ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    msaClientId: e.target.value.trim() ? e.target.value.trim() : null,
                  })
                }
                onBlur={() => handleSave(draft)}
                placeholder="61872cbf-… (built-in)"
                className="w-full h-9 px-3 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08] font-mono text-[13px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
              />
              <p className="text-[12px] text-[#85858b] mt-1">{t.msaClientIdHint}</p>
            </div>

            <div className="space-y-3 pt-1">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-[14px] text-[#ededed]">{t.closeOnLaunch}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.closeOnLaunch}
                  onClick={() => handleSave({ ...draft, closeOnLaunch: !draft.closeOnLaunch })}
                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-150 ${
                    draft.closeOnLaunch ? "bg-[#ededed]" : "bg-[#232325] border border-[#ededed]/15"
                  }`}
                >
                  <span
                    className={`block w-4 h-4 rounded-full transition-transform duration-150 ${
                      draft.closeOnLaunch ? "translate-x-4 bg-[#0f0f10]" : "translate-x-0 bg-[#85858b]"
                    }`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-[14px] text-[#ededed]">{t.openConsoleOnCrash}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.openConsoleOnCrash}
                  onClick={() =>
                    handleSave({ ...draft, openConsoleOnCrash: !draft.openConsoleOnCrash })
                  }
                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-150 ${
                    draft.openConsoleOnCrash
                      ? "bg-[#ededed]"
                      : "bg-[#232325] border border-[#ededed]/15"
                  }`}
                >
                  <span
                    className={`block w-4 h-4 rounded-full transition-transform duration-150 ${
                      draft.openConsoleOnCrash
                        ? "translate-x-4 bg-[#0f0f10]"
                        : "translate-x-0 bg-[#85858b]"
                    }`}
                  />
                </button>
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-[14px] text-[#ededed]">{t.showSnapshots}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.showSnapshots}
                  onClick={() => handleSave({ ...draft, showSnapshots: !draft.showSnapshots })}
                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-150 ${
                    draft.showSnapshots ? "bg-[#ededed]" : "bg-[#232325] border border-[#ededed]/15"
                  }`}
                >
                  <span
                    className={`block w-4 h-4 rounded-full transition-transform duration-150 ${
                      draft.showSnapshots ? "translate-x-4 bg-[#0f0f10]" : "translate-x-0 bg-[#85858b]"
                    }`}
                  />
                </button>
              </label>
            </div>
          </section>

          {/* Java Runtimes (strict major version match: 8, 17, 21, 25) */}
          <section className="pt-6 border-t border-[#ededed]/[0.08]">
            <h2 className="text-[16px] font-medium text-[#ededed]">{t.javaRuntimes}</h2>
            <p className="text-[13px] text-[#85858b] mt-1 mb-4">{t.javaRuntimesHint}</p>

            <div className="rounded-[12px] border border-[#ededed]/[0.08] bg-[#19191b] divide-y divide-[#ededed]/[0.06]">
              {javaSlots.map((major) => {
                const key = `java${major}Path` as "java8Path" | "java17Path" | "java21Path" | "java25Path";
                const configured = draft[key];
                const sameMajor = systemInfo.detectedJavas.filter((j) => j.major === major);
                const norm = (p: string) => p.toLowerCase().replace(/\//g, "\\");
                const configuredHit = configured
                  ? sameMajor.find((j) => norm(j.path) === norm(configured))
                  : undefined;
                const found = configuredHit ?? sameMajor[0];
                const isCustom = !!configured;
                const configuredBroken = isCustom && !configuredHit;
                const busy = downloadingJava === major;
                const err = javaError?.major === major ? javaError.msg : null;
                return (
                  <div key={major} className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5">
                          <span className="font-mono text-[14px] font-medium text-[#ededed]">
                            Java {major}
                          </span>
                          <span
                            className={`text-[12px] ${
                              configuredBroken
                                ? "text-[#e5484d]"
                                : found
                                  ? "text-[#4cc38a]"
                                  : "text-[#85858b]"
                            }`}
                          >
                            {configuredBroken
                              ? t.javaPathMissing
                              : found
                                ? `${t.detected} (${found.versionString} · ${
                                    isCustom ? t.javaCustom : found.managed ? t.managed : t.system
                                  })`
                                : t.missing}
                          </span>
                        </div>
                        {sameMajor.length > 1 ? (
                          <Select
                            value={configuredHit?.path ?? found?.path ?? ""}
                            onChange={(v) => handleSelectJava(major, v)}
                            mono
                            className="mt-2 w-full max-w-md !h-8 text-[12px]"
                            options={sameMajor.map((j) => ({
                              value: j.path,
                              label: `${j.versionString} · ${j.path}`,
                            }))}
                          />
                        ) : (
                          (configuredBroken ? configured : found?.path) && (
                            <div className="font-mono text-[12px] text-[#85858b] truncate mt-1">
                              {configuredBroken ? configured : found?.path}
                            </div>
                          )
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {isCustom && (
                          <button
                            type="button"
                            onClick={() => handleResetJava(major)}
                            className="mono-btn-secondary h-8 px-3 rounded-[8px] text-[13px]"
                          >
                            {t.javaAuto}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handlePickJava(major)}
                          className="mono-btn-secondary h-8 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px]"
                        >
                          <FolderOpen size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                          <span>{found || isCustom ? t.javaChange : t.javaBrowse}</span>
                        </button>
                        {!found && !isCustom && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleInstallJava(major)}
                            className="mono-btn-secondary h-8 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px] disabled:opacity-50"
                          >
                            <Download size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
                            <span>{busy ? t.downloading : t.downloadTemurin}</span>
                          </button>
                        )}
                      </div>
                    </div>
                    {err && <div className="mt-2 text-[12px] text-[#e5484d]">{err}</div>}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
