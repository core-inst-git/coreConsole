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
      listSerialPorts?: () => Promise<{ ports?: string[]; debug?: string[] }>;
    };
    gpib?: {
      health?: () => Promise<{
        enabled?: boolean;
        visaLoaded?: boolean;
        resourceManager?: boolean;
        gpibDetected?: boolean;
        resourcesSample?: string[];
        checkedPaths?: string[];
        loadedPath?: string;
        reason?: string;
      }>;
      listResources?: () => Promise<string[]>;
      open?: (resource: string, timeoutMs?: number) => Promise<{ sessionId: string }>;
      write?: (sessionId: string, command: string) => Promise<{ ok: boolean; bytesWritten: number }>;
      read?: (sessionId: string, maxBytes?: number) => Promise<{ data: string }>;
      query?: (sessionId: string, command: string, maxBytes?: number) => Promise<{ data: string }>;
      queryResource?: (
        resource: string,
        command: string,
        timeoutMs?: number,
        maxBytes?: number,
      ) => Promise<{ data: string }>;
      probeIdn?: (
        resource: string,
        timeoutMs?: number,
        maxBytes?: number,
      ) => Promise<{
        ok: boolean;
        data?: string;
        error?: { code?: string; status?: number; message?: string };
      }>;
      setTimeout?: (sessionId: string, ms: number) => Promise<{ ok: boolean }>;
      close?: (sessionId: string) => Promise<{ ok: boolean }>;
      restartService?: () => Promise<{ ok: boolean }>;
    };
  }
}
