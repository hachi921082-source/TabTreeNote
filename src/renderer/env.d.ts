/// <reference types="vite/client" />
import type { PreloadApi } from '@shared/ipc-contract';

declare global {
  interface Window {
    api: PreloadApi;
  }
}

export {};
