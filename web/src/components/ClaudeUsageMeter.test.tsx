import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ClaudeUsage, MachinesResponse } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { queryKeys } from '@/lib/query-keys'
import { ClaudeUsageMeter } from './ClaudeUsageMeter'

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

function usage(fetchedAt: number, sessionPercent = 15): ClaudeUsage {
    return {
        fetchedAt,
        subscriptionType: 'max',
        limits: [
            { kind: 'session', scope: null, percent: sessionPercent, resetsAt: fetchedAt + 2 * 3_600_000, severity: 'normal' },
            { kind: 'weekly_all', scope: null, percent: 60, resetsAt: fetchedAt + 30 * 3_600_000, severity: 'normal' },
            { kind: 'weekly_scoped', scope: 'Fable', percent: 12, resetsAt: fetchedAt + 30 * 3_600_000, severity: 'normal' }
        ]
    }
}

function renderMeter(props: { usage: ClaudeUsage | null; api: ApiClient | null; sessionActive?: boolean }, queryClient = new QueryClient()) {
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ClaudeUsageMeter
                    sessionId="session-1"
                    sessionActive={props.sessionActive ?? true}
                    machineId="machine-1"
                    usage={props.usage}
                    api={props.api}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('ClaudeUsageMeter', () => {
    it('shows the 5-hour and weekly usage and opens the full breakdown', () => {
        const api = { refreshClaudeUsage: vi.fn() } as unknown as ApiClient
        renderMeter({ usage: usage(Date.now()), api })

        const meter = screen.getByTestId('claude-usage-meter')
        expect(meter).toHaveTextContent('5h')
        expect(meter).toHaveTextContent('15%')
        expect(meter).toHaveTextContent('7d')
        expect(meter).toHaveTextContent('60%')

        fireEvent.click(meter)
        const panel = screen.getByRole('dialog', { name: 'Claude plan usage' })
        expect(within(panel).getAllByTestId('claude-usage-row')).toHaveLength(3)
        expect(within(panel).getByText('Weekly (Fable)')).toBeInTheDocument()
        expect(within(panel).getByText('Resets in 2h 0m')).toBeInTheDocument()
        // A fresh snapshot is not re-read just because the panel opened.
        expect(api.refreshClaudeUsage).not.toHaveBeenCalled()
    })

    it('re-reads a stale snapshot when opened and applies it to the machine cache', async () => {
        const fresh = usage(Date.now(), 22)
        const api = { refreshClaudeUsage: vi.fn().mockResolvedValue({ status: 'ok', usage: fresh }) } as unknown as ApiClient
        const queryClient = new QueryClient()
        queryClient.setQueryData<MachinesResponse>(queryKeys.machines, {
            machines: [{ id: 'machine-1', claudeUsage: usage(Date.now() - 10 * 60_000) } as MachinesResponse['machines'][number]]
        })
        renderMeter({ usage: usage(Date.now() - 10 * 60_000), api }, queryClient)

        fireEvent.click(screen.getByTestId('claude-usage-meter'))

        await waitFor(() => expect(api.refreshClaudeUsage).toHaveBeenCalledWith('session-1'))
        await waitFor(() => {
            expect(queryClient.getQueryData<MachinesResponse>(queryKeys.machines)?.machines[0]?.claudeUsage).toEqual(fresh)
        })
    })

    it('explains why a refresh could not read usage', async () => {
        const api = { refreshClaudeUsage: vi.fn().mockResolvedValue({ status: 'not-running' }) } as unknown as ApiClient
        renderMeter({ usage: null, api })

        expect(screen.getByTestId('claude-usage-meter')).toHaveTextContent('—')
        fireEvent.click(screen.getByTestId('claude-usage-meter'))

        expect(await screen.findByRole('status')).toHaveTextContent('Claude is not running in this session')
        expect(screen.getByText('No usage reported yet. It updates while Claude works.')).toBeInTheDocument()
    })

    it('does not offer a refresh for an inactive session', () => {
        const api = { refreshClaudeUsage: vi.fn() } as unknown as ApiClient
        renderMeter({ usage: usage(Date.now() - 10 * 60_000), api, sessionActive: false })

        fireEvent.click(screen.getByTestId('claude-usage-meter'))

        expect(api.refreshClaudeUsage).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
    })

    it('flags a meter outside the header that is running out', () => {
        const snapshot = usage(Date.now())
        snapshot.limits[2] = { ...snapshot.limits[2]!, percent: 95, severity: 'critical' }
        renderMeter({ usage: snapshot, api: null })

        expect(screen.getByTestId('claude-usage-attention')).toBeInTheDocument()
    })
})
