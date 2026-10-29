import type { SDKMessage } from '@/claude/sdk'
import { logger } from '@/ui/logger'

/** Claude Code's defaults for idle compaction (CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS). */
const DEFAULT_MIN_TOKENS = 200_000
const MIN_TOKENS_FLOOR = 100_000
const CACHE_TTL_MS = 60 * 60 * 1000
/** Compact at this fraction of the cache lifetime, as Claude Code does. */
const FIRE_AT_FRACTION = 0.9

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null
}

function tokenCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function isTruthyEnv(value: string | undefined): boolean {
    if (value === undefined) return false
    const normalized = value.trim().toLowerCase()
    return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

export type IdleCompactionConfig = {
    enabled: boolean
    minTokens: number
}

/**
 * Resolves idle compaction from Claude Code's own switches: the
 * `idleCompaction` and `autoCompactEnabled` settings, DISABLE_COMPACT /
 * DISABLE_AUTO_COMPACT and CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS.
 */
export function resolveIdleCompactionConfig(opts: {
    env: Record<string, string | undefined>
    readSetting: (key: string) => boolean | undefined
}): IdleCompactionConfig {
    const rawMin = opts.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS?.trim()
    const parsedMin = rawMin ? Number(rawMin) : NaN
    const minTokens = Number.isFinite(parsedMin)
        ? Math.max(MIN_TOKENS_FLOOR, parsedMin)
        : DEFAULT_MIN_TOKENS
    const enabled = !isTruthyEnv(opts.env.DISABLE_COMPACT)
        && !isTruthyEnv(opts.env.DISABLE_AUTO_COMPACT)
        && opts.readSetting('autoCompactEnabled') !== false
        && opts.readSetting('idleCompaction') !== false
    return { enabled, minTokens }
}

/**
 * Compacts a long remote Claude conversation that has sat idle for most of
 * its one-hour prompt-cache lifetime, so coming back to it only reprocesses
 * the summary (Claude Code's idle compaction, which the SDK mode HAPI uses
 * does not run on its own).
 *
 * Tracks the main thread's context size and cache TTL from assistant usage,
 * arms when a turn's `result` arrives, and is cancelled by any later activity.
 * Only conversations cached with the one-hour TTL are compacted: with the
 * five-minute TTL the cache is long gone and compacting saves nothing.
 */
export class IdleCompactor {
    private contextTokens = 0
    private cacheTtl: '1h' | '5m' | null = null
    private lastRequestAt: number | null = null
    private lastMessageId: string | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private readonly now: () => number

    constructor(private readonly opts: {
        getConfig: () => IdleCompactionConfig
        /** False while input is queued, a usage limit blocks the session, or the launcher is shutting down. */
        canCompact: () => boolean
        compact: () => void
        notify: (message: string) => void
        now?: () => number
    }) {
        this.now = opts.now ?? Date.now
    }

    onMessage(message: SDKMessage): void {
        if (message.type === 'result') {
            this.arm()
            return
        }
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
            // Compacted (by hand, automatically, or by us): the context Claude
            // carries now is the summary, until the next request reports it.
            const metadata = asRecord(message.compact_metadata)
            this.contextTokens = tokenCount(metadata?.post_tokens)
            this.lastRequestAt = null
            return
        }
        if (message.type !== 'assistant' && message.type !== 'user') {
            return
        }
        this.clearTimer()
        const isMainThread = message.parent_tool_use_id === undefined || message.parent_tool_use_id === null
        if (message.type === 'assistant' && isMainThread) {
            this.recordUsage(asRecord(message.message))
        }
    }

    /** User input or a stop: the session is not idle. */
    cancel(): void {
        this.clearTimer()
    }

    dispose(): void {
        this.clearTimer()
    }

    private recordUsage(message: RecordValue | null): void {
        const usage = asRecord(message?.usage)
        if (!message || !usage) return

        // One response streams as several assistant messages sharing an id;
        // its request (which refreshed the cache) started at the first one.
        const id = typeof message.id === 'string' ? message.id : null
        if (id === null || id !== this.lastMessageId) {
            this.lastMessageId = id
            this.lastRequestAt = this.now()
        }

        this.contextTokens = tokenCount(usage.input_tokens)
            + tokenCount(usage.cache_read_input_tokens)
            + tokenCount(usage.cache_creation_input_tokens)
        const creation = asRecord(usage.cache_creation)
        if (tokenCount(creation?.ephemeral_1h_input_tokens) > 0) {
            this.cacheTtl = '1h'
        } else if (tokenCount(creation?.ephemeral_5m_input_tokens) > 0) {
            this.cacheTtl = '5m'
        }
    }

    private arm(): void {
        this.clearTimer()
        const config = this.opts.getConfig()
        if (!config.enabled || this.cacheTtl !== '1h' || this.lastRequestAt === null) return
        if (this.contextTokens < config.minTokens) return

        const fireAt = this.lastRequestAt + CACHE_TTL_MS * FIRE_AT_FRACTION
        if (fireAt <= this.now()) return
        this.timer = setTimeout(() => this.fire(), Math.max(0, fireAt - this.now()))
        logger.debug(`[idleCompactor] armed for ${new Date(fireAt).toISOString()} (${this.contextTokens} context tokens)`)
    }

    private fire(): void {
        this.timer = null
        const config = this.opts.getConfig()
        if (!config.enabled || this.contextTokens < config.minTokens || !this.opts.canCompact()) {
            logger.debug('[idleCompactor] not compacting: setting off, context small, or session busy')
            return
        }
        const tokens = Math.round(this.contextTokens / 1000)
        // Do not compact the same context twice if the compaction is lost.
        this.contextTokens = 0
        this.opts.notify(`Idle for about an hour with ${tokens}k tokens of context: compacting before the prompt cache expires. Claude continues from a summary. Set "idleCompaction": false in Claude settings to turn this off.`)
        this.opts.compact()
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }
}
