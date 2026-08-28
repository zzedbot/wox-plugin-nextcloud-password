import {
  Context,
  FormActionContext,
  Plugin,
  PluginInitParams,
  PluginSettingDefinitionItem,
  PublicAPI,
  Query,
  QueryResponse,
  Result,
  WoxPreviewListData
} from "@wox-launcher/wox-plugin"

import {
  CONNECT_ICON,
  COPY_ICON,
  DETAIL_ICON,
  DISCONNECT_ICON,
  EDIT_ICON,
  HIDE_ICON,
  PASSWORD_ICON,
  PIN_ICON,
  UNLOCK_ICON,
  USER_ICON
} from "./icons.js"
import { NextcloudLoginFlowClient, systemBrowserLauncher } from "./login-flow.js"
import { NextcloudVaultClient } from "./nextcloud-client.js"
import { filterPasswords, normalizeBaseUrl } from "./search.js"
import {
  BrowserLauncher,
  ConnectionSettings,
  LoginFlowClient,
  LoginFlowCredentials,
  PasswordEntry,
  PasswordPatch,
  PasswordUsageStats,
  TokenMethod,
  UnlockRequirement,
  VaultClient
} from "./types.js"

const AUTHORIZED_SERVER_KEY = "authorizedServer"
const AUTHORIZED_USERNAME_KEY = "authorizedUsername"
const AUTHORIZED_APP_PASSWORD_KEY = "authorizedAppPassword"
const AUTHORIZED_SETTING_KEYS = [AUTHORIZED_SERVER_KEY, AUTHORIZED_USERNAME_KEY, AUTHORIZED_APP_PASSWORD_KEY] as const
const LEGACY_SETTING_KEYS = ["username", "appPassword"] as const
const USAGE_STATS_KEY = "usageStats"
const MAX_USAGE_ENTRIES = 500

export class NextcloudPasswordsPlugin implements Plugin {
  private api!: PublicAPI
  private authorizationAbort: AbortController | null = null
  private authorizationLoginUrl = ""
  private authorizationRunning = false
  private browser: BrowserLauncher
  private client: VaultClient
  private connectionKey = ""
  private loginFlow: LoginFlowClient
  private unlockRequirement: UnlockRequirement | null = null

  constructor(
    client: VaultClient = new NextcloudVaultClient(),
    loginFlow: LoginFlowClient = new NextcloudLoginFlowClient(),
    browser: BrowserLauncher = systemBrowserLauncher
  ) {
    this.client = client
    this.loginFlow = loginFlow
    this.browser = browser
    // The Node.js host invokes exported lifecycle functions without preserving the class receiver.
    this.init = this.init.bind(this)
    this.query = this.query.bind(this)
  }

  async init(ctx: Context, params: PluginInitParams): Promise<void> {
    this.api = params.API
    await this.api.OnSettingChanged(ctx, (_changeCtx, key) => {
      if (key === "baseUrl" || AUTHORIZED_SETTING_KEYS.includes(key as (typeof AUTHORIZED_SETTING_KEYS)[number])) {
        this.resetConnection()
      }
    })
    await this.api.OnUnload(ctx, async () => {
      this.cancelAuthorization()
      this.resetConnection()
    })
    await this.api.Log(ctx, "Info", "Nextcloud Passwords initialized")
  }

  async query(ctx: Context, query: Query): Promise<QueryResponse> {
    try {
      if (query.Command === "connect") return { Results: [await this.buildConnectResult(ctx)] }
      if (query.Command === "disconnect") return { Results: [await this.buildDisconnectResult(ctx)] }
      if (this.authorizationRunning) return { Results: [await this.buildAuthorizationWaitingResult(ctx)] }

      const credentials = await this.getAuthorizedCredentials(ctx)
      if (credentials === null) return { Results: [await this.buildConnectResult(ctx)] }

      await this.ensureConnected({
        appPassword: credentials.appPassword,
        baseUrl: credentials.server,
        username: credentials.loginName
      })
      if (this.unlockRequirement !== null) {
        return { Results: [await this.buildUnlockResult(ctx, this.unlockRequirement)] }
      }

      const usageStats = await this.loadUsageStats(ctx)
      const passwords = filterPasswords(await this.client.listPasswords(), query.Search, 50, usageStats)
      const results = await Promise.all(passwords.map((entry) => this.buildPasswordResult(ctx, entry)))
      if (results.length === 0) {
        results.push({
          Title: await this.t(ctx, "no_results"),
          SubTitle: await this.t(ctx, "no_results_subtitle"),
          Icon: PASSWORD_ICON,
          Actions: []
        })
      }
      return { Results: results, Layout: { ResultPreviewWidthRatio: 0.48 } }
    } catch (error) {
      await this.logError(ctx, "Query failed", error)
      return { Results: [await this.buildErrorResult(ctx, error)] }
    }
  }

