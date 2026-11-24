import { useEffect, useRef, useState } from "react";
import { FileJson } from "lucide-react";
import type { Dict } from "../i18n";
import { api } from "../lib/api";
import type { LoaderType, McVersionInfo } from "../types";
import { Select } from "./Select";

export const LOADERS: [LoaderType, string][] = [
  ["vanilla", "Vanilla"],
  ["fabric", "Fabric"],
  ["quilt", "Quilt"],
  ["forge", "Forge"],
  ["neoforge", "NeoForge"],
  ["custom", "Custom"],
];

export function loaderLabel(loader: LoaderType, t?: Dict): string {
  if (loader === "custom" && t) return t.loaderCustom;
  return LOADERS.find(([id]) => id === loader)?.[1] ?? loader;
}

interface LoaderFieldsProps {
  t: Dict;
  showSnapshots: boolean;
  mcVersion: string;
  onMcVersion: (v: string) => void;
  loader: LoaderType;
  onLoader: (l: LoaderType) => void;
  loaderVersion: string;
  onLoaderVersion: (v: string) => void;
  /** Newly picked custom loader JSON (not yet copied into the instance). */
  customPath: string | null;
  onCustomPath: (p: string | null) => void;
  /** Pick the newest MC version automatically once the list loads (create form). */
  autoSelectLatest?: boolean;
  /** Already installed custom profile exists (instance settings). */
  hasExistingCustom?: boolean;
  onError?: (msg: string | null) => void;
}

const fieldLabel = "block text-[13px] text-[#a1a1a6] mb-1.5";

export function LoaderFields({
  t,
  showSnapshots,
  mcVersion,
  onMcVersion,
  loader,
  onLoader,
  loaderVersion,
  onLoaderVersion,
  customPath,
  onCustomPath,
  autoSelectLatest = false,
  hasExistingCustom = false,
  onError,
}: LoaderFieldsProps) {
  const [versions, setVersions] = useState<McVersionInfo[]>([]);
  const [loaderVersions, setLoaderVersions] = useState<string[]>([]);
  const [loadingLoader, setLoadingLoader] = useState(false);
  const currentLoaderVersion = useRef(loaderVersion);
  // Remember what the form started with so an existing, valid-but-old loader version is not overwritten.
  const initialKey = useRef(`${loader}|${mcVersion}`);
  currentLoaderVersion.current = loaderVersion;

  useEffect(() => {
    let alive = true;
    api
      .fetchMcVersions(showSnapshots)
      .then((list) => {
        if (!alive) return;
        setVersions(list);
        if (autoSelectLatest && list[0]) onMcVersion(list[0].id);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSnapshots]);

  useEffect(() => {
    if (loader === "vanilla" || loader === "custom") {
      setLoaderVersions([]);
      if (loader === "vanilla") onLoaderVersion("");
      return;
    }
    let alive = true;
    setLoadingLoader(true);
    api
      .fetchLoaderVersions(loader, mcVersion)
      .then((list) => {
        if (!alive) return;
        setLoaderVersions(list);
        // keep the current choice when it is still valid, otherwise take the newest
        const cur = currentLoaderVersion.current;
        const untouched = `${loader}|${mcVersion}` === initialKey.current;
        if (!list.includes(cur) && !(cur && untouched)) onLoaderVersion(list[0] ?? "");
      })
      .catch(() => {
        if (!alive) return;
        setLoaderVersions([]);
        onLoaderVersion("");
      })
      .finally(() => alive && setLoadingLoader(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, mcVersion]);

  const handlePickProfile = async () => {
    onError?.(null);
    const picked = await api.pickLoaderProfile(t.customLoaderPick);
    if (!picked) return;
    try {
      const label = await api.inspectCustomLoader(picked);
      onCustomPath(picked);
      onLoaderVersion(label);
    } catch (e) {
      onError?.(String(e));
    }
  };

  const mcOptions = (() => {
    const base = versions.length === 0 ? [] : versions.map((v) => v.id);
    if (mcVersion && !base.includes(mcVersion)) base.unshift(mcVersion);
    return base.map((id) => ({ value: id, label: id }));
  })();

  const customReady = customPath !== null || hasExistingCustom;

  return (
    <>
      <div>
        <label className={fieldLabel}>{t.version}</label>
        <Select
          value={mcVersion}
          onChange={onMcVersion}
          mono
          className="w-full !bg-[#141415]"
          options={mcOptions.length ? mcOptions : [{ value: mcVersion, label: mcVersion }]}
        />
      </div>

      <div>
        <label className={fieldLabel}>{t.loader}</label>
        <div className="grid grid-cols-3 gap-1 p-1 rounded-[8px] bg-[#141415] border border-[#ededed]/[0.08]">
          {LOADERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onLoader(id)}
              className={`h-8 rounded-[6px] text-[13px] transition-colors duration-150 ${
                loader === id
                  ? "bg-[#232325] text-[#ededed] font-medium"
                  : "text-[#85858b] hover:text-[#a1a1a6]"
              }`}
            >
              {id === "custom" ? t.loaderCustom : label}
            </button>
          ))}
        </div>
      </div>

      {loader !== "vanilla" && loader !== "custom" && (
        <div>
          <label className={fieldLabel}>{t.loaderVersion}</label>
          <Select
            value={loaderVersion}
            onChange={onLoaderVersion}
            mono
            className="w-full !bg-[#141415]"
            options={
              loaderVersions.length === 0 && !loaderVersion
                ? [{ value: "", label: loadingLoader ? t.loadingMore : t.latestAuto }]
                : (loaderVersions.includes(loaderVersion) || !loaderVersion
                    ? loaderVersions
                    : [loaderVersion, ...loaderVersions]
                  ).map((lv) => ({ value: lv, label: lv }))
            }
          />
        </div>
      )}

      {loader === "custom" && (
        <div>
          <label className={fieldLabel}>{t.customLoaderFile}</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 h-9 px-3 rounded-[8px] bg-[#141415] border border-[#ededed]/[0.08] flex items-center">
              <span
                className={`truncate font-mono text-[12px] ${
                  customReady ? "text-[#ededed]" : "text-[#85858b]"
                }`}
              >
                {customPath
                  ? customPath.split(/[\\/]/).pop()
                  : customReady
                    ? loaderVersion
                    : t.customLoaderNone}
              </span>
            </div>
            <button
              type="button"
              onClick={handlePickProfile}
              className="mono-btn-secondary h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px] shrink-0"
            >
              <FileJson size={14} strokeWidth={1.5} className="text-[#a1a1a6]" />
              <span>{customReady ? t.javaChange : t.javaBrowse}</span>
            </button>
          </div>
          <p className="text-[12px] text-[#85858b] mt-1.5 leading-[16px]">{t.customLoaderHint}</p>
        </div>
      )}
    </>
  );
}
