import { describe, expect, it } from 'vitest'
import { parseClaudeUsageResponse } from './claudeUsage'

// Trimmed from a real Claude Code 2.1.296 `get_usage` reply (Max plan).
const getUsageReply = {
    session: { total_cost_usd: 0 },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
        five_hour: { utilization: 15, resets_at: '2026-10-13T08:39:59.894370+00:00' },
        seven_day: { utilization: 60, resets_at: '2026-10-14T20:59:59.894398+00:00' },
        seven_day_opus: null,
        seven_day_sonnet: null,
        limits: [
            { kind: 'session', group: 'session', percent: 15, severity: 'normal', resets_at: '2026-10-13T08:39:59.894370+00:00', scope: null, is_active: false },
            { kind: 'weekly_all', group: 'weekly', percent: 60, severity: 'normal', resets_at: '2026-10-14T20:59:59.894398+00:00', scope: null, is_active: true },
            { kind: 'weekly_scoped', group: 'weekly', percent: 12, severity: 'normal', resets_at: '2026-10-14T20:59:59.894678+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false }
        ],
        model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: '2026-10-14T20:59:59.894678+00:00' }]
    },
    behaviors: null
}

describe('parseClaudeUsageResponse', () => {
    it('uses the server meter rows with their order, scope and severity', () => {
        expect(parseClaudeUsageResponse(getUsageReply, 1_000)).toEqual({
            status: 'ok',
            usage: {
                fetchedAt: 1_000,
                subscriptionType: 'max',
                limits: [
                    { kind: 'session', scope: null, percent: 15, resetsAt: Date.parse('2026-10-13T08:39:59.894Z'), severity: 'normal' },
                    { kind: 'weekly_all', scope: null, percent: 60, resetsAt: Date.parse('2026-10-14T20:59:59.894Z'), severity: 'normal' },
                    { kind: 'weekly_scoped', scope: 'Fable', percent: 12, resetsAt: Date.parse('2026-10-14T20:59:59.894Z'), severity: 'normal' }
                ]
            }
        })
    })

    it('falls back to the documented windows when the reply has no server rows', () => {
        const { limits: _limits, ...rateLimits } = getUsageReply.rate_limits
        const result = parseClaudeUsageResponse({ ...getUsageReply, rate_limits: rateLimits }, 1_000)

        expect(result.status).toBe('ok')
        expect(result.status === 'ok' && result.usage.limits).toEqual([
            { kind: 'session', scope: null, percent: 15, resetsAt: Date.parse('2026-10-13T08:39:59.894Z') },
            { kind: 'weekly_all', scope: null, percent: 60, resetsAt: Date.parse('2026-10-14T20:59:59.894Z') },
            { kind: 'weekly_scoped', scope: 'Fable', percent: 12, resetsAt: Date.parse('2026-10-14T20:59:59.894Z') }
        ])
    })

    it('reads the legacy per-model weekly windows', () => {
        const result = parseClaudeUsageResponse({
            rate_limits_available: true,
            rate_limits: {
                five_hour: { utilization: 3, resets_at: null },
                seven_day_opus: { utilization: 80, resets_at: null }
            }
        }, 1_000)

        expect(result.status === 'ok' && result.usage.limits).toEqual([
            { kind: 'session', scope: null, percent: 3, resetsAt: null },
            { kind: 'weekly_scoped', scope: 'Opus', percent: 80, resetsAt: null }
        ])
    })

    it('drops malformed rows instead of the whole snapshot', () => {
        const result = parseClaudeUsageResponse({
            rate_limits_available: true,
            rate_limits: {
                limits: [
                    { kind: 'session', percent: 'high' },
                    { kind: 'x'.repeat(65), percent: 5 },
                    { kind: 'weekly_all', percent: 42, resets_at: 'not a date' }
                ]
            }
        }, 1_000)

        expect(result.status === 'ok' && result.usage.limits).toEqual([
            { kind: 'weekly_all', scope: null, percent: 42, resetsAt: null }
        ])
    })

    it('reports logins without plan limits as unavailable', () => {
        expect(parseClaudeUsageResponse({ rate_limits_available: false, rate_limits: null }, 1_000))
            .toEqual({ status: 'unavailable' })
    })

    it('rejects replies without usable limits', () => {
        expect(parseClaudeUsageResponse(null, 1_000)).toEqual({ status: 'invalid' })
        expect(parseClaudeUsageResponse({ rate_limits_available: true, rate_limits: null }, 1_000)).toEqual({ status: 'invalid' })
        expect(parseClaudeUsageResponse({ rate_limits_available: true, rate_limits: { limits: [] } }, 1_000)).toEqual({ status: 'invalid' })
    })
})
