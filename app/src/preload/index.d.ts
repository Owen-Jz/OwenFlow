import type { OwenFlowApi } from '../shared/types'

declare global {
  interface Window {
    owenflow: OwenFlowApi
  }
}

export {}
