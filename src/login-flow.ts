import open from "open"

import { BrowserLauncher, LoginFlowClient, LoginFlowCredentials, LoginFlowSession } from "./types.js"
import { normalizeBaseUrl } from "./search.js"

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_MAX_WAIT_MS = 20 * 60 * 1_000

interface LoginFlowOptions {
  fetch?: typeof fetch
  maxWaitMs?: number
  now?: () => number
  pollIntervalMs?: number
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

interface LoginFlowStartResponse {
  login?: unknown
  poll?: {
    endpoint?: unknown
    token?: unknown
  }
}

interface LoginFlowPollResponse {
  appPassword?: unknown
  loginName?: unknown
  server?: unknown
}

export class NextcloudLoginFlowClient implements LoginFlowClient {
  private readonly fetchImpl: typeof fetch
  private readonly maxWaitMs: number
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly wait: (delayMs: number, signal?: AbortSignal) => Promise<void>

  constructor(options: LoginFlowOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.now = options.now ?? Date.now
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.wait = options.wait ?? waitFor
  }

  async start(baseUrl: string, signal?: AbortSignal): Promise<LoginFlowSession> {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
    const response = await this.fetchImpl(new URL("index.php/login/v2", normalizedBaseUrl), {
      method: "POST",
      headers: { Accept: "application/json", "OCS-APIRequest": "true" },
      signal
    })
    if (!response.ok) throw new Error(`Login Flow start failed with HTTP ${response.status}`)

    const body = (await response.json()) as LoginFlowStartResponse
    const loginUrl = this.validateFlowUrl(body.login, normalizedBaseUrl, "login")
    const pollUrl = this.validateFlowUrl(body.poll?.endpoint, normalizedBaseUrl, "poll")
    const token = requireString(body.poll?.token, "Login Flow token")

    return {
      loginUrl,
      poll: async (pollSignal) => this.poll(pollUrl, token, normalizedBaseUrl, pollSignal)
    }
  }

  async revoke(credentials: LoginFlowCredentials, signal?: AbortSignal): Promise<void> {
    const baseUrl = normalizeBaseUrl(credentials.server)
    const authorization = Buffer.from(`${credentials.loginName}:${credentials.appPassword}`, "utf8").toString("base64")
    const response = await this.fetchImpl(new URL("ocs/v2.php/core/apppassword", baseUrl), {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${authorization}`,
        "OCS-APIRequest": "true"
      },
      signal
    })
    if (!response.ok) throw new Error(`App-password revocation failed with HTTP ${response.status}`)
  }

  private async poll(
    pollUrl: string,
    token: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<LoginFlowCredentials> {
    const deadline = this.now() + this.maxWaitMs
    while (this.now() < deadline) {
      const response = await this.fetchImpl(pollUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal
      })
      if (response.status === 404) {
        await this.wait(this.pollIntervalMs, signal)
        continue
      }
      if (!response.ok) throw new Error(`Login Flow polling failed with HTTP ${response.status}`)

      const body = (await response.json()) as LoginFlowPollResponse
      const server = this.validateFlowUrl(body.server, baseUrl, "server")
      return {
        appPassword: requireString(body.appPassword, "Login Flow app password"),
        loginName: requireString(body.loginName, "Login Flow login name"),
        server
      }
    }
    throw new Error("Login Flow authorization timed out")
  }

  private validateFlowUrl(value: unknown, baseUrl: string, label: string): string {
    const url = new URL(requireString(value, `Login Flow ${label} URL`))
    const expected = new URL(baseUrl)
    if (url.protocol !== "https:") throw new Error(`Login Flow ${label} URL must use HTTPS`)
    if (url.origin !== expected.origin) throw new Error(`Login Flow ${label} URL changed server origin`)
    return url.toString()
  }
}

export const systemBrowserLauncher: BrowserLauncher = {
  open: async (url) => {
    await open(url, { wait: false })
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing`)
  return value.trim()
}

function waitFor(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      return
    }

    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
