import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  ActiveView,
  Sidebar,
  SIDEBAR_COMPACT_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "./components/Sidebar";
import { HomeView } from "./components/HomeView";
import { AllInstancesView } from "./components/AllInstancesView";
import { InstanceView } from "./components/InstanceView";
import { ModrinthView } from "./components/ModrinthView";
import { SettingsView } from "./components/SettingsView";
import { AccountsModal, CreateInstanceModal } from "./components/Modals";
import { PackProgressTray, PendingDownloadsModal } from "./components/PackInstallOverlays";
import { getDict } from "./i18n";
import { api } from "./lib/api";
import type {
  AccountsStore,
  GameLogEvent,
  Instance,
  InstanceRuntimeStatus,
  LauncherSettings,
  LauncherUpdateInfo,
  LauncherUpdateProgressEvent,
  LaunchProgressEvent,
  PackInstallResult,
  PackProgressEvent,
  PendingDownload,
  SystemInfo,
} from "./types";

export default function App() {
  const [settings, setSettings] = useState<LauncherSettings>({
    language: "ru",
    dataDir: "",
    defaultRamMb: 4096,
    closeOnLaunch: false,
    showSnapshots: false,
    openConsoleOnCrash: true,
    defaultWidth: 1280,
    defaultHeight: 720,
    defaultFullscreen: false,
    maxConcurrentDownloads: 8,
    java8Path: null,
    java17Path: null,
    java21Path: null,
    java25Path: null,
    curseforgeApiKey: null,
    msaClientId: null,
  });
  const [systemInfo, setSystemInfo] = useState<SystemInfo>({
    totalRamMb: 16384,
    detectedJavas: [],
  });
  const [accounts, setAccounts] = useState<AccountsStore>({
    activeId: null,
    accounts: [],
  });
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeView, setActiveView] = useState<ActiveView>({ type: "home" });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("mono.sidebarWidth"));
      if (
        Number.isFinite(saved) &&
        saved >= SIDEBAR_COMPACT_WIDTH &&
        saved <= SIDEBAR_MAX_WIDTH
      ) {
        return saved;
      }
    } catch {
      // ignore storage errors
    }
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const handleResizeSidebar = useCallback((w: number) => {
    setSidebarWidth(w);
    try {
      localStorage.setItem("mono.sidebarWidth", String(w));
    } catch {
      // ignore storage errors
    }
  }, []);
  const [statuses, setStatuses] = useState<Record<string, InstanceRuntimeStatus>>({});
  const [progressMap, setProgressMap] = useState<Record<string, LaunchProgressEvent | null>>({});
  const [logsMap, setLogsMap] = useState<Record<string, GameLogEvent[]>>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAccountsModal, setShowAccountsModal] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [packTasks, setPackTasks] = useState<Record<string, PackProgressEvent>>({});
  const [pendingModal, setPendingModal] = useState<{
    instanceId: string;
    instanceName: string;
    items: PendingDownload[];
  } | null>(null);
  const [pendingRefreshKey, setPendingRefreshKey] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<LauncherUpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<LauncherUpdateProgressEvent | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const t = useMemo(() => getDict(settings.language), [settings.language]);

  const activeAccount = useMemo(() => {
    if (!accounts.accounts.length) return null;
    return (
      accounts.accounts.find((a) => a.id === accounts.activeId) ?? accounts.accounts[0]
    );
  }, [accounts]);

  const refreshSystemInfo = useCallback(async () => {
    const info = await api.getSystemInfo();
    setSystemInfo(info);
  }, []);

  useEffect(() => {
    (async () => {
      // System info (java detection) is slow; load it separately so it never blocks the UI.
      api.getSystemInfo().then(setSystemInfo).catch(() => {});
      const [s, accs, insts] = await Promise.all([
        api.getSettings(),
        api.getAccounts(),
        api.listInstances(),
      ]);
      setSettings(s);
      setAccounts(accs);
      setInstances(insts);
      // Silent background check for new GitHub releases
      api
        .checkLauncherUpdate()
        .then((info) => {
          if (info) setUpdateInfo(info);
        })
        .catch(() => {});
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    api
      .onLauncherUpdateProgress((ev) => setUpdateProgress(ev))
      .then((u) => {
        if (cancelled) u();
        else unsub = u;
      });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  // Tauri event subscriptions
  useEffect(() => {
    let cancelled = false;
    let unProgress: (() => void) | undefined;
    let unLog: (() => void) | undefined;
    let unStatus: (() => void) | undefined;
    let unPack: (() => void) | undefined;

    api.onPackProgress((ev) => {
      setPackTasks((prev) => ({ ...prev, [ev.taskId]: ev }));
      if (ev.stage === "done") {
        setTimeout(() => {
          setPackTasks((prev) => {
            if (!prev[ev.taskId] || prev[ev.taskId].stage !== "done") return prev;
            const next = { ...prev };
            delete next[ev.taskId];
            return next;
          });
        }, 2500);
      }
    }).then((u) => {
      if (cancelled) u();
      else unPack = u;
    });

    api.onLaunchProgress((ev) => {
      setProgressMap((prev) => ({
        ...prev,
        [ev.instanceId]: ev.stage === "done" ? null : ev,
      }));
    }).then((u) => {
      if (cancelled) u();
      else unProgress = u;
    });

    api.onGameLog((ev) => {
      setLogsMap((prev) => {
        const list = prev[ev.instanceId] ?? [];
        const next = list.length > 1500 ? [...list.slice(-1200), ev] : [...list, ev];
        return { ...prev, [ev.instanceId]: next };
      });
    }).then((u) => {
      if (cancelled) u();
      else unLog = u;
    });

    api.onInstanceStatus((ev) => {
      setStatuses((prev) => ({ ...prev, [ev.instanceId]: ev.status }));
      if (ev.status !== "launching") {
        setProgressMap((prev) => ({ ...prev, [ev.instanceId]: null }));
      }
      if (ev.status === "running" && settings.closeOnLaunch) {
        api.window.hide();
      }
      if (ev.status === "crashed" && settings.openConsoleOnCrash) {
        setActiveView({ type: "instance", instanceId: ev.instanceId, initialTab: "console" });
      }
      if (ev.status === "idle" || ev.status === "crashed") {
        if (settings.closeOnLaunch) {
          api.window.restore();
        }
        api.listInstances().then(setInstances).catch(() => {});
      }
    }).then((u) => {
      if (cancelled) u();
      else unStatus = u;
    });

    return () => {
      cancelled = true;
      unProgress?.();
      unLog?.();
      unStatus?.();
      unPack?.();
    };
  }, [settings.closeOnLaunch, settings.openConsoleOnCrash]);

  const selectedInstance = useMemo(() => {
    if (activeView.type !== "instance") return null;
    return instances.find((i) => i.id === activeView.instanceId) ?? null;
  }, [activeView, instances]);

  const handleLaunch = useCallback(
    async (instanceId: string, quickPlayWorld?: string | null) => {
      setBannerError(null);
      if (!activeAccount) {
        setShowAccountsModal(true);
        return;
      }
      try {
        await api.launchInstance(instanceId, quickPlayWorld);
      } catch (err) {
        setStatuses((prev) => ({ ...prev, [instanceId]: "idle" }));
        setProgressMap((prev) => ({ ...prev, [instanceId]: null }));
        setBannerError(String(err));
      }
    },
    [activeAccount]
  );

  // Global keyboard shortcuts: Ctrl+Enter (launch active instance)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "Enter" &&
        selectedInstance &&
        !showCreateModal &&
        !showAccountsModal
      ) {
        const st = statuses[selectedInstance.id] ?? "idle";
        if (st === "idle" || st === "crashed") {
          e.preventDefault();
          handleLaunch(selectedInstance.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedInstance, statuses, showCreateModal, showAccountsModal, handleLaunch]);

  const handlePackInstalled = useCallback((res: PackInstallResult, isUpdate = false) => {
    setInstances((prev) => {
      if (isUpdate || prev.some((i) => i.id === res.instance.id)) {
        return prev.map((i) => (i.id === res.instance.id ? res.instance : i));
      }
      const favs = prev.filter((i) => i.favorite);
      const regs = prev.filter((i) => !i.favorite);
      return [...favs, res.instance, ...regs];
    });
    if (!isUpdate) {
      setActiveView({ type: "instance", instanceId: res.instance.id });
    }
    setPendingRefreshKey((k) => k + 1);
    if (res.pending.length > 0) {
      setPendingModal({
        instanceId: res.instance.id,
        instanceName: res.instance.name,
        items: res.pending,
      });
    }
  }, []);

  const handleImportMrpack = async (): Promise<boolean> => {
    setBannerError(null);
    try {
      const res = await api.importMrpackDialog();
      if (res) {
        handlePackInstalled(res, false);
        return true;
      }
    } catch (err) {
      setBannerError(String(err));
    }
    return false;
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#141415] text-[#ededed] overflow-hidden">
      {bannerError && (
        <div className="px-4 py-2 bg-[#e5484d]/15 border-b border-[#e5484d]/25 flex items-center justify-between gap-4 text-[13px] text-[#e5484d]">
          <span className="truncate">{bannerError}</span>
          <button
            type="button"
            onClick={() => setBannerError(null)}
            className="text-[12px] hover:underline shrink-0"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <Sidebar
          t={t}
          instances={instances}
          statuses={statuses}
          activeView={activeView}
          activeAccount={activeAccount}
          width={sidebarWidth}
          onResizeWidth={handleResizeSidebar}
          onOpenHome={() => setActiveView({ type: "home" })}
          onOpenAllInstances={() => setActiveView({ type: "instances" })}
          onSelectInstance={(id, initialTab) =>
            setActiveView({ type: "instance", instanceId: id, initialTab })
          }
          onOpenModrinth={() => setActiveView({ type: "modrinth" })}
          onOpenSettings={() => setActiveView({ type: "settings" })}
          onOpenCreateModal={() => setShowCreateModal(true)}
          onOpenAccountsModal={() => setShowAccountsModal(true)}
          onLaunchInstance={handleLaunch}
          onStopInstance={(id) => api.stopInstance(id)}
          onToggleFavorite={async (id) => {
            const target = instances.find((i) => i.id === id);
            if (!target) return;
            const updated: Instance = { ...target, favorite: !target.favorite };
            const others = instances.filter((i) => i.id !== id);
            const favs = others.filter((i) => i.favorite);
            const regs = others.filter((i) => !i.favorite);
            const next = updated.favorite ? [updated, ...favs, ...regs] : [...favs, updated, ...regs];
            setInstances(next);
            try {
              await api.updateInstance(updated);
              await api.reorderInstances(next.map((i) => i.id));
            } catch (err) {
              setBannerError(String(err));
            }
          }}
          onRenameInstance={async (id, newName) => {
            const target = instances.find((i) => i.id === id);
            if (!target) return;
            const updated: Instance = { ...target, name: newName };
            setInstances((prev) => prev.map((i) => (i.id === id ? updated : i)));
            try {
              await api.updateInstance(updated);
            } catch (err) {
              setBannerError(String(err));
            }
          }}
          onCloneInstance={async (id) => {
            const target = instances.find((i) => i.id === id);
            if (!target) return;
            try {
              const cloned = await api.cloneInstance(id, `${target.name} (Copy)`);
              setInstances((prev) => {
                const favs = prev.filter((i) => i.favorite);
                const regs = prev.filter((i) => !i.favorite);
                return [...favs, cloned, ...regs];
              });
              setActiveView({ type: "instance", instanceId: cloned.id });
            } catch (err) {
              setBannerError(String(err));
            }
          }}
          onOpenInstanceFolder={(id) => {
            api.openInstanceFolder(id).catch((err) => setBannerError(String(err)));
          }}
          onDeleteInstance={async (id) => {
            try {
              await api.deleteInstance(id);
              setInstances((prev) => prev.filter((i) => i.id !== id));
              if (activeView.type === "instance" && activeView.instanceId === id) {
                setActiveView({ type: "home" });
              }
            } catch (err) {
              setBannerError(String(err));
            }
          }}
          onReorderGroup={async (group, orderedIds) => {
            const favs = instances.filter((i) => i.favorite);
            const regs = instances.filter((i) => !i.favorite);
            const byId = new Map(instances.map((i) => [i.id, i]));
            const reordered = orderedIds
              .map((id) => byId.get(id))
              .filter((x): x is Instance => Boolean(x));
            const next = group === "favorite" ? [...reordered, ...regs] : [...favs, ...reordered];
            setInstances(next);
            try {
              await api.reorderInstances(next.map((i) => i.id));
            } catch (err) {
              setBannerError(String(err));
            }
          }}
          updateInfo={updateInfo}
          updateBusy={updateBusy}
          updateProgress={updateProgress}
          updateError={updateError}
          onInstallUpdate={async () => {
            if (!updateInfo) return;
            setUpdateBusy(true);
            setUpdateError(null);
            setUpdateProgress(null);
            try {
              await api.installLauncherUpdate(updateInfo.downloadUrl);
            } catch (err) {
              setUpdateError(String(err));
              setUpdateBusy(false);
            }
          }}
          onDismissUpdate={() => {
            setUpdateInfo(null);
            setUpdateError(null);
          }}
        />

        <main className="flex-1 flex min-w-0 min-h-0">
          {activeView.type === "home" && (
            <HomeView
              t={t}
              language={settings.language}
              instances={instances}
              statuses={statuses}
              activeAccount={activeAccount}
              onSelectInstance={(id) => setActiveView({ type: "instance", instanceId: id })}
              onLaunchInstance={handleLaunch}
              onStopInstance={(id) => api.stopInstance(id)}
              onOpenInstanceFolder={(id) => {
                api.openInstanceFolder(id).catch((err) => setBannerError(String(err)));
              }}
              onOpenAllInstances={() => setActiveView({ type: "instances" })}
              onCreateInstance={() => setShowCreateModal(true)}
            />
          )}

          {activeView.type === "instances" && (
            <AllInstancesView
              t={t}
              instances={instances}
              statuses={statuses}
              onSelectInstance={(id, initialTab) =>
                setActiveView({ type: "instance", instanceId: id, initialTab })
              }
              onLaunchInstance={handleLaunch}
              onStopInstance={(id) => api.stopInstance(id)}
              onToggleFavorite={async (id) => {
                const target = instances.find((i) => i.id === id);
                if (!target) return;
                const updated: Instance = { ...target, favorite: !target.favorite };
                const others = instances.filter((i) => i.id !== id);
                const favs = others.filter((i) => i.favorite);
                const regs = others.filter((i) => !i.favorite);
                const next = updated.favorite
                  ? [updated, ...favs, ...regs]
                  : [...favs, updated, ...regs];
                setInstances(next);
                try {
                  await api.updateInstance(updated);
                  await api.reorderInstances(next.map((i) => i.id));
                } catch (err) {
                  setBannerError(String(err));
                }
              }}
              onOpenInstanceFolder={(id) => {
                api.openInstanceFolder(id).catch((err) => setBannerError(String(err)));
              }}
              onDeleteInstance={async (id) => {
                try {
                  await api.deleteInstance(id);
                  setInstances((prev) => prev.filter((i) => i.id !== id));
                } catch (err) {
                  setBannerError(String(err));
                }
              }}
              onCreateInstance={() => setShowCreateModal(true)}
            />
          )}

          {activeView.type === "instance" && selectedInstance && (
            <InstanceView
              key={selectedInstance.id}
              t={t}
              instance={selectedInstance}
              initialTab={activeView.initialTab}
              status={statuses[selectedInstance.id] ?? "idle"}
              progress={progressMap[selectedInstance.id] ?? null}
              logs={logsMap[selectedInstance.id] ?? []}
              totalRamMb={systemInfo.totalRamMb}
              onLaunch={(world) => handleLaunch(selectedInstance.id, world)}
              onStop={() => api.stopInstance(selectedInstance.id)}
              onClearLogs={() =>
                setLogsMap((prev) => ({ ...prev, [selectedInstance.id]: [] }))
              }
              onInstanceReplaced={(updated) =>
                setInstances((prev) =>
                  prev.map((i) => (i.id === updated.id ? updated : i))
                )
              }
              onUpdateInstance={async (updated) => {
                const saved = await api.updateInstance(updated);
                setInstances((prev) =>
                  prev.map((i) => (i.id === saved.id ? saved : i))
                );
              }}
              onDeleteInstance={async (id) => {
                await api.deleteInstance(id);
                const next = instances.filter((i) => i.id !== id);
                setInstances(next);
                setActiveView({ type: "home" });
              }}
              onCloneInstance={async (id, newName) => {
                const cloned = await api.cloneInstance(id, newName);
                setInstances((prev) => [cloned, ...prev]);
                setActiveView({ type: "instance", instanceId: cloned.id });
              }}
              onOpenModrinthFor={(kind) =>
                setActiveView({
                  type: "modrinth",
                  initialKind: kind,
                  targetInstanceId: selectedInstance.id,
                })
              }
              onExportPack={async () => {
                try {
                  await api.exportMrpackDialog(selectedInstance.id, selectedInstance.name);
                } catch (err) {
                  setBannerError(String(err));
                }
              }}
              pendingRefreshKey={pendingRefreshKey}
              onOpenPending={(items) =>
                setPendingModal({
                  instanceId: selectedInstance.id,
                  instanceName: selectedInstance.name,
                  items,
                })
              }
              onModpackSwitched={(res) => handlePackInstalled(res, true)}
            />
          )}

          {activeView.type === "instance" && !selectedInstance && (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <p className="text-[14px] text-[#85858b]">{t.selectOrCreate}</p>
              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="mono-btn-primary mt-4 h-9 px-4 rounded-[8px] flex items-center gap-2 text-[14px] font-medium"
              >
                <Plus size={15} strokeWidth={1.75} />
                <span>{t.createFirst}</span>
              </button>
            </div>
          )}

          {activeView.type === "modrinth" && (
            <ModrinthView
              t={t}
              instances={instances}
              initialKind={activeView.initialKind}
              initialTargetInstanceId={activeView.targetInstanceId}
              onModpackCreated={(res) => handlePackInstalled(res, false)}
            />
          )}

          {activeView.type === "settings" && (
            <SettingsView
              t={t}
              settings={settings}
              systemInfo={systemInfo}
              onSaveSettings={async (next) => {
                setSettings(next);
                await api.updateSettings(next);
              }}
              onRefreshSystemInfo={refreshSystemInfo}
              onUpdateFound={(info) => setUpdateInfo(info)}
            />
          )}
        </main>
      </div>

      {showCreateModal && (
        <CreateInstanceModal
          t={t}
          showSnapshots={settings.showSnapshots}
          onClose={() => setShowCreateModal(false)}
          onImportMrpack={async () => {
            const ok = await handleImportMrpack();
            if (ok) setShowCreateModal(false);
            return ok;
          }}
          onCreated={(inst) => {
            setInstances((prev) => [inst, ...prev]);
            setShowCreateModal(false);
            setActiveView({ type: "instance", instanceId: inst.id });
          }}
        />
      )}

      {showAccountsModal && (
        <AccountsModal
          t={t}
          store={accounts}
          onClose={() => setShowAccountsModal(false)}
          onUpdated={setAccounts}
        />
      )}

      {pendingModal && pendingModal.items.length > 0 && (
        <PendingDownloadsModal
          t={t}
          instanceId={pendingModal.instanceId}
          instanceName={pendingModal.instanceName}
          items={pendingModal.items}
          onUpdated={(remaining) => {
            setPendingRefreshKey((k) => k + 1);
            setPendingModal((prev) => (prev ? { ...prev, items: remaining } : null));
          }}
          onClose={() => {
            setPendingRefreshKey((k) => k + 1);
            setPendingModal(null);
          }}
        />
      )}

      <PackProgressTray
        t={t}
        tasks={Object.values(packTasks)}
        onDismiss={(taskId) =>
          setPackTasks((prev) => {
            const next = { ...prev };
            delete next[taskId];
            return next;
          })
        }
      />
    </div>
  );
}
