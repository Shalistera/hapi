import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SDKMessage } from '@/claude/sdk'
import { ClaudeUsageMonitor } from './claudeUsageMonitor'

const reply = (percent: number) => ({
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
        limits: [{ kind: 'session', percent, severity: 'normal', resets_at: null, scope: null }]
    }
})

const rateLimitEvent = { type: 'rate_limit_event' } as SDKMessage
const resultMessage = { type: 'result' } as SDKMessage

type ReaderMock = Mock<(timeoutMs: number) => Promise<unknown>>

function setup(reader: ReaderMock = vi.fn(async (_timeoutMs: number): Promise<unknown> => reply(10))) {
    const report = vi.fn()
    const monitor = new ClaudeUsageMonitor({ report, minIntervalMs: 60_000, timeoutMs: 5_000 })
    return { monitor, report, reader }
}

describe('ClaudeUsageMonitor', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(1_000_000)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('reads as soon as a Claude process starts and reports the snapshot', async () => {
        const { monitor, report, reader } = setup()

        monitor.setReader(reader)
        await vi.advanceTimersByTimeAsync(0)

        expect(reader).toHaveBeenCalledWith(5_000)
        expect(report).toHaveBeenCalledWith({
            fetchedAt: 1_000_000,
            subscriptionType: 'max',
            limits: [{ kind: 'session', scope: null, percent: 10, resetsAt: null, severity: 'normal' }]
        })
    })

    it('spaces automatic reads triggered by rate-limit events and results', async () => {
        const { monitor, reader } = setup()
        monitor.setReader(reader)
        await vi.advanceTimersByTimeAsync(0)

        monitor.onMessage(rateLimitEvent)
        monitor.onMessage(resultMessage)
        monitor.onMessage({ type: 'assistant' } as SDKMessage)
        await vi.advanceTimersByTimeAsync(59_999)
        expect(reader).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(1)
        expect(reader).toHaveBeenCalledTimes(2)
    })

    it('reads again after an in-flight read when a trigger arrives meanwhile', async () => {
        let resolveRead: (value: unknown) => void = () => {}
        const reader = vi.fn((_timeoutMs: number) => new Promise<unknown>((resolve) => { resolveRead = resolve }))
        const { monitor, report } = setup(reader)
        monitor.setReader(reader)
        await vi.advanceTimersByTimeAsync(0)

        monitor.onMessage(rateLimitEvent)
        resolveRead(reply(10))
        await vi.advanceTimersByTimeAsync(0)
        expect(report).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(60_000)
        expect(reader).toHaveBeenCalledTimes(2)
    })

    it('refreshes on request without waiting for the spacing', async () => {
        const { monitor, reader } = setup()
        monitor.setReader(reader)
        await vi.advanceTimersByTimeAsync(0)

        const result = await monitor.refresh()

        expect(reader).toHaveBeenCalledTimes(2)
        expect(result).toMatchObject({ status: 'ok' })
    })

    it('answers not-running without a Claude process and stops reading once it exits', async () => {
        const { monitor, reader } = setup()

        await expect(monitor.refresh()).resolves.toEqual({ status: 'not-running' })

        monitor.setReader(reader)
        await vi.advanceTimersByTimeAsync(0)
        monitor.onMessage(resultMessage)
        monitor.setReader(null)
        await vi.advanceTimersByTimeAsync(120_000)
        expect(reader).toHaveBeenCalledTimes(1)
    })

    it('stops automatic reads for logins without plan limits', async () => {
        const reader = vi.fn(async (_timeoutMs: number): Promise<unknown> => ({ rate_limits_available: false, rate_limits: null }))
        const { monitor, report } = setup(reader)
        monitor.setReader(reader)
        await vi.advanceTimersByTimeAsync(0)

        monitor.onMessage(resultMessage)
        await vi.advanceTimersByTimeAsync(120_000)

        expect(reader).toHaveBeenCalledTimes(1)
        expect(report).not.toHaveBeenCalled()
        await expect(monitor.refresh()).resolves.toEqual({ status: 'unavailable' })
    })

    it('gives up automatic reads after repeated failures', async () => {
        const reader = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
            throw new Error('Unsupported control request subtype: get_usage')
        })
        const { monitor } = setup(reader)
        monitor.setReader(reader)

        for (let i = 0; i < 5; i += 1) {
            await vi.advanceTimersByTimeAsync(60_000)
            monitor.onMessage(resultMessage)
        }
        await vi.advanceTimersByTimeAsync(60_000)

        expect(reader).toHaveBeenCalledTimes(3)
        await expect(monitor.refresh()).resolves.toEqual({ status: 'failed' })

        // A new Claude process is tried again.
        const nextReader = vi.fn(async (_timeoutMs: number): Promise<unknown> => reply(20))
        monitor.setReader(nextReader)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(nextReader).toHaveBeenCalledTimes(1)
    })
})
