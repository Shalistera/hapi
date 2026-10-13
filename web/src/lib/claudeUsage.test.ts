import { describe, expect, it } from 'vitest'
import type { ClaudeUsage, Machine, Session } from '@/types/api'
import {
    formatClaudeUsageLimitLabel,
    formatClaudeUsageResetIn,
    presentClaudeUsage,
    selectClaudeUsageForSession
} from './claudeUsage'

const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key

const usage: ClaudeUsage = {
    fetchedAt: 1_000,
    subscriptionType: 'max',
    limits: [
        { kind: 'session', scope: null, percent: 15.4, resetsAt: 10_000, severity: 'normal' },
        { kind: 'weekly_all', scope: null, percent: 60, resetsAt: 50_000, severity: 'normal' },
        { kind: 'weekly_scoped', scope: 'Fable', percent: 96, resetsAt: 50_000, severity: 'critical' }
    ]
}

describe('presentClaudeUsage', () => {
    it('picks the 5-hour and all-models weekly meters and grades every row', () => {
        const presentation = presentClaudeUsage(usage, 2_000)

        expect(presentation.session).toMatchObject({ kind: 'session', percent: 15, tone: 'ok', reset: false })
        expect(presentation.weekly).toMatchObject({ kind: 'weekly_all', percent: 60, tone: 'ok' })
        expect(presentation.rows.map((row) => row.tone)).toEqual(['ok', 'ok', 'critical'])
        expect(presentation.tone).toBe('critical')
    })

    it('shows a window that has reset since the snapshot as empty', () => {
        const presentation = presentClaudeUsage(usage, 20_000)

        expect(presentation.session).toMatchObject({ percent: 0, reset: true, tone: 'ok' })
        expect(presentation.weekly).toMatchObject({ percent: 60, reset: false })
    })

    it('grades rows the server did not grade by threshold', () => {
        const presentation = presentClaudeUsage({
            fetchedAt: 1,
            limits: [
                { kind: 'session', percent: 74, resetsAt: null },
                { kind: 'weekly_all', percent: 75, resetsAt: null },
                { kind: 'weekly_scoped', scope: 'Opus', percent: 90, resetsAt: null }
            ]
        }, 2)

        expect(presentation.rows.map((row) => row.tone)).toEqual(['ok', 'warn', 'critical'])
    })

    it('falls back to any weekly meter when there is no all-models row', () => {
        const presentation = presentClaudeUsage({
            fetchedAt: 1,
            limits: [{ kind: 'weekly_scoped', scope: 'Opus', percent: 30, resetsAt: null }]
        }, 2)

        expect(presentation.session).toBeNull()
        expect(presentation.weekly).toMatchObject({ kind: 'weekly_scoped' })
    })
})

describe('selectClaudeUsageForSession', () => {
    it('reads the snapshot of the session machine', () => {
        const session = { metadata: { path: '/r', host: 'h', machineId: 'm1' } } as Session
        const machines = [
            { id: 'm0', claudeUsage: { ...usage, fetchedAt: 5 } },
            { id: 'm1', claudeUsage: usage }
        ] as Machine[]

        expect(selectClaudeUsageForSession(session, machines)).toBe(usage)
        expect(selectClaudeUsageForSession({ metadata: { path: '/r', host: 'h' } } as Session, machines)).toBeNull()
        expect(selectClaudeUsageForSession(session, [{ id: 'm1' } as Machine])).toBeNull()
    })
})

describe('labels', () => {
    it('names known meters and falls back to the raw kind', () => {
        expect(formatClaudeUsageLimitLabel({ kind: 'session', scope: null }, t)).toBe('claudeUsage.limit.session')
        expect(formatClaudeUsageLimitLabel({ kind: 'weekly_scoped', scope: 'Fable' }, t))
            .toBe('claudeUsage.limit.weeklyScoped:{"scope":"Fable"}')
        expect(formatClaudeUsageLimitLabel({ kind: 'monthly_spend', scope: 'Slack' }, t)).toBe('monthly spend (Slack)')
    })

    it('formats the time left until a reset', () => {
        expect(formatClaudeUsageResetIn(1_000, 2_000, t)).toBeNull()
        expect(formatClaudeUsageResetIn(61_000, 1_000, t)).toBe('claudeUsage.duration.minutes:{"m":1}')
        expect(formatClaudeUsageResetIn(1_000 + (2 * 60 + 13) * 60_000, 1_000, t))
            .toBe('claudeUsage.duration.hoursMinutes:{"h":2,"m":13}')
        expect(formatClaudeUsageResetIn(1_000 + (36 * 60 + 5) * 60_000, 1_000, t))
            .toBe('claudeUsage.duration.daysHours:{"d":1,"h":12}')
    })
})
