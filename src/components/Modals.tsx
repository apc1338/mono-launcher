import { useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink, Loader2, Trash2, X } from "lucide-react";
import type { Dict } from "../i18n";
import { api } from "../lib/api";
import { LoaderFields, loaderLabel } from "./LoaderFields";
import { Select } from "./Select";
import type {
  AccountsStore,
  Edition,
  HorizonBuildStatus,
  Instance,
  LoaderType,
  MsaDeviceCode,
} from "../types";

const RUST_MC_VERSION = "26.3";

interface CreateInstanceModalProps {
  t: Dict;
  showSnapshots: boolean;
  onClose: () => void;
  onCreated: (inst: Instance) => void;
  /** Opens the .mrpack picker; resolves to true if a pack was imported. */
  onImportMrpack: () => Promise<boolean>;
}

export function CreateInstanceModal({
  t,
  showSnapshots,
  onClose,
  onCreated,
  onImportMrpack,
}: CreateInstanceModalProps) {
  const [name, setName] = useState("");
  const [edition, setEdition] = useState<Edition>("java");
  const isRust = edition === "rust";
  const [mcVersion, setMcVersion] = useState("1.21.4");
  const [loader, setLoader] = useState<LoaderType>("fabric");
  const [loaderVersion, setLoaderVersion] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [horizonStatus, setHorizonStatus] = useState<HorizonBuildStatus | null>(null);
  const [importingBuild, setImportingBuild] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isRust) return;
    api.getHorizonStatus().then(setHorizonStatus).catch(() => {});
  }, [isRust]);

  const handlePickHorizonBuild = async (archive: boolean) => {
    setError(null);
    const picked = await api.pickHorizonBuild(t.horizonBuildTitle, archive);
    if (!picked) return;
    setImportingBuild(true);
    try {
      const st = await api.importHorizonBuild(picked);
      setHorizonStatus(st);
    } catch (err) {
      setError(String(err));
    } finally {
      setImportingBuild(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      await onImportMrpack();
    } finally {
      setImporting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const finalName = name.trim() || (isRust ? `Rust ${RUST_MC_VERSION}` : `${loaderLabel(loader, t)} ${mcVersion}`);
      const inst = await api.createInstance({
        name: finalName,
        edition,
        mcVersion: isRust ? RUST_MC_VERSION : mcVersion,
        loader: isRust ? "vanilla" : loader,
        loaderVersion: isRust || loader === "vanilla" ? null : loaderVersion || null,
      });
      onCreated(inst);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4 mono-backdrop-enter"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-[16px] bg-[#19191b] border border-[#ededed]/[0.1] p-6 mono-modal-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[18px] font-medium text-[#ededed]">{t.createTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06]"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1 p-1 mb-4 rounded-[8px] bg-[#141415] border border-[#ededed]/[0.08]">
          {(["java", "rust"] as Edition[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setEdition(id)}
              className={`h-8 rounded-[6px] text-[13px] transition-colors duration-150 ${
                edition === id
                  ? "bg-[#232325] text-[#ededed] font-medium"
                  : "text-[#85858b] hover:text-[#a1a1a6]"
              }`}
            >
              {id === "java" ? t.editionJava : t.editionRust}
            </button>
          ))}
        </div>

        {!isRust && (
          <>
        <button
          type="button"
          onClick={handleImport}
          disabled={importing || busy}
          className="w-full h-12 px-3.5 rounded-[10px] bg-[#141415] border border-[#ededed]/[0.08] hover:border-[#ededed]/[0.18] transition-colors duration-150 flex items-center gap-3 text-left disabled:opacity-60"
        >
          <Download size={16} strokeWidth={1.5} className="shrink-0 text-[#a1a1a6]" />
          <span className="min-w-0">
            <span className="block text-[13px] leading-[16px] text-[#ededed]">
              {importing ? t.downloading : t.importFromFile}
            </span>
            <span className="block text-[12px] leading-[16px] text-[#85858b]">
              {t.importFromFileHint}
            </span>
          </span>
        </button>

        <div className="my-4 flex items-center gap-3 text-[12px] text-[#85858b]">
          <span className="flex-1 h-px bg-[#ededed]/[0.08]" />
          <span>{t.orCreateManually}</span>
          <span className="flex-1 h-px bg-[#ededed]/[0.08]" />
        </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[13px] text-[#a1a1a6] mb-1.5">{t.instanceName}</label>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.namePlaceholder}
              className="w-full h-9 px-3 rounded-[8px] bg-[#141415] border border-[#ededed]/[0.08] text-[14px] text-[#ededed] placeholder:text-[#85858b] focus:outline-none focus:border-[#ededed]/25"
            />
          </div>

          {isRust ? (
            <>
              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-1.5">{t.version}</label>
                <Select
                  value={RUST_MC_VERSION}
                  onChange={() => {}}
                  mono
                  className="w-full !bg-[#141415]"
                  options={[{ value: RUST_MC_VERSION, label: `${RUST_MC_VERSION} (Horizon Nightly)` }]}
                />
              </div>
              <div className="rounded-[8px] border border-[#ededed]/[0.1] bg-[#141415] px-3 py-2.5 text-[12px] leading-[17px] text-[#a1a1a6] space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#ededed] font-medium">{t.horizonBuildTitle}</span>
                  {horizonStatus?.found && (
                    <span className="font-mono text-[11px] text-[#85858b] truncate max-w-[190px]">
                      {horizonStatus.tag}
                    </span>
                  )}
                </div>
                {horizonStatus?.found ? (
                  <p className="text-[#30a46c]">
                    {horizonStatus.prepared ? t.horizonPreparedYes : t.horizonPreparedNo}
                  </p>
                ) : (
                  <p className="text-[#e5a000]">{t.horizonBuildMissing}</p>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={importingBuild}
                    onClick={() => handlePickHorizonBuild(false)}
                    className="mono-btn-secondary h-7 px-2.5 rounded-[6px] text-[12px] disabled:opacity-50"
                  >
                    {importingBuild ? t.horizonBuildImporting : t.horizonBuildPickFolder}
                  </button>
                  <button
                    type="button"
                    disabled={importingBuild}
                    onClick={() => handlePickHorizonBuild(true)}
                    className="mono-btn-secondary h-7 px-2.5 rounded-[6px] text-[12px] disabled:opacity-50"
                  >
                    {t.horizonBuildPickZip}
                  </button>
                </div>
                <p>{t.rustNoteResources}</p>
                <p>{t.rustNoteSteps}</p>
                <p className="text-[#85858b]">{t.rustNoteUnofficial}</p>
              </div>
            </>
          ) : (
          <LoaderFields
            t={t}
            showSnapshots={showSnapshots}
            mcVersion={mcVersion}
            onMcVersion={setMcVersion}
            loader={loader}
            onLoader={setLoader}
            loaderVersion={loaderVersion}
            onLoaderVersion={setLoaderVersion}
            autoSelectLatest
          />
          )}

          {error && <div className="text-[13px] text-[#e5484d]">{error}</div>}

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="mono-btn-secondary h-9 px-4 rounded-[8px] text-[13px]"
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              disabled={busy || importing}
              className="mono-btn-primary h-9 px-4 rounded-[8px] text-[13px] font-medium disabled:opacity-50"
            >
              {t.create}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
interface AccountsModalProps {
  t: Dict;
  store: AccountsStore;
  onClose: () => void;
  onUpdated: (store: AccountsStore) => void;
}

function accountTypeLabel(type: AccountsStore["accounts"][number]["accountType"], t: Dict): string {
  if (type === "microsoft") return t.microsoft;
  if (type === "elyby") return t.elyby;
  return t.offline;
}

export function AccountsModal({
  t,
  store,
  onClose,
  onUpdated,
}: AccountsModalProps) {
  const [tab, setTab] = useState<"offline" | "microsoft" | "elyby">("offline");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceCode, setDeviceCode] = useState<MsaDeviceCode | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      api.cancelMicrosoftLogin().catch(() => {});
    };
  }, []);

  const cancelMsaFlow = () => {
    api.cancelMicrosoftLogin().catch(() => {});
    setDeviceCode(null);
    setBusy(false);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated =
        tab === "offline"
          ? await api.addOfflineAccount(username)
          : await api.addElybyAccount(username, password);
      onUpdated(updated);
      setUsername("");
      setPassword("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStartMicrosoft = async () => {
    setError(null);
    setBusy(true);
    try {
      const dc = await api.startMicrosoftLogin();
      setDeviceCode(dc);
      try {
        await navigator.clipboard.writeText(dc.userCode);
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 1800);
      } catch {
        // clipboard may be unavailable
      }
      await api.openExternalUrl(dc.verificationUri);

      const updated = await api.completeMicrosoftLogin({
        deviceCode: dc.deviceCode,
        interval: dc.interval,
        expiresIn: dc.expiresIn,
      });
      onUpdated(updated);
      setDeviceCode(null);
    } catch (err) {
      const msg = String(err);
      if (msg !== "cancelled" && !msg.endsWith("cancelled")) {
        setError(msg);
      }
      setDeviceCode(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4 mono-backdrop-enter"
      onClick={() => {
        cancelMsaFlow();
        onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-[16px] bg-[#19191b] border border-[#ededed]/[0.1] p-6 mono-modal-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[18px] font-medium text-[#ededed]">{t.accountsTitle}</h2>
          <button
            type="button"
            onClick={() => {
              cancelMsaFlow();
              onClose();
            }}
            className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[#85858b] hover:text-[#ededed] hover:bg-[#ededed]/[0.06]"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Saved accounts */}
        {store.accounts.length > 0 && (
          <div className="mb-5 max-h-52 overflow-y-auto rounded-[10px] border border-[#ededed]/[0.08] bg-[#141415] divide-y divide-[#ededed]/[0.06]">
            {store.accounts.map((acc) => {
              const isActive = store.activeId === acc.id;
              return (
                <div
                  key={acc.id}
                  onClick={async () => {
                    const updated = await api.setActiveAccount(acc.id);
                    onUpdated(updated);
                  }}
                  className="px-3 py-2.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-[#ededed]/[0.03]"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <img
                      src={`https://mc-heads.net/avatar/${encodeURIComponent(acc.username)}/28`}
                      alt={acc.username}
                      className="w-7 h-7 rounded-[6px] bg-[#232325] shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="text-[14px] text-[#ededed] font-medium truncate">
                        {acc.username}
                      </div>
                      <div className="text-[12px] text-[#85858b]">
                        {accountTypeLabel(acc.accountType, t)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isActive && <Check size={15} strokeWidth={1.5} className="text-[#4cc38a]" />}
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const updated = await api.removeAccount(acc.id);
                        onUpdated(updated);
                      }}
                      className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[#85858b] hover:text-[#e5484d] hover:bg-[#e5484d]/10"
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add account tabs */}
        <div className="grid grid-cols-3 gap-1 p-1 rounded-[8px] bg-[#141415] border border-[#ededed]/[0.08] mb-4">
          {(
            [
              ["offline", t.offlineTab],
              ["microsoft", t.microsoftTab],
              ["elyby", t.elybyTab],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (tab === "microsoft" && id !== "microsoft") cancelMsaFlow();
                setError(null);
                setTab(id);
              }}
              className={`h-8 rounded-[6px] text-[13px] transition-colors duration-150 ${
                tab === id
                  ? "bg-[#232325] text-[#ededed] font-medium"
                  : "text-[#85858b] hover:text-[#a1a1a6]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "microsoft" ? (
          <div className="space-y-3">
            {deviceCode ? (
              <div className="rounded-[10px] border border-[#ededed]/[0.1] bg-[#141415] p-4 space-y-3">
                <div className="text-[12px] text-[#a1a1a6]">{t.msaEnterCodeAt}:</div>

                <div className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-[8px] bg-[#19191b] border border-[#ededed]/[0.08]">
                  <span className="font-mono text-[20px] font-medium tracking-[0.14em] text-[#ededed] select-all">
                    {deviceCode.userCode}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(deviceCode.userCode);
                      setCopiedCode(true);
                      setTimeout(() => setCopiedCode(false), 1500);
                    }}
                    className="mono-btn-secondary h-8 px-2.5 rounded-[6px] flex items-center gap-1.5 text-[12px] shrink-0"
                  >
                    <Copy size={13} strokeWidth={1.5} />
                    <span>{copiedCode ? t.msaCopied : t.msaCopyCode}</span>
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="flex items-center gap-2 text-[12px] text-[#85858b] truncate">
                    <Loader2 size={13} strokeWidth={1.75} className="animate-spin shrink-0" />
                    <span className="truncate">{t.msaWaiting}</span>
                  </span>

                  <button
                    type="button"
                    onClick={() => api.openExternalUrl(deviceCode.verificationUri)}
                    className="mono-btn-secondary h-7 px-2.5 rounded-[6px] flex items-center gap-1.5 text-[12px] shrink-0"
                  >
                    <ExternalLink size={12} strokeWidth={1.5} />
                    <span>{t.msaOpenBrowser}</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={cancelMsaFlow}
                  className="mono-btn-secondary w-full h-8 rounded-[8px] text-[12px]"
                >
                  {t.cancel}
                </button>
              </div>
            ) : (
              <>
                <p className="text-[12px] text-[#85858b]">{t.msaHint}</p>

                {error && <div className="text-[13px] text-[#e5484d]">{error}</div>}

                <button
                  type="button"
                  disabled={busy}
                  onClick={handleStartMicrosoft}
                  className="mono-btn-primary w-full h-9 rounded-[8px] text-[13px] font-medium disabled:opacity-50 mt-1"
                >
                  {t.msaSignInBtn}
                </button>
              </>
            )}
          </div>
        ) : (
          <form onSubmit={handleAdd} className="space-y-3">
            <div>
              <label className="block text-[13px] text-[#a1a1a6] mb-1.5">
                {tab === "offline" ? t.username : t.emailOrLogin}
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full h-9 px-3 rounded-[8px] bg-[#141415] border border-[#ededed]/[0.08] text-[14px] text-[#ededed] focus:outline-none focus:border-[#ededed]/25"
              />
            </div>

            {tab === "elyby" && (
              <>
                <div>
                  <label className="block text-[13px] text-[#a1a1a6] mb-1.5">{t.password}</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-9 px-3 rounded-[8px] bg-[#141415] border border-[#ededed]/[0.08] text-[14px] text-[#ededed] focus:outline-none focus:border-[#ededed]/25"
                  />
                </div>
                <p className="text-[12px] text-[#85858b]">{t.elybyHint}</p>
              </>
            )}

            {error && <div className="text-[13px] text-[#e5484d]">{error}</div>}

            <button
              type="submit"
              disabled={busy}
              className="mono-btn-primary w-full h-9 rounded-[8px] text-[13px] font-medium disabled:opacity-50 mt-2"
            >
              {tab === "offline" ? t.addOffline : t.signIn}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
