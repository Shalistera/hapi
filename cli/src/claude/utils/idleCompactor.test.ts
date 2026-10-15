import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@/claude/sdk'
import { IdleCompactor, resolveIdleCompactionConfig, type IdleCompactionConfig } from './idleCompactor'

const NOW = Date.parse('2026-10-15T10:00:00Z')
const MINUTE = 60_000

function assistant(opts: {
    id?: string
    contextTokens: number
    ttl?: '1h' | '5m' | null
    parentToolUseId?: string
}): SDKMessage {
    const creation = 1_000
    return {
        type: 'assistant',
        parent_tool_use_id: opts.parentToolUseId ?? null,
        message: {
            id: opts.id ?? 'msg_1',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
                input_tokens: 2,
                cache_read_input_tokens: opts.contextTokens - creation - 2,
                cache_creation_input_tokens: creation,
                cache_creation: opts.ttl === null
                    ? undefined
                    : {
                        ephemeral_1h_input_tokens: (opts.ttl ?? '1h') === '1h' ? creation : 0,
                        ephemeral_5m_input_tokens: opts.ttl === '5m' ? creation : 0
                    }
            }
        }
    }
}

const result: SDKMessage = { type: 'result', subtype: 'success', is_error: false }

function setup(config: Partial<IdleCompactionConfig> = {}, canCompact = () => true) {
    const compact = vi.fn()
    const notify = vi.fn()
    const compactor = new IdleCompactor({
        getConfig: () => ({ enabled: true, minTokens: 200_000, ...config }),
        canCompact,
        compact,
        notify
    })
    return { compactor, compact, notify }
}

describe('IdleCompactor', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('compacts a long idle conversation at 90% of the one-hour cache lifetime', () => {
        const { compactor, compact, notify } = setup()
        compactor.onMessage(assistant({ contextTokens: 250_000 }))
        vi.advanceTimersByTime(2 * MINUTE)
        compactor.onMessage(result)

        vi.advanceTimersByTime(52 * MINUTE - 1)
        expect(compact).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(compact).toHaveBeenCalledTimes(1)
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('250k tokens'))
    })

    it('times the cache from the first message of the last response', () => {
        const { compactor, compact } = setup()
        compactor.onMessage(assistant({ id: 'msg_2', contextTokens: 250_000 }))
        vi.advanceTimersByTime(5 * MINUTE)
        // Later blocks of the same response do not move the cache clock.
        compactor.onMessage(assistant({ id: 'msg_2', contextTokens: 250_000 }))
        compactor.onMessage(result)

        vi.advanceTimersByTime(49 * MINUTE)
        expect(compact).toHaveBeenCalledTimes(1)
    })

    it('leaves small conversations alone', () => {
        const { compactor, compact } = setup()
        compactor.onMessage(assistant({ contextTokens: 150_000 }))
        compactor.onMessage(result)
        vi.advanceTimersByTime(2 * 60 * MINUTE)
        expect(compact).not.toHaveBeenCalled()
    })

    it('honours a lower minimum', () => {
        const { compactor, compact } = setup({ minTokens: 100_000 })
        compactor.onMessage(assistant({ contextTokens: 150_000 }))
        compactor.onMessage(result)
        vi.advanceTimersByTime(54 * MINUTE)
        expect(compact).toHaveBeenCalledTimes(1)
    })

    it('does not compact conversations cached with the five-minute TTL', () => {
        const { compactor, compact } = setup()
        compactor.onMessage(assistant({ contextTokens: 250_000, ttl: '5m' }))
        compactor.onMessage(result)
        vi.advanceTimersByTime(2 * 60 * MINUTE)
        expect(compact).not.toHaveBeenCalled()
    })

    it('does not compact when the cache TTL is unknown', () => {
        const { compactor, compact } = setup()
        compactor.onMessage(assistant({ contextTokens: 250_000, ttl: null }))
        compactor.onMessage(result)
        vi.advanceTimersByTime(2 * 60 * MINUTE)
        expect(compact).not.toHaveBeenCalled()
    })

    it('uses the main thread context, not a subagent one', () => {
        const { compactor, compact } = setup()
        compactor.onMessage(assistant({ contextTokens: 50_000 }))
        compactor.onMessage(assistant({ id: 'msg_sub', contextTokens: 300_000, parentToolUseId: 'toolu_1' }))
        compactor.onMessage(result)
        vi.advanceTimersByTime(2 * 60 * MINUTE)
        expect(compact).not.toHaveBeenCalled()
    })

    it('is cancelled by new activity and re-armed by the next result', () => {
        const { compactor, compact } = setup()
        compactor.onMessage(assistant({ contextTokens: 250_000 }))
        compactor.onMessage(result)
        vi.advanceTimersByTime(30 * MINUTE)
        compactor.onMessage(assistant({ id: 'msg_3', contextTokens: 260_000 }))
        vi.advanceTimersByTime(30 * MINUTE)
        expect(compact).not.toHaveBeenCalled()

        compactor.onMessage(result)
        vi.advanceTimersByTime(54 * MINUTE)
        expect(compact).toHaveBeenCalledTimes(1)
    })

    it('is cancelled by user input', () => {
        const { compactor, compact } = setup()
        compactor.onMessage(assistant({ contextTokens: 250_000 }))
        compactor.onMessage(result)
        compactor.cancel()
        vi.advanceTimersByTime(2 * 60 * MINUTE)
        expect(compact).not.toHaveBeenCalled()
    })

    it('does not compact again right after a compaction', () => {
        const { compactor, compact } = setup()
        compactor.onMessage(assistant({ contextTokens: 250_000 }))
        compactor.onMessage({
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: { trigger: 'manual', pre_tokens: 250_000, post_tokens: 12_000 }
        })
        compactor.onMessage(result)
        vi.advanceTimersByTime(2 * 60 * MINUTE)
        expect(compact).not.toHaveBeenCalled()
    })

    it('skips the compaction while the session is busy or limited', () => {
        const { compactor, compact } = setup({}, () => false)
        compactor.onMessage(assistant({ contextTokens: 250_000 }))
        compactor.onMessage(result)
        vi.advanceTimersByTime(54 * MINUTE)
        expect(compact).not.toHaveBeenCalled()
    })

    it('rechecks the setting when the timer fires', () => {
        let enabled = true
        const compact = vi.fn()
        const compactor = new IdleCompactor({
            getConfig: () => ({ enabled, minTokens: 200_000 }),
            canCompact: () => true,
            compact,
            notify: vi.fn()
        })
        compactor.onMessage(assistant({ contextTokens: 250_000 }))
        compactor.onMessage(result)
        enabled = false
        vi.advanceTimersByTime(54 * MINUTE)
        expect(compact).not.toHaveBeenCalled()
    })
})

