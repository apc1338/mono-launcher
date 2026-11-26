import { useEffect, useRef, useState } from "react";
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
];

export function loaderLabel(loader: LoaderType, _t?: Dict): string {
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
  /** Pick the newest MC version automatically once the list loads (create form). */
  autoSelectLatest?: boolean;
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
  autoSelectLatest = false,
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

  const mcOptions = (() => {
    const base = versions.length === 0 ? [] : versions.map((v) => v.id);
    if (mcVersion && !base.includes(mcVersion)) base.unshift(mcVersion);
    return base.map((id) => ({ value: id, label: id }));
  })();

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
        <div className="grid grid-cols-5 gap-1 p-1 rounded-[8px] bg-[#141415] border border-[#ededed]/[0.08]">
          {LOADERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onLoader(id)}
              className={`h-8 rounded-[6px] text-[12px] transition-colors duration-150 ${
                loader === id
                  ? "bg-[#232325] text-[#ededed] font-medium"
                  : "text-[#85858b] hover:text-[#a1a1a6]"
              }`}
            >
              {label}
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
    </>
  );
}
