import type { ClaudeUsage, ClaudeUsageLimit, Machine, Session } from '@/types/api'

export type ClaudeUsageTone = 'ok' | 'warn' | 'critical'

export type ClaudeUsageRow = {
    key: string
    kind: string
    scope: string | null
    /** Rounded share of the window used; 0 once the window has reset. */
    percent: number
    resetsAt: number | null
    /** The window reset after the snapshot was taken. */
    reset: boolean
    tone: ClaudeUsageTone
}

export type ClaudeUsagePresentation = {
    rows: ClaudeUsageRow[]
    /** 5-hour window, shown first in the header meter. */
    session: ClaudeUsageRow | null
    /** All-models weekly window, shown second in the header meter. */
    weekly: ClaudeUsageRow | null
    /** Worst tone over every row, so a scoped meter near its cap still shows. */
    tone: ClaudeUsageTone
    fetchedAt: number
}

export const CLAUDE_USAGE_BAR_FILL_CLASS: Record<ClaudeUsageTone, string> = {
    ok: 'bg-[var(--app-link)]/70',
    warn: 'bg-[var(--app-badge-warning-text)]',
    critical: 'bg-[var(--app-badge-error-text)]'
}

export const CLAUDE_USAGE_TEXT_CLASS: Record<ClaudeUsageTone, string> = {
    ok: 'text-[var(--app-fg)]',
    warn: 'text-[var(--app-badge-warning-text)]',
    critical: 'text-[var(--app-badge-error-text)]'
}

const TONE_RANK: Record<ClaudeUsageTone, number> = { ok: 0, warn: 1, critical: 2 }

function toneFor(limit: ClaudeUsageLimit, percent: number): ClaudeUsageTone {
    // The server grades its own meters; only ungraded rows fall back to thresholds.
    if (limit.severity === 'critical') return 'critical'
    if (limit.severity === 'warning') return 'warn'
    if (limit.severity === 'normal') return 'ok'
    return percent >= 90 ? 'critical' : percent >= 75 ? 'warn' : 'ok'
}

export function presentClaudeUsage(usage: ClaudeUsage, now: number): ClaudeUsagePresentation {
    const rows = usage.limits.map((limit, index): ClaudeUsageRow => {
        const reset = limit.resetsAt !== null && limit.resetsAt <= now
        const percent = reset ? 0 : Math.round(limit.percent)
        return {
            key: `${index}:${limit.kind}:${limit.scope ?? ''}`,
            kind: limit.kind,
            scope: limit.scope ?? null,
            percent,
            resetsAt: limit.resetsAt,
            reset,
            tone: reset ? 'ok' : toneFor(limit, percent)
        }
    })

    const tone = rows.reduce<ClaudeUsageTone>(
        (worst, row) => TONE_RANK[row.tone] > TONE_RANK[worst] ? row.tone : worst,
        'ok'
    )

    return {
        rows,
        session: rows.find((row) => row.kind === 'session') ?? null,
        weekly: rows.find((row) => row.kind === 'weekly_all')
            ?? rows.find((row) => row.kind.startsWith('weekly'))
            ?? null,
        tone,
        fetchedAt: usage.fetchedAt
    }
}

/** Usage is account-wide; the hub keeps the latest snapshot on the session's machine. */
export function selectClaudeUsageForSession(session: Session, machines: Machine[]): ClaudeUsage | null {
    const machineId = session.metadata?.machineId
    if (!machineId) return null
    return machines.find((machine) => machine.id === machineId)?.claudeUsage ?? null
}

type Translate = (key: string, params?: Record<string, string | number>) => string

export function formatClaudeUsageLimitLabel(row: Pick<ClaudeUsageRow, 'kind' | 'scope'>, t: Translate): string {
    if (row.kind === 'session') return t('claudeUsage.limit.session')
    if (row.kind === 'weekly_all') return t('claudeUsage.limit.weeklyAll')
    if (row.kind === 'weekly_scoped' && row.scope) return t('claudeUsage.limit.weeklyScoped', { scope: row.scope })
    const kind = row.kind.replace(/_/g, ' ')
    return row.scope ? `${kind} (${row.scope})` : kind
}

/** "2h 13m" style time left until `resetsAt`, or null once it has passed. */
export function formatClaudeUsageResetIn(resetsAt: number, now: number, t: Translate): string | null {
    const minutes = Math.ceil((resetsAt - now) / 60_000)
    if (!Number.isFinite(minutes) || minutes <= 0) return null
    if (minutes < 60) return t('claudeUsage.duration.minutes', { m: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('claudeUsage.duration.hoursMinutes', { h: hours, m: minutes % 60 })
    return t('claudeUsage.duration.daysHours', { d: Math.floor(hours / 24), h: hours % 24 })
}