describe('resolveIdleCompactionConfig', () => {
    const noSettings = () => undefined

    it('is on by default with a 200k minimum', () => {
        expect(resolveIdleCompactionConfig({ env: {}, readSetting: noSettings }))
            .toEqual({ enabled: true, minTokens: 200_000 })
    })

    it('is off when idleCompaction or autoCompactEnabled is false', () => {
        expect(resolveIdleCompactionConfig({
            env: {},
            readSetting: (key) => key === 'idleCompaction' ? false : undefined
        }).enabled).toBe(false)
        expect(resolveIdleCompactionConfig({
            env: {},
            readSetting: (key) => key === 'autoCompactEnabled' ? false : undefined
        }).enabled).toBe(false)
    })

    it('is off when compaction is disabled by environment', () => {
        expect(resolveIdleCompactionConfig({ env: { DISABLE_COMPACT: '1' }, readSetting: noSettings }).enabled).toBe(false)
        expect(resolveIdleCompactionConfig({ env: { DISABLE_AUTO_COMPACT: 'true' }, readSetting: noSettings }).enabled).toBe(false)
        expect(resolveIdleCompactionConfig({ env: { DISABLE_AUTO_COMPACT: '0' }, readSetting: noSettings }).enabled).toBe(true)
    })

    it('reads CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS with a 100k floor', () => {
        expect(resolveIdleCompactionConfig({
            env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '150000' },
            readSetting: noSettings
        }).minTokens).toBe(150_000)
        expect(resolveIdleCompactionConfig({
            env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '5000' },
            readSetting: noSettings
        }).minTokens).toBe(100_000)
        expect(resolveIdleCompactionConfig({
            env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: 'lots' },
            readSetting: noSettings
        }).minTokens).toBe(200_000)
    })
})
