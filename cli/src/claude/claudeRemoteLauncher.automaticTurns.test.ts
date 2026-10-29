import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode } from './loop'
import { USAGE_LIMIT_CONTINUE_PROMPT } from './utils/usageLimitAutoContinue'

// Turns HAPI starts on its own while a remote Claude session sits idle: the
// continue after a usage limit resets, and idle compaction. claudeRemote() is
// replaced by a script that plays the SDK messages and pulls the next turn.
type ClaudeRemoteOpts = {
    nextMessage: () => Promise<{ message: string; mode: EnhancedMode } | null>
    onMessage: (message: Record<string, unknown>) => void
    onReady: () => Promise<void>
}

const harness = vi.hoisted(() => ({
    calls: 0,
    delivered: [] as Array<{ message: string; mode: EnhancedMode }>,
    script: null as ((opts: ClaudeRemoteOpts, call: number) => Promise<void>) | null
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: ClaudeRemoteOpts) => {
        harness.calls += 1
        const first = await opts.nextMessage()
        if (!first) return
        harness.delivered.push(first)
        await harness.script?.(opts, harness.calls)
    }
}))

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        setOnPermissionRequest(): void {}
        getResponses(): Map<string, unknown> { return new Map() }
        onMessage(): void {}
        handleToolCall = async () => ({ behavior: 'allow', updatedInput: {} })
        reset(): void {}
        isAborted(): boolean { return false }
        handleModeChange(): void {}
    }
}))

vi.mock('./utils/sdkToLogConverter', () => ({
    SDKToLogConverter: class {
        updateSessionId(): void {}
        resetParentChain(): void {}
        convert(): null { return null }
        convertSidechainUserMessage(): null { return null }
        updateSelectedModel(): void {}
        generateInterruptedToolResult(): null { return null }
    }
}))

vi.mock('./utils/OutgoingMessageQueue', () => ({
    OutgoingMessageQueue: class {
        releaseToolCall(): void {}
        enqueue(): void {}
        async flush(): Promise<void> {}
        destroy(): void {}
    }
}))

import { claudeRemoteLauncher } from './claudeRemoteLauncher'
import { Session } from './session'

const MINUTE = 60_000
const MODE: EnhancedMode = { permissionMode: 'acceptEdits', model: 'opus' }

function createHarness() {
    const rpcHandlers = new Map<string, () => void | Promise<void>>()
    const events: Array<{ type: string; message?: string }> = []
    const client = {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: () => void | Promise<void>) => {
                rpcHandlers.set(method, handler)
            }
        },
        keepAlive: () => {},
        updateMetadata: (mutator: (metadata: any) => any) => { mutator({}) },
        emitMessagesConsumed: () => {},
        sendClaudeSessionMessage: () => {},
        sendSessionEvent: (event: { type: string; message?: string }) => { events.push(event) },
        notePendingHubPromptEcho: () => {},
        discardPendingHubPromptEcho: () => {},
        discardPendingHubPromptEchoText: () => {}
    }
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode))
    const session = new Session({
        api: {} as any,
        client: client as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        sessionId: null,
        claudeEnvVars: {},
        mcpServers: {},
        messageQueue: queue,
        onModeChange: () => {},
        allowedTools: [],
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hook.json',
        permissionMode: MODE.permissionMode,
        model: MODE.model
    })
    const exit = () => { void rpcHandlers.get(RPC_METHODS.Switch)?.() }
    const messages = () => events.flatMap((event) => event.type === 'message' && event.message ? [event.message] : [])
    return { session, queue, exit, messages }
}

function usageLimitHit(resetsAtMs: number): Record<string, unknown> {
    return {
        type: 'assistant',
        parent_tool_use_id: null,
        is_api_error_message: true,
        api_error: 'usage_limit_reached',
        api_error_params: { rate_limit_info: { status: 'rejected', resetsAt: Math.floor(resetsAtMs / 1000) } },
        message: { id: 'msg_limit', role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }] }
    }
}

function longReply(): Record<string, unknown> {
    return {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
            id: 'msg_long',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
                input_tokens: 2,
                cache_read_input_tokens: 240_000,
                cache_creation_input_tokens: 10_000,
                cache_creation: { ephemeral_1h_input_tokens: 10_000, ephemeral_5m_input_tokens: 0 }
            }
        }
    }
}

