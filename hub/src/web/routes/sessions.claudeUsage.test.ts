import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { RefreshClaudeUsageResponse } from '@hapi/protocol/types'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function createApp(options: {
    flavor?: string
    active?: boolean
    refresh: (sessionId: string) => Promise<RefreshClaudeUsageResponse>
}) {
    const session = {
        id: 'session-1',
        namespace: 'default',
        active: options.active ?? true,
        metadata: { path: '/repo', host: 'box', flavor: options.flavor ?? 'claude', machineId: 'machine-1' }
    } as unknown as Session
    const engine = {
        resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
        refreshClaudeUsage: options.refresh
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine))
    return app
}

const refreshRequest = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }

describe('POST /sessions/:id/claude-usage/refresh', () => {
    it('returns the refreshed usage from the session', async () => {
        const usage = { fetchedAt: 1_000, subscriptionType: 'max', limits: [{ kind: 'session', scope: null, percent: 15, resetsAt: null }] }
        const calls: string[] = []
        const app = createApp({
            refresh: async (sessionId) => {
                calls.push(sessionId)
                return { status: 'ok', usage }
            }
        })

        const response = await app.request('/api/sessions/session-1/claude-usage/refresh', refreshRequest)

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: 'ok', usage })
        expect(calls).toEqual(['session-1'])
    })

    it('answers not-running when the session has no handler for it', async () => {
        const app = createApp({
            refresh: async () => {
                throw new RpcTargetMissingError('session-1:refresh-claude-usage', 'handler-not-registered')
            }
        })

        const response = await app.request('/api/sessions/session-1/claude-usage/refresh', refreshRequest)

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: 'not-running' })
    })

    it('rejects non-Claude and inactive sessions', async () => {
        const refresh = async (): Promise<RefreshClaudeUsageResponse> => ({ status: 'failed' })

        const codex = await createApp({ flavor: 'codex', refresh })
            .request('/api/sessions/session-1/claude-usage/refresh', refreshRequest)
        expect(codex.status).toBe(400)

        const inactive = await createApp({ active: false, refresh })
            .request('/api/sessions/session-1/claude-usage/refresh', refreshRequest)
        expect(inactive.status).toBe(409)
    })
})
