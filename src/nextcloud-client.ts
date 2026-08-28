import PasswordsClient, {
  AuthenticationToken,
  PasswordModel,
  PasswordRepository,
  SessionAuthorization
} from "passwords-client"

import { ConnectionSettings, PasswordEntry, PasswordPatch, UnlockRequirement, VaultClient } from "./types.js"
import { normalizeBaseUrl } from "./search.js"

const CACHE_TTL_MS = 30_000

export class NextcloudVaultClient implements VaultClient {
  private authorization: SessionAuthorization | null = null
  private cache: PasswordEntry[] | null = null
  private cacheTime = 0
  private client: PasswordsClient | null = null
  private repository: PasswordRepository | null = null

  async connect(settings: ConnectionSettings): Promise<UnlockRequirement | null> {
    this.disconnect()
    this.client = new PasswordsClient(
      {
        baseUrl: normalizeBaseUrl(settings.baseUrl),
        user: settings.username.trim(),
        token: settings.appPassword.trim()
      },
      {
        defaultEncryption: "auto",
        userAgent: "Wox Nextcloud Passwords/0.3.0"
      }
    )
    this.repository = this.client.getPasswordRepository()
    this.authorization = this.client.getSessionAuthorization()
    await this.authorization.load()

    const requirement = this.getUnlockRequirement()
    if (requirement === null) {
      await this.authorization.authorize()
    }
    return requirement
  }

  disconnect(): void {
    // Passwords API sessions are short-lived. Dropping local state avoids the
    // upstream client's fire-and-forget close request producing unhandled errors offline.
    this.authorization = null
    this.cache = null
    this.cacheTime = 0
    this.client = null
    this.repository = null
  }

  async unlock(masterPassword: string, tokenMethodId?: string, tokenValue?: string): Promise<void> {
    if (this.authorization === null) throw new Error("The vault is not connected")

    let selectedToken: AuthenticationToken | undefined
    if (this.authorization.requiresToken()) {
      selectedToken = this.authorization.getTokens().find((token) => token.getId() === tokenMethodId)
      if (selectedToken === undefined) throw new Error("Select a two-factor authentication method")

      if (selectedToken.getType() === "user-token") {
        if (!tokenValue?.trim() || selectedToken.setToken === undefined) {
          throw new Error("Enter the two-factor authentication code")
        }
        selectedToken.setToken(tokenValue.trim())
      } else {
        throw new Error("Request-based two-factor authentication is not supported by this client")
      }
    }

    await this.authorization.authorize(masterPassword || undefined, selectedToken)
    this.cache = null
  }

  async listPasswords(forceRefresh = false): Promise<PasswordEntry[]> {
    const repository = this.requireRepository()
    if (!forceRefresh && this.cache !== null && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return this.cache
    }

    const collection = await repository.findAll("model")
    this.cache = Array.from(collection, toPasswordEntry)
    this.cacheTime = Date.now()
    return this.cache
  }

  async updatePassword(id: string, patch: PasswordPatch): Promise<PasswordEntry> {
    const repository = this.requireRepository()
    const model = await repository.findById(id, "model")
    if (!model.getEditable()) throw new Error("This password is read-only")

    model.setLabel(patch.label.trim())
    model.setUserName(patch.username.trim())
    model.setUrl(patch.url.trim())
    model.setNotes(patch.notes)
    if (patch.newPassword) {
      model.setPassword(patch.newPassword)
      model.setEdited(new Date())
    }

    const updated = await repository.update(model)
    this.cache = null
    return toPasswordEntry(updated)
  }

  private getUnlockRequirement(): UnlockRequirement | null {
    if (this.authorization === null) return null
    const masterPassword = this.authorization.requiresChallenge()
    const tokenMethods = this.authorization.getTokens().map((token) => ({
      description: token.getDescription(),
      id: token.getId(),
      label: token.getLabel(),
      type: token.getType()
    }))
    if (!masterPassword && tokenMethods.length === 0) return null
    return { masterPassword, tokenMethods }
  }

  private requireRepository(): PasswordRepository {
    if (this.repository === null) throw new Error("The vault is not connected")
    return this.repository
  }
}

function toPasswordEntry(model: PasswordModel): PasswordEntry {
  return {
    editable: model.getEditable(),
    favorite: model.getFavorite(),
    id: model.getId(),
    label: model.getLabel() || "Untitled",
    notes: model.getNotes() || "",
    password: model.getPassword() || "",
    status: model.getStatus() || 0,
    statusCode: model.getStatusCode() || "",
    updated: model.getUpdated(),
    url: model.getUrl() || "",
    username: model.getUserName() || ""
  }
}
