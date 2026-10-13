import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const killProcessMock = vi.fn(async (child: any) => {
    child.killed = true
    child.stdout.end()
    child.emit('close', 0)
})

vi.mock('node:child_process', () => ({
    ...require('node:child_process'),
    spawn: spawnMock
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: () => false,
    isWindows: () => false,
    killProcess: async () => true,
    killProcessByChildProcess: killProcessMock
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

vi.mock('../utils/mcpConfig', () => ({
    appendMcpConfigArg: () => null
}))

function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        killed: boolean
    }

    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    return child
}

afterEach(() => {
    vi.clearAllMocks()
    delete process.env.HAPI_CLAUDE_PATH
})

describe('Query', () => {
    it('reads usage with a get_usage control request', async () => {
        const { Query } = await import('./query')
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const query = new Query(stdin, stdout, new Promise<void>(() => {}))
        const written: string[] = []
        stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))

        const usage = query.getUsage(1_000)
        await vi.waitFor(() => expect(written).toHaveLength(1))
        const request = JSON.parse(written[0])
        expect(request).toMatchObject({
            type: 'control_request',
            request: { subtype: 'get_usage', skip_behaviors: true }
        })

        stdout.write(JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: request.request_id,
                response: { rate_limits_available: true }
            }
        }) + '\n')

        await expect(usage).resolves.toEqual({ rate_limits_available: true })
    })

    it('rejects a usage read that Claude never answers', async () => {
        vi.useFakeTimers()
        try {
            const { Query } = await import('./query')
            const query = new Query(new PassThrough(), new PassThrough(), new Promise<void>(() => {}))

            const usage = query.getUsage(1_000)
            const assertion = expect(usage).rejects.toThrow('get_usage timed out')
            await vi.advanceTimersByTimeAsync(1_000)
            await assertion
        } finally {
            vi.useRealTimers()
        }
    })

    it('preserves externally set errors even if the process exits cleanly', async () => {
        const { Query } = await import('./query')
        const stdout = new PassThrough()
        const query = new Query(null, stdout, Promise.resolve())

        query.setError(new Error('prompt failed'))
        stdout.end()

        await expect(query.next()).rejects.toThrow('prompt failed')
    })

    it('propagates prompt stream failures through query()', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'user', message: { role: 'user', content: 'hello' } }
                throw new Error('prompt failed')
            }
        }

        const result = query({ prompt })

        await expect(result.next()).rejects.toThrow('prompt failed')
    })

    it('fails fast after cleanup timeout when prompt cleanup hangs', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        killProcessMock.mockReturnValueOnce(new Promise<void>(() => {}))
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'user', message: { role: 'user', content: 'hello' } }
                throw new Error('prompt failed')
            }
        }

        const result = query({ prompt, options: { promptFailureCleanupTimeoutMs: 10 } })

        await expect(result.next()).rejects.toThrow('prompt failed')
    })

    it('places additional launch arguments before HAPI settings', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        query({
            prompt: 'hello',
            options: {
                additionalArgs: ['--plugin-dir', '/tmp/plugin'],
                settingsPath: '/tmp/hapi-settings.json'
            }
        })

        const args = spawnMock.mock.calls[0][1] as string[]
        expect(args.indexOf('--plugin-dir')).toBeLessThan(args.indexOf('--settings'))
        child.stdout.end()
        child.emit('close', 0)
    })
})
