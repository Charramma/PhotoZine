/// <reference types="vite/client" />
import type { PzBridge } from '@shared/ipc/contract'

declare global {
  interface Window {
    pz: PzBridge
  }
}

export {}
