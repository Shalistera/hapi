import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ClaudeUsage, MachinesResponse } from '@/types/api'
import {
    CLAUDE_USAGE_BAR_FILL_CLASS,
    CLAUDE_USAGE_TEXT_CLASS,
    formatClaudeUsageLimitLabel,
    formatClaudeUsageResetIn,
    presentClaudeUsage,
    type ClaudeUsageRow
} from '@/lib/claudeUsage'
import { queryKeys } from '@/lib/query-keys'
import { formatAbsoluteDateTime, formatRelativeTime } from '@/lib/relativeTime'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

/** Opening the panel re-reads usage when the snapshot is older than this. */
const STALE_AFTER_MS = 60_000

type RefreshError = 'notRunning' | 'unavailable' | 'failed'

function MeterLine(props: { label: string; row: ClaudeUsageRow | null }) {
    const { row } = props
    return (
        <span className="flex items-center gap-1">
            <span className="w-3.5 text-[var(--app-hint)]">{props.label}</span>
            <span
                className="relative hidden h-1 w-8 overflow-hidden rounded-full bg-[var(--app-border)]/80 sm:block"
                aria-hidden="true"
            >
                {row ? (
                    <span
                        className={cn('block h-full rounded-full', CLAUDE_USAGE_BAR_FILL_CLASS[row.tone])}
                        style={{ width: `${Math.min(100, row.percent)}%` }}
                    />
                ) : null}
            </span>
            <span className={cn('w-7 text-right font-medium', row ? CLAUDE_USAGE_TEXT_CLASS[row.tone] : 'text-[var(--app-hint)]')}>
                {row ? `${row.percent}%` : '—'}
            </span>
        </span>
    )
}

function UsageRow(props: { row: ClaudeUsageRow; now: number }) {
    const { t } = useTranslation()
    const { row } = props
    const resetIn = row.resetsAt !== null ? formatClaudeUsageResetIn(row.resetsAt, props.now, t) : null
    return (
        <div className="space-y-1" data-testid="claude-usage-row">
            <div className="flex items-baseline justify-between gap-3">
                <span className="truncate">{formatClaudeUsageLimitLabel(row, t)}</span>
                <span className={cn('font-semibold tabular-nums', CLAUDE_USAGE_TEXT_CLASS[row.tone])}>
                    {row.percent}%
                </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--app-border)]/80" aria-hidden="true">
                <div
                    className={cn('h-full rounded-full', CLAUDE_USAGE_BAR_FILL_CLASS[row.tone])}
                    style={{ width: `${Math.min(100, row.percent)}%` }}
                />
            </div>
            {row.reset ? (
                <div className="text-[var(--app-hint)]">{t('claudeUsage.reset')}</div>
            ) : resetIn ? (
                <div className="text-[var(--app-hint)]" title={row.resetsAt !== null ? formatAbsoluteDateTime(row.resetsAt) ?? undefined : undefined}>
                    {t('claudeUsage.resetsIn', { time: resetIn })}
                </div>
            ) : null}
        </div>
    )
}

/**
 * Header meter for Claude plan usage (5-hour and weekly windows). The data is
 * account-wide and lives on the session's machine; tapping opens the full
 * breakdown and re-reads it from the session's Claude process.
 */
