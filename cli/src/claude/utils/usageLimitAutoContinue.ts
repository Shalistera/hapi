import type { SDKMessage } from '@/claude/sdk'
import { logger } from '@/ui/logger'

/** The prompt Claude Code itself sends when it continues after a usage-limit reset. */
export const USAGE_LIMIT_CONTINUE_PROMPT = 'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.'

/** Wait this long past the reported reset before continuing. */
const DEFAULT_RESUME_DELAY_MS = 60_000
/** Limits that reset later than this (weekly caps) are not waited for. */
const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60 * 1000
/** Automatic continues in a row that hit the limit again before giving up. */
const MAX_CONSECUTIVE_CONTINUES = 3

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null
}

/** `rate_limit_info.resetsAt` is unix epoch seconds. */
function resetsAtMs(info: unknown): number | null {
    const resetsAt = asRecord(info)?.resetsAt
    return typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0
        ? resetsAt * 1000
        : null
}

function isMainThread(message: SDKMessage): boolean {
    return message.parent_tool_use_id === undefined || message.parent_tool_use_id === null
}

/** "in 2h 13m (at 15:02 JST)": relative first, since the CLI's time zone may not be the reader's. */
export function formatResumeTime(atMs: number, nowMs: number): string {
    const totalMinutes = Math.max(1, Math.round((atMs - nowMs) / 60_000))
    const days = Math.floor(totalMinutes / (24 * 60))
    const hours = Math.floor(totalMinutes / 60) % 24
    const minutes = totalMinutes % 60
    const relative = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
    const at = new Date(atMs).toLocaleString([], {
        ...(days > 0 ? { month: 'short', day: 'numeric' } : {}),
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
    })
    return `in ${relative} (at ${at})`
}

/**
 * Continues a remote Claude turn that a claude.ai usage limit stopped, once the
 * limit resets (Claude Code's `autoContinueAtUsageLimit`, which the SDK mode
 * HAPI uses does not do on its own).
 *
 * A main-thread assistant message with `api_error: usage_limit_reached` marks
 * the turn; when its `result` arrives the continue is armed for the reported
 * reset. Any later Claude activity or user input cancels it.
 */
export class UsageLimitAutoContinue {
    private limitThisTurn: { resetsAtMs: number | null } | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private consecutiveContinues = 0
    private idle = false
    private readonly now: () => number
    private readonly resumeDelayMs: number
    private readonly maxWaitMs: number

    constructor(private readonly opts: {
        isEnabled: () => boolean
        /** False while input is queued or the launcher is shutting down. */
        canContinue: () => boolean
        continueTask: (prompt: string) => void
        notify: (message: string) => void
        now?: () => number
        resumeDelayMs?: number
        maxWaitMs?: number
    }) {
        this.now = opts.now ?? Date.now
        this.resumeDelayMs = opts.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS
        this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    }

    isArmed(): boolean {
        return this.timer !== null
    }

    /** True from a turn that hit the limit until Claude answers normally again. */
    isLimited(): boolean {
        return this.limitThisTurn !== null || this.timer !== null || this.consecutiveContinues > 0
    }

    onMessage(message: SDKMessage): void {
        if (message.type === 'result') {
            this.idle = true
            this.onTurnEnd()
            return
        }
        if (message.type !== 'assistant' && message.type !== 'user') {
            return
        }
        this.idle = false
        this.clearTimer()
        if (message.type !== 'assistant' || !isMainThread(message)) {
            return
        }
        if (message.api_error === 'usage_limit_reached') {
            const params = asRecord(message.api_error_params)
            this.limitThisTurn = { resetsAtMs: resetsAtMs(params?.rate_limit_info) }
        } else if (message.is_api_error_message !== true) {
            // Claude answered: the limit no longer blocks this session.
            this.consecutiveContinues = 0
        }
    }

    /** The user sent something; their input replaces the automatic continue. */
    onUserInput(): void {
        if (this.timer === null) return
        this.clearTimer()
        this.consecutiveContinues = 0
        this.opts.notify('Automatic continue cancelled: your message was sent instead.')
    }

    /** The user stopped the session. */
    cancel(): void {
        this.clearTimer()
        this.consecutiveContinues = 0
    }

    dispose(): void {
        this.clearTimer()
    }

    private onTurnEnd(): void {
        const limit = this.limitThisTurn
        this.limitThisTurn = null
        if (!limit || !this.opts.isEnabled()) return

        const now = this.now()
        if (limit.resetsAtMs === null) {
            this.opts.notify('Usage limit reached. Claude did not report when it resets, so HAPI will not continue automatically.')
            return
        }
        const resumeAt = Math.max(limit.resetsAtMs, now) + this.resumeDelayMs
        if (resumeAt - now > this.maxWaitMs) {
            this.opts.notify(`Usage limit reached. It resets ${formatResumeTime(limit.resetsAtMs, now)}, too far out to continue automatically.`)
            return
        }
        if (this.consecutiveContinues >= MAX_CONSECUTIVE_CONTINUES) {
            this.consecutiveContinues = 0
            this.opts.notify(`Usage limit still reached after ${MAX_CONSECUTIVE_CONTINUES} automatic continues; stopped waiting. Send a message to continue.`)
            return
        }

        this.clearTimer()
        this.timer = setTimeout(() => this.fire(), resumeAt - now)
        logger.debug(`[usageLimitAutoContinue] armed for ${new Date(resumeAt).toISOString()}`)
        this.opts.notify(`Usage limit reached. HAPI will continue this task automatically ${formatResumeTime(resumeAt, now)}. Sending a message cancels this.`)
    }

    private fire(): void {
        this.timer = null
        if (!this.idle || !this.opts.isEnabled() || !this.opts.canContinue()) {
            logger.debug('[usageLimitAutoContinue] not continuing: session busy or setting turned off')
            return
        }
        this.consecutiveContinues += 1
        this.idle = false
        this.opts.notify('Usage limit has reset. Continuing the task.')
        this.opts.continueTask(USAGE_LIMIT_CONTINUE_PROMPT)
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }
}
