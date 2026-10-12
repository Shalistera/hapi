import { describe, it, expect, vi, afterEach } from 'vitest';
import * as claudeSdk from '@/claude/sdk';
import type { SDKMessage, SDKUserMessage } from '@/claude/sdk/types';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { claudeRemote } from './claudeRemote';

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}));

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}));

type Mode = { permissionMode: 'default' };
type Steer = (message: string) => boolean;

const result = {
    type: 'result',
    subtype: 'success',
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    session_id: 's-1'
} as unknown as SDKMessage;

function lifecycle(commandUuid: string | undefined, state: string): SDKMessage {
    return { type: 'command_lifecycle', command_uuid: commandUuid, state } as unknown as SDKMessage;
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** Lets the test play Claude: read the prompts hapi writes, emit stream messages. */
function startFakeClaude(initialMessage: string) {
    const prompts: SDKUserMessage[] = [];
    const output = new PushableAsyncIterable<SDKMessage>();
    const querySpy = vi.spyOn(claudeSdk, 'query').mockImplementation((({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        void (async () => {
            for await (const message of prompt) {
                prompts.push(message);
            }
        })();
        return output;
    }) as unknown as typeof claudeSdk.query);

    let nextCallCount = 0;
    let releaseNext: ((value: { message: string; mode: Mode } | null) => void) | null = null;
    const readyEvents: number[] = [];
    const thinking: boolean[] = [];
    const steerable: boolean[] = [];
    let steer: Steer | null = null;

    const run = claudeRemote({
        sessionId: 'session-1',
        path: process.cwd(),
        mcpServers: {},
        claudeEnvVars: {},
        claudeArgs: [],
        allowedTools: [],
        hookSettingsPath: '/tmp/hook.json',
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        nextMessage: async () => {
            nextCallCount += 1;
            if (nextCallCount === 1) {
                return { message: initialMessage, mode: { permissionMode: 'default' } };
            }
            return await new Promise((resolve) => { releaseNext = resolve; });
        },
        onReady: () => { readyEvents.push(Date.now()); },
        isAborted: () => false,
        onSessionFound: () => {},
        onThinkingChange: (value) => { thinking.push(value); },
        onMessage: () => {},
        onCompletionEvent: () => {},
        onSteerableChange: (value) => {
            steer = value;
            steerable.push(value !== null);
        }
    });

    return {
        prompts,
        readyEvents,
        thinking,
        steerable,
        getSteer: () => steer,
        emit: (message: SDKMessage) => output.push(message),
        /** Emit messages and let claudeRemote process them. */
        async play(...messages: SDKMessage[]) {
            for (const message of messages) {
                output.push(message);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        },
        async finish() {
            await waitFor(() => releaseNext !== null);
            releaseNext!(null);
            output.end();
            await run;
            querySpy.mockRestore();
        }
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('claudeRemote mid-turn steering', () => {
    it('writes a steer into the running turn and ends the turn on its result', async () => {
        const claude = startFakeClaude('Run the three steps');
        await waitFor(() => claude.prompts.length === 1);
        const initialUuid = claude.prompts[0].uuid;
        expect(initialUuid).toBeTruthy();
        await claude.play(lifecycle(initialUuid, 'queued'), lifecycle(initialUuid, 'started'));

        expect(claude.getSteer()?.('Skip step three')).toBe(true);
        await waitFor(() => claude.prompts.length === 2);
        const steerPrompt = claude.prompts[1];
        expect(steerPrompt.message.content).toBe('Skip step three');
        expect(steerPrompt.uuid).toBeTruthy();
        expect(steerPrompt.uuid).not.toBe(initialUuid);

        // Absorbed at the next tool boundary, before the turn's result.
        await claude.play(lifecycle(steerPrompt.uuid, 'queued'), lifecycle(steerPrompt.uuid, 'started'), result);

        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.thinking.at(-1)).toBe(false);
        expect(claude.steerable).toEqual([true, false]);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('stays busy through the follow-up turn when the steer arrives after the last tool call', async () => {
        const claude = startFakeClaude('Write an essay');
        await waitFor(() => claude.prompts.length === 1);
        const initialUuid = claude.prompts[0].uuid;
        await claude.play(lifecycle(initialUuid, 'queued'), lifecycle(initialUuid, 'started'));

        const steer = claude.getSteer();
        expect(steer?.('Add a sentence about coffee')).toBe(true);
        await waitFor(() => claude.prompts.length === 2);
        const steerUuid = claude.prompts[1].uuid;

        // The turn ends before the steer was absorbed: Claude runs it next.
        await claude.play(lifecycle(steerUuid, 'queued'), result, lifecycle(initialUuid, 'completed'));
        expect(claude.readyEvents).toHaveLength(0);
        expect(claude.thinking).not.toContain(false);
        expect(claude.getSteer()).toBe(steer);

        await claude.play(lifecycle(steerUuid, 'started'), result);
        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.thinking.at(-1)).toBe(false);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('ends the turn on its result when Claude reports no command lifecycle', async () => {
        const claude = startFakeClaude('Run the three steps');
        await waitFor(() => claude.prompts.length === 1);

        expect(claude.getSteer()?.('Skip step three')).toBe(true);
        await claude.play(result);

        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('waits for an unstarted steer through one result only', async () => {
        const claude = startFakeClaude('Write an essay');
        await waitFor(() => claude.prompts.length === 1);
        const initialUuid = claude.prompts[0].uuid;
        await claude.play(lifecycle(initialUuid, 'queued'), lifecycle(initialUuid, 'started'));

        expect(claude.getSteer()?.('Add a sentence about coffee')).toBe(true);
        await claude.play(result);
        expect(claude.readyEvents).toHaveLength(0);

        // Its start was never reported; the next result must not wait again.
        await claude.play(result);
        expect(claude.readyEvents).toHaveLength(1);
        expect(claude.getSteer()).toBeNull();

        await claude.finish();
    });

    it('rejects a steer once the turn has ended', async () => {
        const claude = startFakeClaude('Run the three steps');
        await waitFor(() => claude.prompts.length === 1);
        const steer = claude.getSteer();
        await claude.play(result);

        expect(steer?.('Too late')).toBe(false);
        expect(claude.prompts).toHaveLength(1);

        await claude.finish();
    });

    it('does not offer steering during /compact', async () => {
        const claude = startFakeClaude('/compact');
        await waitFor(() => claude.prompts.length === 1);
        expect(claude.getSteer()).toBeNull();
        await claude.play(result);

        expect(claude.steerable).toEqual([]);

        await claude.finish();
    });
});