  private async ensureConnected(settings: ConnectionSettings): Promise<void> {
    const key = JSON.stringify(settings)
    if (key === this.connectionKey) return

    this.resetConnection()
    this.unlockRequirement = await this.client.connect(settings)
    this.connectionKey = key
  }

  private async getAuthorizedCredentials(ctx: Context): Promise<LoginFlowCredentials | null> {
    const [configuredBaseUrl, server, loginName, appPassword] = await Promise.all([
      this.api.GetSetting(ctx, "baseUrl"),
      this.api.GetSetting(ctx, AUTHORIZED_SERVER_KEY),
      this.api.GetSetting(ctx, AUTHORIZED_USERNAME_KEY),
      this.api.GetSetting(ctx, AUTHORIZED_APP_PASSWORD_KEY)
    ])
    if (!configuredBaseUrl || !server || !loginName || !appPassword) return null

    try {
      if (normalizeBaseUrl(configuredBaseUrl) !== normalizeBaseUrl(server)) return null
    } catch {
      return null
    }
    return { appPassword, loginName, server }
  }

  private async buildConnectResult(ctx: Context): Promise<Result> {
    if (this.authorizationRunning) return this.buildAuthorizationWaitingResult(ctx)
    return {
      Id: "nextcloud-passwords-connect",
      Title: await this.t(ctx, "connect_title"),
      SubTitle: await this.t(ctx, "connect_subtitle"),
      Icon: CONNECT_ICON,
      Preview: {
        PreviewType: "markdown",
        PreviewData: await this.t(ctx, "connect_preview"),
        PreviewProperties: {}
      },
      Actions: [
        {
          Id: "authorize-nextcloud",
          Name: "i18n:connect_action",
          Icon: CONNECT_ICON,
          IsDefault: true,
          PreventHideAfterAction: true,
          Action: async (actionCtx) => this.startAuthorization(actionCtx)
        }
      ]
    }
  }

  private async buildAuthorizationWaitingResult(ctx: Context): Promise<Result & { Id: string }> {
    const actions: Result["Actions"] = []
    if (this.authorizationLoginUrl) {
      actions.push({
        Id: "reopen-nextcloud-authorization",
        Name: "i18n:reopen_authorization",
        Icon: CONNECT_ICON,
        IsDefault: true,
        PreventHideAfterAction: true,
        Action: async () => this.browser.open(this.authorizationLoginUrl)
      })
    }
    actions.push({
      Id: "cancel-nextcloud-authorization",
      Name: "i18n:cancel_authorization",
      Icon: DISCONNECT_ICON,
      IsDefault: actions.length === 0,
      PreventHideAfterAction: true,
      Action: async (actionCtx) => this.cancelAuthorizationFromAction(actionCtx)
    })

    return {
      Id: "nextcloud-passwords-connect",
      Title: await this.t(ctx, "authorization_waiting_title"),
      SubTitle: await this.t(ctx, "authorization_waiting_subtitle"),
      Icon: CONNECT_ICON,
      Preview: {
        PreviewType: "markdown",
        PreviewData: await this.t(ctx, "authorization_waiting_preview"),
        PreviewProperties: {}
      },
      Actions: actions
    }
  }

  private async startAuthorization(ctx: Context): Promise<void> {
    if (this.authorizationRunning) {
      if (this.authorizationLoginUrl) await this.browser.open(this.authorizationLoginUrl)
      return
    }

    const controller = new AbortController()
    this.authorizationAbort = controller
    this.authorizationLoginUrl = ""
    this.authorizationRunning = true
    await this.api.UpdateResult(ctx, await this.buildAuthorizationWaitingResult(ctx))
    void this.runAuthorization(ctx, controller)
  }

