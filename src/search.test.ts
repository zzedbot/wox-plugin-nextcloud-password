import assert from "node:assert/strict"
import test from "node:test"

import { filterPasswords, normalizeBaseUrl, scorePassword } from "./search.js"
import { PasswordEntry } from "./types.js"

const entry = (overrides: Partial<PasswordEntry>): PasswordEntry => ({
  editable: true,
  favorite: false,
  id: "1",
  label: "GitHub",
  notes: "",
  password: "secret",
  status: 0,
  statusCode: "GOOD",
  url: "https://github.com",
  username: "octocat",
  ...overrides
})

test("scores exact labels ahead of username and URL matches", () => {
  assert.ok(scorePassword(entry({}), "github") > scorePassword(entry({ label: "Code", username: "github" }), "github"))
  assert.ok(scorePassword(entry({ label: "Code", username: "github" }), "github") > 0)
})

test("requires every search term and sorts favorites first for empty searches", () => {
  const entries = [entry({ id: "a", label: "Alpha" }), entry({ id: "b", label: "Beta", favorite: true })]
  assert.deepEqual(
    filterPasswords(entries, "").map((item) => item.id),
    ["b", "a"]
  )
  assert.deepEqual(filterPasswords(entries, "alpha missing"), [])
})

test("matches Chinese labels and usernames by full pinyin, initials, and partial syllables", () => {
  const chinese = entry({ id: "cn", label: "招商银行", username: "张三" })

  assert.ok(scorePassword(chinese, "zhaoshangyinhang") > 0)
  assert.ok(scorePassword(chinese, "zsyh") > 0)
  assert.ok(scorePassword(chinese, "shangyh") > 0)
  assert.ok(scorePassword(chinese, "zhangs") > 0)
  assert.equal(scorePassword(chinese, "gongshangyinhang"), -1)
})

test("supports mixed literal and pinyin terms without changing direct-match priority", () => {
  const entries = [
    entry({ id: "direct", label: "zsyh" }),
    entry({ id: "pinyin", label: "招商银行 GitLab" }),
    entry({ id: "other", label: "工商银行 GitLab" })
  ]

  assert.deepEqual(
    filterPasswords(entries, "zsyh").map((item) => item.id),
    ["direct", "pinyin"]
  )
  assert.deepEqual(
    filterPasswords(entries, "zsyh gitlab").map((item) => item.id),
    ["pinyin"]
  )
})

test("normalizes a Nextcloud base URL and rejects HTTP", () => {
  assert.equal(normalizeBaseUrl("https://cloud.example.com/nextcloud"), "https://cloud.example.com/nextcloud/")
  assert.throws(() => normalizeBaseUrl("http://cloud.example.com"), /HTTPS/)
})
