export {};

declare global {
  interface CoreDAQWindowState {
    maximized: boolean;
    fullscreen: boolean;
  }

  interface CoreDAQSaveDialogResult {
    canceled: boolean;
    filePath: string | null;
  }

  interface Window {
    coredaq?: {
      getStatus?: () => Promise<{ connected: boolean; source: string }>;
      onOpenPreferences?: (cb: () => void) => void;
      onWindowState?: (cb: (state: CoreDAQWindowState) => void) => () => void;
      goBack?: () => Promise<{ ok: boolean }>;
      windowMinimize?: () => Promise<{ ok: boolean }>;
      windowToggleMaximize?: () => Promise<{ ok: boolean }>;
      windowClose?: () => Promise<{ ok: boolean }>;
      windowIsMaximized?: () => Promise<CoreDAQWindowState>;
      pickSavePath?: (defaultName?: string) => Promise<CoreDAQSaveDialogResult>;
    };
  }
}
