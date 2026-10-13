import { ClaudeUsageLimitSchema } from '@hapi/protocol/schemas'
import type { ClaudeUsage, ClaudeUsageLimit } from '@hapi/protocol/types'

type RecordValue = Record<string, unknown>

export type ClaudeUsageParseResult =
    | { status: 'ok'; usage: ClaudeUsage }
    /** Plan limits do not apply: API key, Bedrock, Vertex, or no profile scope. */
    | { status: 'unavailable' }
    | { status: 'invalid' }

const MAX_LIMITS = 32

function asRecord(value: unknown): RecordValue | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null
}

function asPercent(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function asResetsAt(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

function asDisplayName(value: unknown): string | null {
    const name = asRecord(value)?.display_name
    return typeof name === 'string' && name.trim() ? name.trim() : null
}

function toLimit(candidate: ClaudeUsageLimit): ClaudeUsageLimit | null {
    const parsed = ClaudeUsageLimitSchema.safeParse(candidate)
    return parsed.success ? parsed.data : null
}

/**
 * The usage endpoint's own rows: which meters apply, their scope, order and
 * severity are the server's, so a new meter needs no HAPI release.
 */
function limitsFromServerRows(rows: unknown): ClaudeUsageLimit[] | null {
    if (!Array.isArray(rows)) return null
    const limits: ClaudeUsageLimit[] = []
    for (const row of rows) {
        const record = asRecord(row)
        const percent = asPercent(record?.percent)
        if (!record || typeof record.kind !== 'string' || percent === null) continue
        const scope = asRecord(record.scope)
        const limit = toLimit({
            kind: record.kind,
            scope: asDisplayName(scope?.model) ?? asDisplayName(scope?.surface),
            percent,
            resetsAt: asResetsAt(record.resets_at),
            ...(typeof record.severity === 'string' ? { severity: record.severity } : {})
        })
        if (limit) limits.push(limit)
    }
    return limits
}

/** The documented per-window fields, for replies that carry no server rows. */
function limitsFromWindows(rateLimits: RecordValue): ClaudeUsageLimit[] {
    const limits: ClaudeUsageLimit[] = []
    const add = (kind: string, scope: string | null, window: unknown) => {
        const record = asRecord(window)
        const percent = asPercent(record?.utilization)
        if (!record || percent === null) return
        const limit = toLimit({ kind, scope, percent, resetsAt: asResetsAt(record.resets_at) })
        if (limit) limits.push(limit)
    }

    add('session', null, rateLimits.five_hour)
    add('weekly_all', null, rateLimits.seven_day)
    if (Array.isArray(rateLimits.model_scoped)) {
        for (const row of rateLimits.model_scoped) {
            add('weekly_scoped', asDisplayName(row), row)
        }
    } else {
        add('weekly_scoped', 'Opus', rateLimits.seven_day_opus)
        add('weekly_scoped', 'Sonnet', rateLimits.seven_day_sonnet)
    }
    return limits
}

/** Converts a Claude Code `get_usage` control response into a ClaudeUsage snapshot. */
export function parseClaudeUsageResponse(response: unknown, fetchedAt: number): ClaudeUsageParseResult {
    const record = asRecord(response)
    if (!record) return { status: 'invalid' }
    if (record.rate_limits_available === false) return { status: 'unavailable' }

    const rateLimits = asRecord(record.rate_limits)
    if (!rateLimits) return { status: 'invalid' }

    const serverRows = limitsFromServerRows(rateLimits.limits)
    const limits = serverRows && serverRows.length > 0 ? serverRows : limitsFromWindows(rateLimits)
    if (limits.length === 0) return { status: 'invalid' }

    const subscriptionType = typeof record.subscription_type === 'string'
        ? record.subscription_type.slice(0, 64)
        : null
    return {
        status: 'ok',
        usage: {
            fetchedAt,
            subscriptionType,
            limits: limits.slice(0, MAX_LIMITS)
        }
    }
}
