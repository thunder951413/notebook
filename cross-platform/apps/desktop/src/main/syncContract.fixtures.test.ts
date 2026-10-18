/**
 * TypeScript runner for the shared WebDAV v4 protocol fixtures in
 * SyncContractFixtures/webdav-v4 (transport categories). The Rust
 * (crates/notebook-sync) and Kotlin (notebook_android) runners read the same
 * files; the renderer runner covers the privacy envelope.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assessJournal,
  buildHead,
  committedView,
  compactJournal,
  journalHeadPath,
  journalPath,
  objectPath,
  parseHead,
  parseJournal,
  planJournalRead,
  planJournalReadSized,
  rebuildFloor,
  safeRemotePath,
  sortPulledEntries,
  validatedWebdavBaseUrl,
  type WebdavJournalEntry,
} from './webdav'

const FIXTURES = new URL('../../../../../SyncContractFixtures/webdav-v4/', import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))

describe('shared WebDAV v4 contract fixtures', () => {
  it('remote-path.json', () => {
    for (const testCase of fixture('remote-path.json').cases) {
      if (testCase.error) expect(() => safeRemotePath(testCase.input), JSON.stringify(testCase.input)).toThrow()
      else expect(safeRemotePath(testCase.input), JSON.stringify(testCase.input)).toBe(testCase.expected)
    }
  })

  it('base-url.json', () => {
    for (const testCase of fixture('base-url.json').cases) {
      let ok = true
      try { validatedWebdavBaseUrl(testCase.input) } catch { ok = false }
      expect(ok, testCase.input).toBe(testCase.ok)
    }
  })

  it('layout.json', () => {
    for (const testCase of fixture('layout.json').cases) {
      expect(journalPath(testCase.root, testCase.deviceId)).toBe(testCase.journalPath)
      expect(journalHeadPath(testCase.root, testCase.deviceId)).toBe(testCase.headPath)
      expect(objectPath(testCase.root, testCase.hash)).toBe(testCase.objectPath)
    }
  })

  it('journal-parse.json', () => {
    for (const testCase of fixture('journal-parse.json').cases) {
      if (testCase.error) {
        expect(() => parseJournal(testCase.text), testCase.name).toThrow()
        continue
      }
      const entries = parseJournal(testCase.text)
      expect(entries.map((entry) => ({ seq: entry.seq, op: entry.op, type: entry.type, id: entry.id, ver: entry.ver ?? 0, ...(entry.hash ? { hash: entry.hash } : {}) })), testCase.name)
        .toEqual(testCase.expected)
    }
  })

  it('journal-compact.json', () => {
    for (const testCase of fixture('journal-compact.json').cases) {
      const compacted = compactJournal(testCase.entries as WebdavJournalEntry[])
      expect(compacted.entries.map((entry) => entry.seq), testCase.name).toEqual(testCase.expectedSeqs)
      expect(compacted.stateEntries, testCase.name).toBe(testCase.stateEntries)
      expect(compacted.historyEntries, testCase.name).toBe(testCase.historyEntries)
    }
  })

  it('journal-head.json', () => {
    const value = fixture('journal-head.json')
    for (const testCase of value.build) {
      const entries = parseJournal(testCase.body)
      const head = buildHead(testCase.deviceId, testCase.body, entries, entries.length, 0)
      expect({ lastSeq: head.lastSeq, journalBytes: head.journalBytes, journalSha256: head.journalSha256 }, testCase.name).toEqual(testCase.expected)
    }
    for (const testCase of value.parse) {
      if (testCase.error) {
        expect(() => parseHead(testCase.text, testCase.deviceId), testCase.name).toThrow()
        continue
      }
      const head = parseHead(testCase.text, testCase.deviceId)
      expect({ lastSeq: head.lastSeq, journalBytes: head.journalBytes, journalSha256: head.journalSha256, stateEntries: head.stateEntries, historyEntries: head.historyEntries }, testCase.name)
        .toEqual(testCase.expected)
    }
  })

  it('committed-view.json', () => {
    const value = fixture('committed-view.json')
    const journal = parseJournal(value.journal)
    for (const testCase of value.cases) {
      const head = testCase.head ?? undefined
      const plan = planJournalRead(head, testCase.known)
      expect(plan.fetch, testCase.name).toBe(testCase.expected.fetch)
      if (!plan.fetch) {
        expect(testCase.expected.seqs).toEqual([])
        continue
      }
      const view = committedView(journal, value.journal, head, plan.known)
      expect(view.seqs, testCase.name).toEqual(testCase.expected.seqs)
      expect(plan.reset || view.reset, testCase.name).toBe(testCase.expected.reset)
      expect(view.mismatch, testCase.name).toBe(testCase.expected.mismatch)
    }
  })

  it('pull-isolation.json', () => {
    const value = fixture('pull-isolation.json')
    for (const testCase of value.cases) {
      let head
      try {
        head = testCase.headText === null ? undefined : parseHead(testCase.headText, value.deviceId)
      } catch {
        expect(testCase.expected, testCase.name).toMatchObject({ fetch: false, blocked: 'head-corrupt', seqs: [] })
        continue
      }
      const plan = planJournalReadSized(head, testCase.known, testCase.listedBytes ?? undefined)
      expect(plan.fetch, testCase.name).toBe(testCase.expected.fetch)
      if (!plan.fetch) {
        expect(testCase.expected.blocked, testCase.name).toBeNull()
        expect(testCase.expected.seqs).toEqual([])
        expect(plan.reset, testCase.name).toBe(testCase.expected.reset)
        continue
      }
      const assessment = assessJournal(testCase.journalText ?? undefined, head, plan.known)
      expect(assessment.blocked ?? null, testCase.name).toBe(testCase.expected.blocked)
      expect(assessment.seqs, testCase.name).toEqual(testCase.expected.seqs)
      expect(plan.reset || assessment.reset, testCase.name).toBe(testCase.expected.reset)
    }
  })

  it('journal-rebuild.json', () => {
    for (const testCase of fixture('journal-rebuild.json').cases) {
      expect(rebuildFloor(testCase.journalText ?? undefined, testCase.headText ?? undefined), testCase.name).toBe(testCase.expectedFloor)
    }
  })

  it('pull-order.json', () => {
    const value = fixture('pull-order.json')
    expect(sortPulledEntries([...value.entries])).toEqual(value.expected)
  })
})