const result = { type: 'result', subtype: 'success', is_error: false }

describe('claudeRemoteLauncher automatic turns', () => {
    let claudeConfigDir: string
    let previousConfigDir: string | undefined

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(Date.parse('2026-10-15T10:00:00Z'))
        // Keep the real ~/.claude/settings.json out of these tests.
        claudeConfigDir = mkdtempSync(join(tmpdir(), 'hapi-claude-config-'))
        previousConfigDir = process.env.CLAUDE_CONFIG_DIR
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
    })

    afterEach(() => {
        vi.useRealTimers()
        harness.calls = 0
        harness.delivered = []
        harness.script = null
        if (previousConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR
        } else {
            process.env.CLAUDE_CONFIG_DIR = previousConfigDir
        }
        rmSync(claudeConfigDir, { recursive: true, force: true })
    })

    it('continues the task in the same mode once the usage limit resets', async () => {
        const { session, queue, exit, messages } = createHarness()
        const resetsAt = Date.now() + 30 * MINUTE
        harness.script = async (opts, call) => {
            if (call > 1) {
                exit()
                return
            }
            opts.onMessage(usageLimitHit(resetsAt))
            opts.onMessage(result)
            await opts.onReady()
            // A turn in another mode is parked and ends this Claude process;
            // the next launch picks it up.
            const next = await opts.nextMessage()
            if (next) {
                harness.delivered.push(next)
                exit()
            }
        }

        try {
            queue.push('do the task', MODE, 'local-1')
            const launched = claudeRemoteLauncher(session as any)

            await vi.advanceTimersByTimeAsync(30 * MINUTE)
            expect(harness.delivered).toHaveLength(1)
            expect(messages()).toContainEqual(expect.stringContaining('continue this task automatically'))

            // Changed from the web while the session waited.
            session.setPermissionMode('bypassPermissions')
            await vi.advanceTimersByTimeAsync(2 * MINUTE)
            await launched

            expect(harness.delivered[1]).toMatchObject({
                message: USAGE_LIMIT_CONTINUE_PROMPT,
                mode: { ...MODE, permissionMode: 'bypassPermissions' }
            })
            expect(messages()).toContain('Usage limit has reset. Continuing the task.')
        } finally {
            session.stopKeepAlive()
        }
    })

    it('lets a user message replace the automatic continue', async () => {
        const { session, queue, exit, messages } = createHarness()
        const resetsAt = Date.now() + 30 * MINUTE
        harness.script = async (opts) => {
            opts.onMessage(usageLimitHit(resetsAt))
            opts.onMessage(result)
            await opts.onReady()
            const next = await opts.nextMessage()
            if (next) harness.delivered.push(next)
        }

        try {
            queue.push('do the task', MODE, 'local-1')
            const launched = claudeRemoteLauncher(session as any)
            await vi.advanceTimersByTimeAsync(MINUTE)

            queue.push('never mind', MODE, 'local-2')
            await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE)
            exit()
            await launched

            expect(harness.delivered.map((turn) => turn.message)).toEqual(['do the task', 'never mind'])
            expect(messages()).toContainEqual(expect.stringContaining('Automatic continue cancelled'))
        } finally {
            session.stopKeepAlive()
        }
    })

    it('compacts a long conversation left idle for most of the cache lifetime', async () => {
        const { session, queue, exit, messages } = createHarness()
        harness.script = async (opts, call) => {
            if (call === 1) {
                opts.onMessage(longReply())
                opts.onMessage(result)
                await opts.onReady()
                // /compact is isolated: parked, so this Claude process ends.
                await opts.nextMessage()
                return
            }
            exit()
        }

        try {
            queue.push('read the codebase', MODE, 'local-1')
            const launched = claudeRemoteLauncher(session as any)

            await vi.advanceTimersByTimeAsync(53 * MINUTE)
            expect(harness.delivered).toHaveLength(1)

            await vi.advanceTimersByTimeAsync(2 * MINUTE)
            await launched

            expect(harness.delivered[1]).toMatchObject({ message: '/compact', mode: MODE, isolate: true })
            expect(messages()).toContainEqual(expect.stringContaining('compacting before the prompt cache expires'))
        } finally {
            session.stopKeepAlive()
        }
    })
})
