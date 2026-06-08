/// <reference types="vite/client" />

import type { WorkerDeskApi } from './types/workerDesk'

declare global {
  interface Window {
    workerDesk: WorkerDeskApi
  }
}