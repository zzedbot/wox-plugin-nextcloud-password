import assert from "node:assert/strict"
import test from "node:test"

import { NextcloudVaultClient } from "./nextcloud-client.js"

const passwordId = "11111111-1111-4111-8111-111111111111"
const firstRevision = "22222222-2222-4222-8222-222222222222"
const secondRevision = "33333333-3333-4333-8333-333333333333"

const passwordObject = {
  id: passwordId,
  revision: firstRevision,
  label: "GitHub",
  username: "octocat",
  password: "old-secret",
  url: "https://github.com",
  notes: "Test account",
  customFields: "[]",
  status: 0,
  statusCode: "GOOD",
  hash: "",
  folderId: "00000000-0000-0000-0000-000000000000",
  share: null,
  shared: false,
  editable: true,
  cseType: "none",
  cseKey: "",
  sseType: "SSEv1r1",
  client: "Wox test",
  hidden: false,
  trashed: false,
  favorite: true,
  edited: 1_700_000_000,
  created: 1_700_000_000,
  updated: 1_700_000_000
}

test("opens a Passwords API session, lists entries, and updates the latest model", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ body: Record<string, unknown> | null; method: string; url: string }> = []

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = request.method === "GET" ? null : ((await request.clone().json()) as Record<string, unknown>)
    requests.push({ body, method: request.method, url: request.url })

    if (request.url.endsWith("/1.0/session/request")) return jsonResponse({})
    if (request.url.endsWith("/1.0/session/open")) return jsonResponse({ success: true })
    if (request.url.endsWith("/1.0/password/list")) return jsonResponse([passwordObject])
    if (request.url.endsWith("/1.0/password/show")) return jsonResponse(passwordObject)
    if (request.url.endsWith("/1.0/password/update")) {
      return jsonResponse({ id: passwordId, revision: secondRevision })
    }
    if (request.url.endsWith("/1.0/session/close")) return jsonResponse({ success: true })
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  }

  try {
    const client = new NextcloudVaultClient()
    assert.equal(
      await client.connect({
        baseUrl: "https://cloud.example.com/nextcloud",
        username: "alice",
        appPassword: "app-password"
      }),
      null
    )

    const entries = await client.listPasswords()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.password, "old-secret")

    const updated = await client.updatePassword(passwordId, {
      label: "GitHub Work",
      username: "alice@example.com",
      newPassword: "new-secret",
      url: "https://github.com",
      notes: "Updated"
    })
    assert.equal(updated.label, "GitHub Work")
    assert.equal(updated.password, "new-secret")

    const updateRequest = requests.find((request) => request.url.endsWith("/1.0/password/update"))
    assert.equal(updateRequest?.method, "PATCH")
    assert.equal(updateRequest?.body?.label, "GitHub Work")
    assert.equal(updateRequest?.body?.password, "new-secret")
    assert.equal(updateRequest?.body?.cseType, "none")

    const unpinned = await client.setFavorite(passwordId, false)
    assert.equal(unpinned.favorite, false)
    const favoriteRequest = requests.filter((request) => request.url.endsWith("/1.0/password/update")).at(-1)
    assert.equal(favoriteRequest?.body?.favorite, false)
    client.disconnect()
  } finally {
    globalThis.fetch = originalFetch
  }
})

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-api-session": "test-session"
    }
  })
}