export function ClaudeUsageMeter(props: {
    sessionId: string
    sessionActive: boolean
    machineId: string | null
    usage: ClaudeUsage | null
    api: ApiClient | null
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const panelId = useId()
    const containerRef = useRef<HTMLSpanElement>(null)
    const [open, setOpen] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<RefreshError | null>(null)
    const tick = useMinuteTick(true)
    const { sessionId, sessionActive, machineId, usage, api } = props

    // `tick` re-evaluates elapsed reset windows once a minute.
    const now = useMemo(() => Date.now(), [tick, usage])
    const presentation = useMemo(() => (usage ? presentClaudeUsage(usage, now) : null), [usage, now])

    const refresh = useCallback(async () => {
        if (!api || refreshing) return
        setRefreshing(true)
        setError(null)
        try {
            const result = await api.refreshClaudeUsage(sessionId)
            if (result.status === 'ok') {
                // The machine-updated SSE event carries the same snapshot; apply it
                // now so the panel does not wait on it.
                const fresh = result.usage
                queryClient.setQueryData<MachinesResponse>(queryKeys.machines, (previous) => previous && machineId
                    ? {
                        ...previous,
                        machines: previous.machines.map((machine) => (
                            machine.id === machineId && (machine.claudeUsage?.fetchedAt ?? 0) < fresh.fetchedAt
                                ? { ...machine, claudeUsage: fresh }
                                : machine
                        ))
                    }
                    : previous)
            } else {
                setError(result.status === 'not-running' ? 'notRunning' : result.status)
            }
        } catch {
            setError('failed')
        } finally {
            setRefreshing(false)
        }
    }, [api, machineId, queryClient, refreshing, sessionId])

    const canRefresh = Boolean(api) && sessionActive

    const handleToggle = () => {
        const next = !open
        setOpen(next)
        if (next && canRefresh && (!usage || Date.now() - usage.fetchedAt > STALE_AFTER_MS)) {
            void refresh()
        }
    }

    useEffect(() => {
        if (!open) return
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setOpen(false)
            }
        }
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', closeOnOutsidePointer)
        document.addEventListener('keydown', closeOnEscape)
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePointer)
            document.removeEventListener('keydown', closeOnEscape)
        }
    }, [open])

    const session = presentation?.session ?? null
    const weekly = presentation?.weekly ?? null
    const ariaLabel = t('claudeUsage.aria', {
        session: session ? `${session.percent}%` : '—',
        weekly: weekly ? `${weekly.percent}%` : '—'
    })
    const errorKey = error === 'notRunning'
        ? 'claudeUsage.error.notRunning'
        : error === 'unavailable'
            ? 'claudeUsage.error.unavailable'
            : error === 'failed'
                ? 'claudeUsage.error.failed'
                : null

    return (
        <span ref={containerRef} className="relative inline-flex shrink-0">
            <button
                type="button"
                data-testid="claude-usage-meter"
                onClick={handleToggle}
                aria-label={ariaLabel}
                title={t('claudeUsage.title')}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                className={cn(
                    'flex h-8 items-center rounded-full px-1.5 text-[10px] leading-none tabular-nums transition-colors hover:bg-[var(--app-secondary-bg)]',
                    open ? 'bg-[var(--app-secondary-bg)]' : null
                )}
            >
                <span className="flex flex-col gap-[3px]">
                    <MeterLine label="5h" row={session} />
                    <MeterLine label="7d" row={weekly} />
                </span>
                {presentation && presentation.tone !== 'ok'
                    && presentation.tone !== session?.tone && presentation.tone !== weekly?.tone ? (
                    // A meter not shown in the header (e.g. a per-model weekly cap) is the one running out.
                    <span
                        data-testid="claude-usage-attention"
                        className={cn('ml-1 h-1.5 w-1.5 rounded-full', CLAUDE_USAGE_BAR_FILL_CLASS[presentation.tone])}
                        aria-hidden="true"
                    />
                ) : null}
            </button>

            {open ? (
                <div
                    id={panelId}
                    role="dialog"
                    aria-label={t('claudeUsage.title')}
                    className="absolute right-0 top-full z-30 mt-1 w-64 space-y-3 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 text-xs text-[var(--app-fg)] shadow-lg"
                >
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium">{t('claudeUsage.title')}</span>
                        {usage?.subscriptionType ? (
                            <span className="capitalize text-[var(--app-hint)]">{usage.subscriptionType}</span>
                        ) : null}
                    </div>

                    {presentation && presentation.rows.length > 0 ? (
                        <div className="space-y-2.5">
                            {presentation.rows.map((row) => <UsageRow key={row.key} row={row} now={now} />)}
                        </div>
                    ) : (
                        <div className="text-[var(--app-hint)]">{t('claudeUsage.empty')}</div>
                    )}

                    {errorKey ? (
                        <div className="text-[var(--app-badge-warning-text)]" role="status">{t(errorKey)}</div>
                    ) : null}

                    <div className="flex items-center justify-between gap-2 border-t border-[var(--app-border)] pt-2 text-[var(--app-hint)]">
                        <span title={usage ? formatAbsoluteDateTime(usage.fetchedAt) ?? undefined : undefined}>
                            {usage ? t('claudeUsage.updated', { time: formatRelativeTime(usage.fetchedAt, t) ?? '' }) : null}
                        </span>
                        {canRefresh ? (
                            <button
                                type="button"
                                onClick={() => void refresh()}
                                disabled={refreshing}
                                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-60"
                            >
                                {refreshing ? (
                                    <span aria-hidden="true" className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-r-transparent" />
                                ) : null}
                                {refreshing ? t('claudeUsage.refreshing') : t('claudeUsage.refresh')}
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </span>
    )
}
