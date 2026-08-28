import assert from "node:assert/strict"
import test from "node:test"

import { ActionContext, Context, PluginInitParams, PublicAPI } from "@wox-launcher/wox-plugin"

import { NextcloudPasswordsPlugin } from "./plugin.js"
import { BrowserLauncher, LoginFlowClient, VaultClient } from "./types.js"

test("keeps lifecycle methods bound when the Node.js host invokes them as standalone functions", async () => {
  const calls: string[] = []
  const api = {
    Log: async () => {
      calls.push("Log")
    },
    OnSettingChanged: async () => {
      calls.push("OnSettingChanged")
    },
    OnUnload: async () => {
      calls.push("OnUnload")
    }
  } as unknown as PublicAPI
  const client = {
    connect: async () => null,
    disconnect: () => undefined,
    listPasswords: async () => [],
    unlock: async () => undefined,
    updatePassword: async () => {
      throw new Error("Not used")
    }
  } satisfies VaultClient
  const instance = new NextcloudPasswordsPlugin(client)
  const init = instance.init

  await init({} as Context, { API: api, PluginDirectory: "C:/plugin" } as PluginInitParams)

  assert.deepEqual(calls, ["OnSettingChanged", "OnUnload", "Log"])
})

test("uses entry-specific action IDs and copies the selected password", async () => {
  const copied: string[] = []
  const api = {
    Copy: async (_ctx: Context, value: { text: string }) => {
      copied.push(value.text)
    },
    GetSetting: async (_ctx: Context, key: string) =>
      ({
        authorizedAppPassword: "app-password",
        authorizedServer: "https://cloud.example.com/",
        authorizedUsername: "alice",
        baseUrl: "https://cloud.example.com"
      })[key] || "",
    GetTranslation: async (_ctx: Context, key: string) => key,
    Log: async () => undefined,
    Notify: async () => undefined,
    OnSettingChanged: async () => undefined,
    OnUnload: async () => undefined
  } as unknown as PublicAPI
  const client = {
    connect: async () => null,
    disconnect: () => undefined,
    listPasswords: async () => [passwordEntry("first", "first-secret"), passwordEntry("second", "second-secret")],
    unlock: async () => undefined,
    updatePassword: async () => {
      throw new Error("Not used")
    }
  } satisfies VaultClient
  const instance = new NextcloudPasswordsPlugin(client)
  const ctx = {} as Context
  await instance.init(ctx, { API: api, PluginDirectory: "C:/plugin" } as PluginInitParams)

  const response = await instance.query(ctx, { Search: "" } as never)
  const defaultActions = response.Results.map((result) => result.Actions?.find((action) => action.IsDefault))

  assert.deepEqual(
    defaultActions.map((action) => action?.Id),
    ["copy-password-first", "copy-password-second"]
  )
  const firstAction = defaultActions[0]
  const secondAction = defaultActions[1]
  assert.ok(firstAction && firstAction.Type !== "form")
  assert.ok(secondAction && secondAction.Type !== "form")
  await firstAction.Action?.(ctx, {} as ActionContext)
  await secondAction.Action?.(ctx, {} as ActionContext)
  assert.deepEqual(copied, ["first-secret", "second-secret"])
})

test("authorizes through Login Flow v2, stores device credentials, and revokes them on disconnect", async () => {
  const settings: Record<string, string> = {
    appPassword: "legacy-password",
    baseUrl: "https://cloud.example.com/nextcloud",
    username: "legacy-user"
  }
  const opened: string[] = []
  const saved: Array<{ key: string; platformSpecific: boolean; value: string }> = []
  let revoked = false
  let refreshAfterAuthorization: (() => void) | undefined
  const authorized = new Promise<void>((resolve) => {
    refreshAfterAuthorization = resolve
  })
  const api = {
    GetSetting: async (_ctx: Context, key: string) => settings[key] || "",
    GetTranslation: async (_ctx: Context, key: string) => key,
    Log: async () => undefined,
    Notify: async () => undefined,
    OnSettingChanged: async () => undefined,
    OnUnload: async () => undefined,
    RefreshQuery: async () => refreshAfterAuthorization?.(),
    SaveSetting: async (_ctx: Context, key: string, value: string, platformSpecific: boolean) => {
      settings[key] = value
      saved.push({ key, platformSpecific, value })
    },
    UpdateResult: async () => true
  } as unknown as PublicAPI
  const loginFlow = {
    revoke: async () => {
      revoked = true
    },
    start: async () => ({
      loginUrl: "https://cloud.example.com/nextcloud/login/v2/flow/test",
      poll: async () => ({
        appPassword: "authorized-password",
        loginName: "alice",
        server: "https://cloud.example.com/nextcloud/"
      })
    })
  } satisfies LoginFlowClient
  const browser = {
    open: async (url: string) => {
      opened.push(url)
    }
  } satisfies BrowserLauncher
  const instance = new NextcloudPasswordsPlugin(stubVaultClient(), loginFlow, browser)
  const ctx = {} as Context
  await instance.init(ctx, { API: api, PluginDirectory: "C:/plugin" } as PluginInitParams)

  const connectResponse = await instance.query(ctx, { Command: "connect" } as never)
  const connectAction = connectResponse.Results[0]?.Actions?.find((action) => action.IsDefault)
  assert.ok(connectAction && connectAction.Type !== "form")
  await connectAction.Action?.(ctx, {} as ActionContext)
  await authorized

  assert.deepEqual(opened, ["https://cloud.example.com/nextcloud/login/v2/flow/test"])
  assert.equal(settings.authorizedUsername, "alice")
  assert.equal(settings.authorizedAppPassword, "authorized-password")
  assert.equal(settings.username, "")
  assert.equal(settings.appPassword, "")
  assert.ok(saved.some((item) => item.key === "authorizedAppPassword" && item.platformSpecific))

  refreshAfterAuthorization = undefined
  const disconnectResponse = await instance.query(ctx, { Command: "disconnect" } as never)
  const disconnectAction = disconnectResponse.Results[0]?.Actions?.find((action) => action.IsDefault)
  assert.ok(disconnectAction && disconnectAction.Type !== "form")
  await disconnectAction.Action?.(ctx, {} as ActionContext)

  assert.equal(revoked, true)
  assert.equal(settings.authorizedUsername, "")
  assert.equal(settings.authorizedAppPassword, "")
})

function passwordEntry(id: string, password: string) {
  return {
    editable: true,
    favorite: false,
    id,
    label: id,
    notes: "",
    password,
    status: 0,
    statusCode: "GOOD",
    url: "",
    username: ""
  }
}

function stubVaultClient(): VaultClient {
  return {
    connect: async () => null,
    disconnect: () => undefined,
    listPasswords: async () => [],
    unlock: async () => undefined,
    updatePassword: async () => {
      throw new Error("Not used")
    }
  }
}