  private async runAuthorization(ctx: Context, controller: AbortController): Promise<void> {
    try {
      const baseUrl = await this.api.GetSetting(ctx, "baseUrl")
      const session = await this.loginFlow.start(baseUrl, controller.signal)
      this.authorizationLoginUrl = session.loginUrl
      await this.api.UpdateResult(ctx, await this.buildAuthorizationWaitingResult(ctx))
      await this.browser.open(session.loginUrl)

      const credentials = await session.poll(controller.signal)
      await this.saveAuthorizedCredentials(ctx, credentials)
      this.resetConnection()
      this.clearAuthorizationState(controller)
      await this.api.Notify(ctx, await this.t(ctx, "authorization_success"))
      await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
    } catch (error) {
      if (!isAbortError(error)) {
        this.clearAuthorizationState(controller)
        await this.logError(ctx, "Login Flow authorization failed", error)
        await this.api.Notify(ctx, await this.t(ctx, "authorization_failed"))
        await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
      }
    } finally {
      this.clearAuthorizationState(controller)
    }
  }

  private async saveAuthorizedCredentials(ctx: Context, credentials: LoginFlowCredentials): Promise<void> {
    await this.api.SaveSetting(ctx, "baseUrl", normalizeBaseUrl(credentials.server), false)
    await this.api.SaveSetting(ctx, AUTHORIZED_SERVER_KEY, normalizeBaseUrl(credentials.server), true)
    await this.api.SaveSetting(ctx, AUTHORIZED_USERNAME_KEY, credentials.loginName, true)
    await this.api.SaveSetting(ctx, AUTHORIZED_APP_PASSWORD_KEY, credentials.appPassword, true)
    for (const key of LEGACY_SETTING_KEYS) await this.api.SaveSetting(ctx, key, "", false)
  }

  private async buildDisconnectResult(ctx: Context): Promise<Result> {
    const credentials = await this.getAuthorizedCredentials(ctx)
    if (credentials === null) {
      return {
        Id: "nextcloud-passwords-disconnected",
        Title: await this.t(ctx, "not_connected_title"),
        SubTitle: await this.t(ctx, "not_connected_subtitle"),
        Icon: DISCONNECT_ICON,
        Actions: []
      }
    }

    return {
      Id: "nextcloud-passwords-disconnect",
      Title: await this.t(ctx, "disconnect_title"),
      SubTitle: await this.t(ctx, "disconnect_subtitle"),
      Icon: DISCONNECT_ICON,
      Preview: {
        PreviewType: "markdown",
        PreviewData: await this.t(ctx, "disconnect_preview"),
        PreviewProperties: {}
      },
      Actions: [
        {
          Id: "disconnect-nextcloud",
          Name: "i18n:disconnect_action",
          Icon: DISCONNECT_ICON,
          IsDefault: true,
          PreventHideAfterAction: true,
          Action: async (actionCtx) => this.disconnectAccount(actionCtx, credentials)
        }
      ]
    }
  }

  private async disconnectAccount(ctx: Context, credentials: LoginFlowCredentials): Promise<void> {
    let revoked = true
    try {
      await this.loginFlow.revoke(credentials)
    } catch (error) {
      revoked = false
      await this.logError(ctx, "App-password revocation failed", error)
    }

    this.cancelAuthorization()
    this.resetConnection()
    await this.clearAuthorizedCredentials(ctx)
    await this.api.Notify(ctx, await this.t(ctx, revoked ? "disconnect_success" : "disconnect_local_only"))
    await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
  }

  private async clearAuthorizedCredentials(ctx: Context): Promise<void> {
    for (const key of AUTHORIZED_SETTING_KEYS) await this.api.SaveSetting(ctx, key, "", true)
    for (const key of LEGACY_SETTING_KEYS) await this.api.SaveSetting(ctx, key, "", false)
  }

  private async cancelAuthorizationFromAction(ctx: Context): Promise<void> {
    this.cancelAuthorization()
    await this.api.Notify(ctx, await this.t(ctx, "authorization_cancelled"))
    await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
  }

  private cancelAuthorization(): void {
    this.authorizationAbort?.abort()
    this.authorizationAbort = null
    this.authorizationLoginUrl = ""
    this.authorizationRunning = false
  }

  private clearAuthorizationState(controller: AbortController): void {
    if (this.authorizationAbort !== controller) return
    this.authorizationAbort = null
    this.authorizationLoginUrl = ""
    this.authorizationRunning = false
  }

  private resetConnection(): void {
    this.client.disconnect()
    this.connectionKey = ""
    this.unlockRequirement = null
  }

