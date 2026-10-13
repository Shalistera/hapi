import type { ClaudeUsage, RefreshClaudeUsageResponse } from '@hapi/protocol/types'
import { logger } from '@/ui/logger'
import type { SDKMessage } from '@/claude/sdk'
import { parseClaudeUsageResponse } from './claudeUsage'

const DEFAULT_MIN_INTERVAL_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000
/** Automatic reads stop after this many failures in a row (e.g. a Claude Code without get_usage). */
const MAX_CONSECUTIVE_FAILURES = 3

/** Sends `get_usage` to the running Claude process. */
export type ClaudeUsageReader = (timeoutMs: number) => Promise<unknown>


/**
 * Keeps the hub's Claude plan usage current while a Claude process runs.
 *
 * Reads when the process starts, when Claude reports that a rate-limit window
 * moved (`rate_limit_event`) and after each result. Automatic reads are at
 * least `minIntervalMs` apart; nothing is read while no Claude process runs.
 */
export class ClaudeUsageMonitor {
    private reader: ClaudeUsageReader | null = null
    private inFlight: Promise<RefreshClaudeUsageResponse> | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private readAgain = false
    private lastReadAt: number | null = null
    private failures = 0
    private unavailable = false
    private readonly minIntervalMs: number
    private readonly timeoutMs: number
    private readonly now: () => number

    constructor(private readonly opts: {
        report: (usage: ClaudeUsage) => void
        minIntervalMs?: number
        timeoutMs?: number
        now?: () => number
    }) {
        this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
        this.now = opts.now ?? Date.now
    }

    /** Called with a reader when a Claude process starts, and with null once it is gone. */
    setReader(reader: ClaudeUsageReader | null): void {
        this.reader = reader
        this.clearTimer()
        if (reader) {
            // A new process (other version or login) gets a fresh start.
            this.failures = 0
            this.unavailable = false
            this.schedule()
        }
    }

    onMessage(message: SDKMessage): void {
        if (message.type === 'rate_limit_event' || message.type === 'result') {
            this.schedule()
        }
    }

    /** Reads now, without the automatic spacing (the user asked for it). */
    refresh(): Promise<RefreshClaudeUsageResponse> {
        this.clearTimer()
        return this.read()
    }

    dispose(): void {
        this.reader = null
        this.clearTimer()
    }

    private schedule(): void {
        if (!this.reader || this.unavailable || this.failures >= MAX_CONSECUTIVE_FAILURES || this.timer) {
            return
        }
        if (this.inFlight) {
            // The read in flight may predate what triggered this one.
            this.readAgain = true
            return
        }
        const wait = this.lastReadAt === null
            ? 0
            : Math.max(0, this.lastReadAt + this.minIntervalMs - this.now())
        this.timer = setTimeout(() => {
            this.timer = null
            void this.read()
        }, wait)
    }

    private read(): Promise<RefreshClaudeUsageResponse> {
        if (this.inFlight) {
            return this.inFlight
        }
        const reader = this.reader
        if (!reader) {
            return Promise.resolve({ status: 'not-running' })
        }

        this.lastReadAt = this.now()
        const read = (async (): Promise<RefreshClaudeUsageResponse> => {
            try {
                const result = parseClaudeUsageResponse(await reader(this.timeoutMs), this.now())
                if (result.status === 'invalid') {
                    this.failures += 1
                    logger.debug('[claudeUsage] get_usage reply has no plan limits')
                    return { status: 'failed' }
                }
                this.failures = 0
                this.unavailable = result.status === 'unavailable'
                if (result.status === 'ok') {
                    this.opts.report(result.usage)
                }
                return result
            } catch (error) {
                this.failures += 1
                logger.debug('[claudeUsage] get_usage failed', error)
                return { status: 'failed' }
            }
        })()
        this.inFlight = read
        void read.finally(() => {
            this.inFlight = null
            if (this.readAgain) {
                this.readAgain = false
                this.schedule()
            }
        })
        return read
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }
}
