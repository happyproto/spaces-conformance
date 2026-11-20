// The one data file the pages render from (scripts/data.ts writes it), and
// the small formatting helpers they share. Nothing here reads the store.
import site from '../data/site.json'
import type { SiteData } from '../../scripts/data.ts'

export type Site = SiteData
export type Impl = Site['implementations'][number]
export type RunView = Impl['latest'][string]
export type Row = RunView['rows'][number]
export type Assertion = Site['assertions'][number]
export type Group = 'pass' | 'deviation' | 'fail' | 'provisional' | 'error' | 'pending' | 'untested' | 'na'
export type Tally = Record<Group, number>

export const data = site as unknown as Site

/** Rows a run graded: what a cell's "x of y" counts. Pending, untested and n/a aren't graded. */
export const graded = (t: Tally) => t.pass + t.deviation + t.fail + t.provisional + t.error

export const GROUP_LABEL: Record<Group, string> = {
  pass: 'pass',
  deviation: 'known deviation',
  fail: 'fail',
  provisional: 'fail (provisional)',
  error: 'error',
  pending: 'pending',
  untested: 'no test yet',
  na: 'not applicable',
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Nov 14, 2026", in UTC, so a build anywhere prints the same page. */
export function day(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}
/** "Nov 14, 2026, 20:24 UTC". */
export function moment(iso: string): string {
  const d = new Date(iso)
  return `${day(iso)}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

/** The digest part of an image reference, shortened for a cell; the full one goes in a title. */
export const shortDigest = (image: string) => (image.split('@')[1] ?? image).replace(/^sha256:/, '').slice(0, 12)
export const repoOf = (image: string) => image.split('@')[0]

export const pct = (p: number, n: number) => (n ? `${Math.round((100 * p) / n)}%` : 'n/a')

export const KIND_LABEL: Record<string, string> = {
  nightly: 'Nightly run',
  candidate: 'Candidate run',
  release: 'Release run',
  local: 'Local run',
}

/** The runs behind a page, newest revision first: what the grid and the implementation page show. */
export const latestRuns = (impl: Impl) =>
  Object.entries(impl.latest)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([revision, run]) => ({ revision, run: run as RunView }))

export const assertionHref = (id: string) => `/assertion/${id}/`
export const implHref = (id: string) => `/impl/${id}/`

/** A tracking value that's a URL becomes a link; a ticket id stays text. */
export const trackingUrl = (t: string) => (/^https?:\/\//.test(t) ? t : null)
