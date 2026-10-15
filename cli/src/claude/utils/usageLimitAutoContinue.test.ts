import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@/claude/sdk'
import { USAGE_LIMIT_CONTINUE_PROMPT, UsageLimitAutoContinue, formatResumeTime } from './usageLimitAutoContinue'

const NOW = Date.parse('2026-10-15T10:00:00Z')
const MINUTE = 60_000

function limitMessage(resetsAtMs: number | null, extra: Record<string, unknown> = {}): SDKMessage {
    return {
        type: 'assistant',
        parent_tool_use_id: null,
        is_api_error_message: true,
        api_error: 'usage_limit_reached',
        api_error_params: resetsAtMs === null
            ? {}
            : { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetsAtMs / 1000 } },
        message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }] },
        ...extra
    }
}

const answer: SDKMessage = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
}
const result: SDKMessage = { type: 'result', subtype: 'success', is_error: true }

function setup(overrides: Partial<ConstructorParameters<typeof UsageLimitAutoContinue>[0]> = {}) {
    const continueTask = vi.fn()
    const notify = vi.fn()
    const autoContinue = new UsageLimitAutoContinue({
        isEnabled: () => true,
        canContinue: () => true,
        continueTask,
        notify,
        ...overrides
    })
    return { autoContinue, continueTask, notify }
}

describe('UsageLimitAutoContinue', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('continues the task a minute after the limit resets', () => {
        const { autoContinue, continueTask, notify } = setup()
        autoContinue.onMessage(limitMessage(NOW + 90 * MINUTE))
        autoContinue.onMessage(result)

        expect(autoContinue.isArmed()).toBe(true)
        expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('continue this task automatically'))

        vi.advanceTimersByTime(91 * MINUTE - 1)
        expect(continueTask).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(continueTask).toHaveBeenCalledWith(USAGE_LIMIT_CONTINUE_PROMPT)
        expect(notify).toHaveBeenLastCalledWith('Usage limit has reset. Continuing the task.')
    })

    it('ignores a limit hit inside a subagent', () => {
        const { autoContinue } = setup()
        autoContinue.onMessage(limitMessage(NOW + 10 * MINUTE, { parent_tool_use_id: 'toolu_1' }))
        autoContinue.onMessage(result)
        expect(autoContinue.isArmed()).toBe(false)
    })

    it('does nothing when autoContinueAtUsageLimit is off', () => {
        const { autoContinue, notify } = setup({ isEnabled: () => false })
        autoContinue.onMessage(limitMessage(NOW + 10 * MINUTE))
        autoContinue.onMessage(result)
        expect(autoContinue.isArmed()).toBe(false)
        expect(notify).not.toHaveBeenCalled()
    })

    it('does not wait for a limit that resets days later', () => {
        const { autoContinue, notify } = setup()
        autoContinue.onMessage(limitMessage(NOW + 3 * 24 * 60 * MINUTE))
        autoContinue.onMessage(result)
        expect(autoContinue.isArmed()).toBe(false)
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('too far out'))
    })

    it('does not arm without a reset time', () => {
        const { autoContinue, notify } = setup()
        autoContinue.onMessage(limitMessage(null))
        autoContinue.onMessage(result)
        expect(autoContinue.isArmed()).toBe(false)
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('did not report when it resets'))
    })

    it('is cancelled by user input', () => {
        const { autoContinue, continueTask, notify } = setup()
        autoContinue.onMessage(limitMessage(NOW + 10 * MINUTE))
        autoContinue.onMessage(result)
        autoContinue.onUserInput()

        expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('cancelled'))
        vi.advanceTimersByTime(60 * MINUTE)
        expect(continueTask).not.toHaveBeenCalled()
    })

    it('is cancelled when Claude starts working on its own', () => {
        const { autoContinue, continueTask } = setup()
        autoContinue.onMessage(limitMessage(NOW + 10 * MINUTE))
        autoContinue.onMessage(result)
        autoContinue.onMessage(answer)

        vi.advanceTimersByTime(60 * MINUTE)
        expect(continueTask).not.toHaveBeenCalled()
    })

    it('skips the continue when input is already queued', () => {
        const { autoContinue, continueTask } = setup({ canContinue: () => false })
        autoContinue.onMessage(limitMessage(NOW + 10 * MINUTE))
        autoContinue.onMessage(result)
        vi.advanceTimersByTime(60 * MINUTE)
        expect(continueTask).not.toHaveBeenCalled()
    })

    it('re-arms when the continue hits the limit again, then gives up', () => {
        const { autoContinue, continueTask, notify } = setup()
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            autoContinue.onMessage(limitMessage(Date.now() + 5 * MINUTE))
            autoContinue.onMessage(result)
            vi.advanceTimersByTime(6 * MINUTE)
            expect(continueTask).toHaveBeenCalledTimes(attempt)
        }
        autoContinue.onMessage(limitMessage(Date.now() + 5 * MINUTE))
        autoContinue.onMessage(result)
        expect(autoContinue.isArmed()).toBe(false)
        expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('stopped waiting'))
    })

    it('starts a fresh budget once Claude answers again', () => {
        const { autoContinue, continueTask } = setup()
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            autoContinue.onMessage(limitMessage(Date.now() + 5 * MINUTE))
            autoContinue.onMessage(result)
            vi.advanceTimersByTime(6 * MINUTE)
        }
        autoContinue.onMessage(answer)
        autoContinue.onMessage(result)
        expect(autoContinue.isLimited()).toBe(false)

        autoContinue.onMessage(limitMessage(Date.now() + 5 * MINUTE))
        autoContinue.onMessage(result)
        expect(autoContinue.isArmed()).toBe(true)
        vi.advanceTimersByTime(6 * MINUTE)
        expect(continueTask).toHaveBeenCalledTimes(4)
    })
})

describe('formatResumeTime', () => {
    it('leads with the time left', () => {
        expect(formatResumeTime(NOW + 133 * MINUTE, NOW)).toMatch(/^in 2h 13m \(at .+\)$/)
        expect(formatResumeTime(NOW + 20 * MINUTE, NOW)).toMatch(/^in 20m \(at /)
        expect(formatResumeTime(NOW + 30_000, NOW)).toMatch(/^in 1m \(at /)
        expect(formatResumeTime(NOW + (3 * 24 * 60 + 150) * MINUTE, NOW)).toMatch(/^in 3d 2h \(at /)
    })
})