  private async buildUnlockResult(ctx: Context, requirement: UnlockRequirement): Promise<Result> {
    const form = await this.buildUnlockForm(ctx, requirement)
    return {
      Id: "nextcloud-passwords-unlock",
      Title: await this.t(ctx, "unlock_title"),
      SubTitle: await this.t(ctx, "unlock_subtitle"),
      Icon: UNLOCK_ICON,
      Preview: {
        PreviewType: "markdown",
        PreviewData: await this.t(ctx, "unlock_preview"),
        PreviewProperties: {}
      },
      Actions: [
        {
          Id: "unlock",
          Type: "form",
          Name: "i18n:unlock_action",
          Icon: UNLOCK_ICON,
          IsDefault: true,
          PreventHideAfterAction: true,
          Form: form,
          OnSubmit: async (actionCtx, formCtx) => this.unlock(actionCtx, formCtx)
        }
      ]
    }
  }

  private async buildUnlockForm(ctx: Context, requirement: UnlockRequirement): Promise<PluginSettingDefinitionItem[]> {
    const form: PluginSettingDefinitionItem[] = []
    if (requirement.masterPassword) {
      form.push(this.textbox("masterPassword", await this.t(ctx, "master_password"), "", true))
    }
    if (requirement.tokenMethods.length > 0) {
      form.push(this.tokenSelect(requirement.tokenMethods, await this.t(ctx, "two_factor_method")))
      if (requirement.tokenMethods.some((token) => token.type === "user-token")) {
        form.push(this.textbox("tokenValue", await this.t(ctx, "two_factor_code"), "", false))
      }
    }
    return form
  }

  private async unlock(ctx: Context, formCtx: FormActionContext): Promise<void> {
    try {
      await this.client.unlock(
        formCtx.Values.masterPassword || "",
        formCtx.Values.tokenMethod || undefined,
        formCtx.Values.tokenValue || undefined
      )
      this.unlockRequirement = null
      await this.api.Notify(ctx, await this.t(ctx, "unlock_success"))
      await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
    } catch (error) {
      await this.logError(ctx, "Unlock failed", error)
      await this.api.Notify(ctx, await this.errorMessage(ctx, error))
    }
  }

  private async buildPasswordResult(ctx: Context, entry: PasswordEntry): Promise<Result> {
    const resultId = `nextcloud-password-${entry.id}`
    return {
      Id: resultId,
      Title: entry.label,
      SubTitle: [entry.username, entry.url].filter(Boolean).join(" · ") || (await this.t(ctx, "no_username_or_url")),
      Icon: PASSWORD_ICON,
      Preview: await this.buildPreview(ctx, entry, false),
      Tails: this.buildTails(entry),
      Actions: await this.buildPasswordActions(ctx, entry, false)
    }
  }

  // Rebuild visibility-dependent actions together with the preview toggle state.
  private async buildPasswordActions(
    ctx: Context,
    entry: PasswordEntry,
    revealed: boolean
  ): Promise<Result["Actions"]> {
    const resultId = `nextcloud-password-${entry.id}`
    const actions: Result["Actions"] = [
      {
        Id: `copy-password-${entry.id}`,
        Name: "i18n:copy_password",
        Icon: COPY_ICON,
        IsDefault: true,
        Action: async (actionCtx) => this.copyPassword(actionCtx, entry)
      },
      {
        Id: `copy-username-${entry.id}`,
        Name: "i18n:copy_username",
        Icon: USER_ICON,
        Action: async (actionCtx) => this.copy(actionCtx, entry.username, "username_copied")
      },
      {
        Id: `toggle-password-visibility-${entry.id}`,
        Name: revealed ? "i18n:hide_password" : "i18n:show_password",
        Icon: revealed ? HIDE_ICON : DETAIL_ICON,
        PreventHideAfterAction: true,
        Action: async (actionCtx) => {
          const nextRevealed = !revealed
          await this.api.UpdateResult(actionCtx, {
            Id: resultId,
            Preview: await this.buildPreview(actionCtx, entry, nextRevealed),
            Actions: await this.buildPasswordActions(actionCtx, entry, nextRevealed)
          })
        }
      }
    ]
    if (entry.editable) {
      actions.push({
        Id: `toggle-pin-${entry.id}`,
        Name: entry.favorite ? "i18n:unpin_password" : "i18n:pin_password",
        Icon: PIN_ICON,
        PreventHideAfterAction: true,
        Action: async (actionCtx) => this.toggleFavorite(actionCtx, entry)
      })
      actions.push({
        Id: `edit-password-${entry.id}`,
        Type: "form",
        Name: "i18n:edit_password",
        Icon: EDIT_ICON,
        PreventHideAfterAction: true,
        Form: await this.buildEditForm(ctx, entry),
        OnSubmit: async (actionCtx, formCtx) => this.updatePassword(actionCtx, entry, formCtx)
      })
    }
    return actions
  }

