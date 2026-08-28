import assert from "node:assert/strict"
import test from "node:test"

import { NextcloudLoginFlowClient } from "./login-flow.js"

test("starts Login Flow v2, waits through 404 responses, and returns device credentials", async () => {
  let now = 0
  let polls = 0
  const requests: Request[] = []
  const client = new NextcloudLoginFlowClient({
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.endsWith("/index.php/login/v2")) {
        return jsonResponse({
          login: "https://cloud.example.com/nextcloud/login/v2/flow/test",
          poll: {
            endpoint: "https://cloud.example.com/nextcloud/login/v2/poll",
            token: "one-time-token"
          }
        })
      }

      polls += 1
      if (polls === 1) return new Response(null, { status: 404 })
      return jsonResponse({
        appPassword: "device-password",
        loginName: "alice",
        server: "https://cloud.example.com/nextcloud"
      })
    },
    now: () => now,
    wait: async (delayMs) => {
      now += delayMs
    }
  })

  const session = await client.start("https://cloud.example.com/nextcloud")
  const credentials = await session.poll()

  assert.equal(session.loginUrl, "https://cloud.example.com/nextcloud/login/v2/flow/test")
  assert.deepEqual(credentials, {
    appPassword: "device-password",
    loginName: "alice",
    server: "https://cloud.example.com/nextcloud"
  })
  assert.equal(await requests[1]?.clone().text(), "token=one-time-token")
})

test("rejects cross-origin Login Flow endpoints", async () => {
  const client = new NextcloudLoginFlowClient({
    fetch: async () =>
      jsonResponse({
        login: "https://attacker.example/flow",
        poll: { endpoint: "https://cloud.example.com/login/v2/poll", token: "token" }
      })
  })

  await assert.rejects(() => client.start("https://cloud.example.com"), /changed server origin/)
})

test("times out when authorization is not completed", async () => {
  let now = 0
  const client = new NextcloudLoginFlowClient({
    fetch: async (input) => {
      if (String(input).endsWith("/index.php/login/v2")) {
        return jsonResponse({
          login: "https://cloud.example.com/login/v2/flow/test",
          poll: { endpoint: "https://cloud.example.com/login/v2/poll", token: "token" }
        })
      }
      return new Response(null, { status: 404 })
    },
    maxWaitMs: 2_000,
    now: () => now,
    pollIntervalMs: 1_000,
    wait: async (delayMs) => {
      now += delayMs
    }
  })

  const session = await client.start("https://cloud.example.com")
  await assert.rejects(() => session.poll(), /timed out/)
})

test("cancels polling when the authorization signal is aborted", async () => {
  const client = new NextcloudLoginFlowClient({
    fetch: async (input) => {
      if (String(input).endsWith("/index.php/login/v2")) {
        return jsonResponse({
          login: "https://cloud.example.com/login/v2/flow/test",
          poll: { endpoint: "https://cloud.example.com/login/v2/poll", token: "token" }
        })
      }
      return new Response(null, { status: 404 })
    }
  })
  const controller = new AbortController()
  const session = await client.start("https://cloud.example.com", controller.signal)
  controller.abort()

  await assert.rejects(
    () => session.poll(controller.signal),
    (error: unknown) => {
      return error instanceof Error && error.name === "AbortError"
    }
  )
})

test("revokes the generated app password with Basic authentication", async () => {
  let request: Request | undefined
  const client = new NextcloudLoginFlowClient({
    fetch: async (input, init) => {
      request = new Request(input, init)
      return new Response(null, { status: 200 })
    }
  })

  await client.revoke({
    appPassword: "device-password",
    loginName: "alice@example.com",
    server: "https://cloud.example.com/nextcloud"
  })

  assert.equal(request?.method, "DELETE")
  assert.equal(request?.url, "https://cloud.example.com/nextcloud/ocs/v2.php/core/apppassword")
  assert.equal(
    request?.headers.get("authorization"),
    `Basic ${Buffer.from("alice@example.com:device-password").toString("base64")}`
  )
})

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" }
  })
}
