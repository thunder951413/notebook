export type AutomationRequestOperation =
  | 'guide'
  | 'openapi'
  | 'list-pages'
  | 'get-page'
  | 'create-proposal'
  | 'list-proposals'
  | 'get-proposal'

export interface AutomationBridgeRequest {
  id: string
  operation: AutomationRequestOperation
  payload: unknown
}

export interface AutomationBridgeResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export interface AutomationApiState {
  enabled: boolean
  port: number
  baseUrl: string
  token?: string
  rendererReady: boolean
}
