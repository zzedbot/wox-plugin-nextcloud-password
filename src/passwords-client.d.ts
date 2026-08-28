declare module "passwords-client" {
  export default class PasswordsClient {
    constructor(server: { baseUrl: string; user: string; token: string }, config?: Record<string, unknown>)
    closeSession(): void
    getPasswordRepository(): PasswordRepository
    getSessionAuthorization(): SessionAuthorization
  }

  export interface SessionAuthorization {
    authorize(password?: string, token?: AuthenticationToken): Promise<void>
    getTokens(): AuthenticationToken[]
    isLoaded(): boolean
    load(): Promise<void>
    requiresChallenge(): boolean
    requiresToken(): boolean
  }

  export interface AuthenticationToken {
    getDescription(): string
    getId(): string
    getLabel(): string
    getType(): "request-token" | "user-token" | string
    sendRequest(): Promise<boolean>
    setToken?(value: string): AuthenticationToken
  }

  export interface PasswordRepository {
    findAll(detailLevel?: string | string[]): Promise<PasswordCollection>
    findById(id: string, detailLevel?: string | string[]): Promise<PasswordModel>
    update(model: PasswordModel): Promise<PasswordModel>
  }

  export interface PasswordCollection extends Iterable<PasswordModel> {}

  export interface PasswordModel {
    getEditable(): boolean
    getFavorite(): boolean
    getId(): string
    getLabel(): string
    getNotes(): string
    getPassword(): string
    getStatus(): number
    getStatusCode(): string
    getUpdated(): Date
    getUrl(): string
    getUserName(): string
    setEdited(value: Date): PasswordModel
    setLabel(value: string): PasswordModel
    setNotes(value: string): PasswordModel
    setPassword(value: string): PasswordModel
    setUrl(value: string): PasswordModel
    setUserName(value: string): PasswordModel
  }
}