  private async buildPreview(ctx: Context, entry: PasswordEntry, reveal: boolean) {
    const hiddenPassword = "•".repeat(Math.min(Math.max(entry.password.length, 8), 24))
    const data: WoxPreviewListData = {
      items: [
        { title: await this.t(ctx, "username"), subtitle: entry.username || "—" },
        { title: await this.t(ctx, "password"), subtitle: reveal ? entry.password : hiddenPassword },
        { title: "URL", subtitle: entry.url || "—" },
        { title: await this.t(ctx, "notes"), subtitle: entry.notes || "—" },
        { title: await this.t(ctx, "security_status"), subtitle: entry.statusCode || this.statusText(entry.status) }
      ]
    }
    return {
      PreviewType: "list" as const,
      PreviewData: JSON.stringify(data),
      PreviewTags: [
        { Label: entry.editable ? await this.t(ctx, "editable") : await this.t(ctx, "read_only") },
        { Label: reveal ? await this.t(ctx, "password_visible") : await this.t(ctx, "password_hidden") }
      ],
      PreviewProperties: {}
    }
  }

  private buildTails(entry: PasswordEntry) {
    const tails = []
    if (entry.favorite) tails.push({ Type: "text" as const, Text: "★", TextCategory: "warning" as const })
    if (entry.status >= 2) tails.push({ Type: "text" as const, Text: "!", TextCategory: "danger" as const })
    if (!entry.editable) tails.push({ Type: "text" as const, Text: "🔒" })
    return tails
  }

  private async buildEditForm(ctx: Context, entry: PasswordEntry): Promise<PluginSettingDefinitionItem[]> {
    return [
      this.textbox("label", await this.t(ctx, "label"), entry.label, true),
      this.textbox("username", await this.t(ctx, "username"), entry.username, false),
      this.textbox("newPassword", await this.t(ctx, "new_password"), "", false, await this.t(ctx, "new_password_hint")),
      this.textbox("url", "URL", entry.url, false),
      this.textbox("notes", await this.t(ctx, "notes"), entry.notes, false, "", 6)
    ]
  }

  private async updatePassword(ctx: Context, entry: PasswordEntry, formCtx: FormActionContext): Promise<void> {
    const patch: PasswordPatch = {
      label: formCtx.Values.label,
      username: formCtx.Values.username || "",
      newPassword: formCtx.Values.newPassword || undefined,
      url: formCtx.Values.url || "",
      notes: formCtx.Values.notes || ""
    }
    try {
      const updated = await this.client.updatePassword(entry.id, patch)
      await this.api.Notify(ctx, await this.t(ctx, "update_success"))
      await this.api.UpdateResult(ctx, {
        Id: `nextcloud-password-${entry.id}`,
        Title: updated.label,
        SubTitle: [updated.username, updated.url].filter(Boolean).join(" · "),
        Preview: await this.buildPreview(ctx, updated, false),
        Tails: this.buildTails(updated)
      })
      await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
    } catch (error) {
      await this.logError(ctx, "Password update failed", error)
      await this.api.Notify(ctx, await this.errorMessage(ctx, error))
    }
  }

  // Sync an explicit pin to Nextcloud and refresh the result order.
  private async toggleFavorite(ctx: Context, entry: PasswordEntry): Promise<void> {
    try {
      await this.client.setFavorite(entry.id, !entry.favorite)
      await this.api.Notify(ctx, await this.t(ctx, entry.favorite ? "unpin_success" : "pin_success"))
      await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
    } catch (error) {
      await this.logError(ctx, "Favorite update failed", error)
      await this.api.Notify(ctx, await this.errorMessage(ctx, error))
    }
  }

  // Count successful password copies as usage without exposing the password in settings.
  private async copyPassword(ctx: Context, entry: PasswordEntry): Promise<void> {
    if (!entry.password) {
      await this.api.Notify(ctx, await this.t(ctx, "nothing_to_copy"))
      return
    }
    await this.api.Copy(ctx, { type: "text", text: entry.password })
    await this.recordUsage(ctx, entry.id)
    await this.api.Notify(ctx, await this.t(ctx, "password_copied"))
  }

