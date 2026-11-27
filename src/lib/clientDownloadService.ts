import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DownloadProgressPayload } from "../types";
import { isTauri } from "./api";

export interface ClientDownloadCallbacks {
  /** Обновление прогресса в UI (целое число 0–100) */
  onProgress: (percent: number) => void;
  /** Показ уведомления об ошибке в UI */
  onNotifyError: (message: string) => void;
  /** Функция запуска скачанного клиента */
  launchClient: () => Promise<void> | void;
}

export class ClientDownloadService {
  private unlisten: UnlistenFn | null = null;
  private isDownloading = false;
  private isDisposed = false;
  private lastReportedPercent = -1;

  constructor(private readonly callbacks: ClientDownloadCallbacks) {}

  /**
   * Скачивает бинарник клиента через Rust-команду `download_client`
   * и запускает его после успешной загрузки.
   */
  public async downloadAndLaunch(url: string, destPath: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error("ClientDownloadService уже уничтожен (disposed).");
    }

    if (this.isDownloading) {
      console.warn(
        "[mono-launcher] Скачивание уже запущено, повторный вызов проигнорирован."
      );
      return;
    }

    this.isDownloading = true;
    this.lastReportedPercent = 0;
    this.callbacks.onProgress(0);

    try {
      if (isTauri()) {
        // 1. Подписываемся на прогресс до старта команды, чтобы не потерять первые чанки
        const unlistenFn = await listen<DownloadProgressPayload>(
          "download-progress",
          (event) => {
            if (this.isDisposed) return;

            const { downloaded, total } = event.payload;
            const percent = this.calculatePercent(downloaded, total);
            if (percent !== this.lastReportedPercent) {
              this.lastReportedPercent = percent;
              this.callbacks.onProgress(percent);
            }
          }
        );

        // Если компонент размонтировался, пока мы ждали промис listen()
        if (this.isDisposed) {
          unlistenFn();
          return;
        }

        this.unlisten = unlistenFn;

        // 2. Вызываем Rust-команду download_client
        await invoke<void>("download_client", { url, destPath });

        // Отписываемся сразу после завершения скачивания (до запуска клиента)
        this.cleanupListener();
      }

      if (this.isDisposed) return;

      if (this.lastReportedPercent !== 100) {
        this.lastReportedPercent = 100;
        this.callbacks.onProgress(100);
      }

      // 3. Запускаем клиент
      await this.callbacks.launchClient();
    } catch (error) {
      console.error(
        "[mono-launcher] Ошибка при скачивании или запуске клиента:",
        error
      );

      if (!this.isDisposed) {
        const message = this.formatError(error);
        this.callbacks.onNotifyError(`Не удалось загрузить клиент: ${message}`);
      }
    } finally {
      // Гарантированная отписка при любом исходе (успех, ошибка, ранний return)
      this.cleanupListener();
      this.isDownloading = false;
    }
  }

  /**
   * Вызывать при размонтировании UI-компонента.
   * Снимает подписку на события Tauri и блокирует дальнейшие вызовы UI-коллбэков.
   */
  public dispose(): void {
    this.isDisposed = true;
    this.cleanupListener();
  }

  private cleanupListener(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }

  private calculatePercent(downloaded: number, total: number): number {
    if (!Number.isFinite(total) || total <= 0) {
      return 0;
    }
    const raw = (downloaded / total) * 100;
    return Math.min(100, Math.max(0, Math.round(raw)));
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "Неизвестная ошибка";
  }
}
