export interface ConnectionSettings {
  appPassword: string
  baseUrl: string
  username: string
}

export interface LoginFlowCredentials {
  appPassword: string
  loginName: string
  server: string
}

export interface LoginFlowSession {
  loginUrl: string
  poll(signal?: AbortSignal): Promise<LoginFlowCredentials>
}

export interface LoginFlowClient {
  revoke(credentials: LoginFlowCredentials, signal?: AbortSignal): Promise<void>
  start(baseUrl: string, signal?: AbortSignal): Promise<LoginFlowSession>
}

export interface BrowserLauncher {
  open(url: string): Promise<void>
}

export interface PasswordEntry {
  editable: boolean
  favorite: boolean
  id: string
  label: string
  notes: string
  password: string
  status: number
  statusCode: string
  updated?: Date
  url: string
  username: string
}

export interface PasswordPatch {
  label: string
  newPassword?: string
  notes: string
  url: string
  username: string
}

export interface TokenMethod {
  description: string
  id: string
  label: string
  type: string
}

export interface UnlockRequirement {
  masterPassword: boolean
  tokenMethods: TokenMethod[]
}

export interface VaultClient {
  connect(settings: ConnectionSettings): Promise<UnlockRequirement | null>
  disconnect(): void
  listPasswords(forceRefresh?: boolean): Promise<PasswordEntry[]>
  unlock(masterPassword: string, tokenMethodId?: string, tokenValue?: string): Promise<void>
  updatePassword(id: string, patch: PasswordPatch): Promise<PasswordEntry>
}