  // Treat malformed or older local usage data as empty instead of failing password search.
  private async loadUsageStats(ctx: Context): Promise<PasswordUsageStats> {
    const raw = await this.api.GetSetting(ctx, USAGE_STATS_KEY)
    if (!raw) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

      const stats: PasswordUsageStats = {}
      for (const [id, value] of Object.entries(parsed)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue
        const count = (value as { count?: unknown }).count
        const lastUsed = (value as { lastUsed?: unknown }).lastUsed
        if (typeof count !== "number" || !Number.isFinite(count) || count < 0) continue
        if (typeof lastUsed !== "number" || !Number.isFinite(lastUsed) || lastUsed < 0) continue
        stats[id] = { count: Math.floor(count), lastUsed }
      }
      return stats
    } catch {
      return {}
    }
  }

  // Bound device-local history so stale vault entries cannot grow settings indefinitely.
  private async recordUsage(ctx: Context, id: string): Promise<void> {
    const stats = await this.loadUsageStats(ctx)
    const current = stats[id] || { count: 0, lastUsed: 0 }
    stats[id] = { count: current.count + 1, lastUsed: Date.now() }
    const trimmed = Object.fromEntries(
      Object.entries(stats)
        .sort((left, right) => right[1].lastUsed - left[1].lastUsed)
        .slice(0, MAX_USAGE_ENTRIES)
    )
    await this.api.SaveSetting(ctx, USAGE_STATS_KEY, JSON.stringify(trimmed), true)
  }

  private async copy(ctx: Context, value: string, translationKey: string): Promise<void> {
    if (!value) {
      await this.api.Notify(ctx, await this.t(ctx, "nothing_to_copy"))
      return
    }
    await this.api.Copy(ctx, { type: "text", text: value })
    await this.api.Notify(ctx, await this.t(ctx, translationKey))
  }

  private textbox(
    key: string,
    label: string,
    defaultValue: string,
    required: boolean,
    tooltip = "",
    maxLines = 1
  ): PluginSettingDefinitionItem {
    return {
      Type: "textbox",
      Value: {
        Key: key,
        Label: label,
        Suffix: "",
        DefaultValue: defaultValue,
        Tooltip: tooltip,
        MaxLines: maxLines,
        Validators: required ? [{ Type: "not_empty", Value: {} }] : []
      },
      DisabledInPlatforms: [],
      IsPlatformSpecific: false
    }
  }

  private tokenSelect(methods: TokenMethod[], label: string): PluginSettingDefinitionItem {
    return {
      Type: "select",
      Value: {
        Key: "tokenMethod",
        Label: label,
        Suffix: "",
        DefaultValue: methods[0]?.id || "",
        Tooltip: "",
        IsMulti: false,
        Options: methods.map((method) => ({ Label: method.label, Value: method.id })),
        Validators: [{ Type: "not_empty", Value: {} }]
      },
      DisabledInPlatforms: [],
      IsPlatformSpecific: false
    }
  }

  private async buildErrorResult(ctx: Context, error: unknown): Promise<Result> {
    return {
      Title: await this.t(ctx, "connection_error"),
      SubTitle: await this.errorMessage(ctx, error),
      Icon: UNLOCK_ICON,
      Actions: []
    }
  }

  private async errorMessage(ctx: Context, error: unknown): Promise<string> {
    const message = error instanceof Error ? error.message : ""
    if (/https/i.test(message)) return this.t(ctx, "https_required")
    if (/401|unauthor/i.test(message)) return this.t(ctx, "authentication_failed")
    if (/403|forbidden/i.test(message)) return this.t(ctx, "access_denied")
    if (/read-only/i.test(message)) return this.t(ctx, "read_only_error")
    return this.t(ctx, "request_failed")
  }

  private async logError(ctx: Context, prefix: string, error: unknown): Promise<void> {
    const name = error instanceof Error ? error.name : typeof error
    await this.api.Log(ctx, "Error", `${prefix}: ${name}`)
  }

  private statusText(status: number): string {
    if (status === 0) return "GOOD"
    if (status === 1) return "WEAK"
    if (status === 2) return "BREACHED"
    return "NOT_CHECKED"
  }

  private t(ctx: Context, key: string): Promise<string> {
    return this.api.GetTranslation(ctx, key)
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
