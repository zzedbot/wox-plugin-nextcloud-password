import { match } from "pinyin-pro"

import { PasswordEntry } from "./types.js"

const normalize = (value: string): string => value.normalize("NFKC").toLocaleLowerCase()
const containsHan = (value: string): boolean => /\p{Script=Han}/u.test(value)
const isPinyinQuery = (value: string): boolean => /^[a-z]+$/u.test(value)

function matchesPinyin(value: string, term: string): boolean {
  return containsHan(value) && isPinyinQuery(term) && match(value, term, { v: true }) !== null
}

export function scorePassword(entry: PasswordEntry, search: string): number {
  const terms = normalize(search)
    .split(/\s+/u)
    .filter((term) => term.length > 0)

  if (terms.length === 0) {
    return entry.favorite ? 90 : 60
  }

  const label = normalize(entry.label)
  const username = normalize(entry.username)
  const url = normalize(entry.url)
  const searchable = `${label}\n${username}\n${url}`

  if (
    !terms.every((term) => searchable.includes(term) || matchesPinyin(label, term) || matchesPinyin(username, term))
  ) {
    return -1
  }

  let score = entry.favorite ? 8 : 0
  for (const term of terms) {
    if (label === term) score += 50
    else if (label.startsWith(term)) score += 35
    else if (label.includes(term)) score += 25
    else if (username.includes(term)) score += 16
    else if (url.includes(term)) score += 10
    else if (matchesPinyin(label, term)) score += 22
    else if (matchesPinyin(username, term)) score += 14
  }

  return Math.min(100, score)
}

export function filterPasswords(entries: PasswordEntry[], search: string, limit = 50): PasswordEntry[] {
  return entries
    .map((entry) => ({ entry, score: scorePassword(entry, search) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.entry.label.localeCompare(right.entry.label))
    .slice(0, limit)
    .map(({ entry }) => entry)
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  const parsed = new URL(trimmed)
  if (parsed.protocol !== "https:") {
    throw new Error("Nextcloud requires HTTPS")
  }

  parsed.hash = ""
  parsed.search = ""
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/"
  return parsed.toString()
}
