import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const projectRoot = new URL('../', import.meta.url)

// 复用项目已有 TypeScript 编译器执行真实源码，不引入额外测试依赖。
function loadSource(relativePath, imports = {}) {
  const source = readFileSync(new URL(relativePath, projectRoot), 'utf8')
  const compiled = ts.transpileModule(source, {
    fileName: relativePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  const require = (name) => {
    assert.ok(name in imports, 'Unexpected runtime import: ' + name)
    return imports[name]
  }
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports)
  return module.exports
}

const api = loadSource('src/api/netease-direct.ts')
const mutations = loadSource('src/services/playlist-track-mutation.ts', { '@/api/netease-direct': api })
const cleanup = loadSource('src/services/playlist-cleanup.ts', {
  '@/api/netease-direct': api, '@/services/playlist-track-mutation': mutations,
})
const USER = 7
const SOURCE = 101
const REFERENCE = 202
const detailPath = '/api/v6/playlist/detail'
const mutationPath = '/api/playlist/manipulate/tracks'

/** 拦截所有网络访问，模拟服务端真实状态并记录实际请求目标。 */
function fixture(t, { sourceIds = [1, 2, 3, 4], referenceIds = [2, 3, 5] } = {}) {
  const previousFetch = globalThis.fetch
  const previousDocument = globalThis.document
  const state = {
    userId: USER,
    playlists: new Map([
      [SOURCE, { id: SOURCE, name: '最近', creatorId: USER, trackIds: [...sourceIds] }],
      [REFERENCE, { id: REFERENCE, name: '归档', creatorId: USER, trackIds: [...referenceIds] }],
    ]),
    requests: [],
    writes: [],
    initialReferenceIds: [...referenceIds],
    reportedCounts: new Map(),
    onDelete: null,
    onRead: null,
    onList: null,
  }
  state.applyDeletion = (ids) => {
    const removedIds = new Set(ids)
    const source = state.playlists.get(SOURCE)
    source.trackIds = source.trackIds.filter((id) => !removedIds.has(id))
  }
  state.detail = (id) => {
    const playlist = state.playlists.get(id)
    return {
      code: 200,
      playlist: {
        id,
        name: playlist.name,
        creator: { userId: playlist.creatorId },
        trackCount: state.reportedCounts.get(id) ?? playlist.trackIds.length,
        trackIds: playlist.trackIds.map((trackId) => ({ id: trackId })),
      },
    }
  }
  const respond = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  globalThis.document = { cookie: '__csrf=test-token' }
  globalThis.fetch = async (input, options) => {
    const path = new URL(input).pathname
    const params = new URLSearchParams(options.body)
    const request = { path, params }
    state.requests.push(request)
    assert.equal(options.credentials, 'include')
    assert.equal(params.get('csrf_token'), 'test-token')
    if (path === '/api/w/nuser/account/get') {
      return respond({ code: 200, profile: { userId: state.userId } })
    }
    if (path === '/api/user/playlist') {
      const override = state.onList ? await state.onList(request) : undefined
      return respond(override ?? {
        code: 200,
        playlist: [...state.playlists.values()].map((playlist) => ({
          id: playlist.id,
          name: playlist.name,
          creator: { userId: playlist.creatorId },
          trackCount: playlist.trackIds.length,
        })),
        more: false,
      })
    }
    if (path === detailPath) {
      const id = Number(params.get('id'))
      const override = state.onRead ? await state.onRead(id, request) : undefined
      return respond(override ?? state.detail(id))
    }
    assert.equal(path, mutationPath, 'Unexpected endpoint: ' + path)
    const write = {
      pid: Number(params.get('pid')),
      op: params.get('op'),
      trackIds: JSON.parse(params.get('trackIds')),
    }
    state.writes.push(write)
    assert.equal(write.pid, SOURCE, 'A write targeted the protected reference playlist')
    assert.equal(write.op, 'del', 'Cleanup must never add or overwrite songs')
    assert.ok(write.trackIds.length > 0 && write.trackIds.length <= 100)
    const override = state.onDelete ? await state.onDelete(write, state.writes.length) : undefined
    if (override !== undefined) return respond(override)
    state.applyDeletion(write.trackIds)
    return respond({ code: 200 })
  }
  t.after(() => {
    globalThis.fetch = previousFetch
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    assert.ok(state.writes.every((write) => write.pid === SOURCE && write.op === 'del'))
  })
  return state
}

const preview = () => cleanup.previewPlaylistCleanup(USER, SOURCE, REFERENCE)
const assertReferenceUnchanged = (state) => {
  assert.deepEqual(state.playlists.get(REFERENCE).trackIds, state.initialReferenceIds)
}

test('preview reads complete IDs, preserves order and freezes A/B roles without writing', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  assert.deepEqual(plan.removableTrackIds, [2, 3])
  assert.deepEqual(plan.source.trackIds, [1, 2, 3, 4])
  assert.deepEqual(plan.reference.trackIds, [2, 3, 5])
  assert.ok(Object.isFrozen(plan))
  assert.ok(Object.isFrozen(plan.source.trackIds))
  assert.ok(Object.isFrozen(plan.reference.trackIds))
  assert.equal(state.writes.length, 0)
})

test('cleanup only removes the intersection from A and preserves every song and order in B', async (t) => {
  const state = fixture(t)
  const progress = []
  const outcome = await cleanup.executePlaylistCleanup(await preview(), (value) => progress.push(value))
  assert.equal(outcome.status, 'completed')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [1, 4])
  assertReferenceUnchanged(state)
  assert.deepEqual(state.writes, [{ pid: SOURCE, op: 'del', trackIds: [2, 3] }])
  assert.equal(outcome.removedCount, 2)
  assert.equal(outcome.pendingCount, 0)
  assert.equal(outcome.remainingTrackCount, 2)
  assert.equal(outcome.sourceVerified, true)
  assert.equal(outcome.referenceUnchanged, true)
  assert.deepEqual(progress, [{ removedCount: 2, totalCount: 2 }])
})

test('disjoint playlists produce no mutation requests', async (t) => {
  const state = fixture(t, { sourceIds: [1, 2], referenceIds: [3, 4] })
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.removedCount, 0)
  assert.equal(state.writes.length, 0)
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [1, 2])
  assertReferenceUnchanged(state)
})

test('cleanup skips a song-specific deletion rejection and continues beyond 100 songs without touching B', async (t) => {
  const ids = Array.from({ length: 103 }, (_, i) => i + 1)
  const state = fixture(t, { sourceIds: [...ids, 999], referenceIds: ids })
  state.onDelete = (write) => write.trackIds.includes(88) ? { code: 512, message: '该歌曲无法删除' } : undefined
  const progress = []
  const outcome = await cleanup.executePlaylistCleanup(await preview(), (item) => progress.push(item))
  assert.equal(outcome.status, 'partial')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [88, 999])
  assert.equal(outcome.sourceVerified, true)
  assert.equal(outcome.removedCount, 102)
  assert.deepEqual(outcome.failedTracks.map((item) => item.songId), [88])
  assert.equal(progress.at(-1).removedCount, 102)
  assertReferenceUnchanged(state)
})

test('all shared songs may be removed from A while B remains intact', async (t) => {
  const state = fixture(t, { sourceIds: [2, 3], referenceIds: [2, 3, 5] })
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.remainingTrackCount, 0)
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [])
  assertReferenceUnchanged(state)
})

test('empty playlists are valid and never cause writes', async (t) => {
  const state = fixture(t, { sourceIds: [], referenceIds: [] })
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'completed')
  assert.equal(state.writes.length, 0)
})

test('the same A/B ID is rejected before any network access', async (t) => {
  const state = fixture(t)
  await assert.rejects(cleanup.previewPlaylistCleanup(USER, SOURCE, SOURCE), /两个不同/)
  await assert.rejects(api.removeSourcePlaylistTracks(SOURCE, SOURCE, [1]), /两个不同/)
  assert.equal(state.requests.length, 0)
})

test('a playlist not owned by the logged-in user cannot be selected as A', async (t) => {
  const state = fixture(t)
  state.playlists.get(SOURCE).creatorId = 99
  await assert.rejects(preview(), /自己创建/)
  assert.equal(state.writes.length, 0)
})

test('an account change after preview prevents all writes', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  state.userId = 99
  const outcome = await cleanup.executePlaylistCleanup(plan)
  assert.equal(outcome.status, 'stopped')
  assert.match(outcome.message, /账号已变化/)
  assert.equal(state.writes.length, 0)
  assertReferenceUnchanged(state)
})

test('a stale preview after changes to A is rejected without deleting anything', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  state.playlists.get(SOURCE).trackIds.push(99)
  const outcome = await cleanup.executePlaylistCleanup(plan)
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.sourceVerified, false)
  assert.equal(state.writes.length, 0)
})

test('a stale preview after changes to B is rejected without any write', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  state.playlists.get(REFERENCE).trackIds.push(99)
  const outcome = await cleanup.executePlaylistCleanup(plan)
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.referenceUnchanged, false)
  assert.equal(state.writes.length, 0)
})

test('reordering B with the same count is detected before any write', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  state.playlists.get(REFERENCE).trackIds = [3, 2, 5]
  const outcome = await cleanup.executePlaylistCleanup(plan)
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.referenceUnchanged, false)
  assert.equal(state.writes.length, 0)
})

test('a tampered removal list cannot delete A-only songs', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  const requestCount = state.requests.length
  await assert.rejects(
    cleanup.executePlaylistCleanup({ ...plan, removableTrackIds: [1, 2, 3] }),
    /交集不一致/
  )
  assert.equal(state.requests.length, requestCount)
  assert.equal(state.writes.length, 0)
})

test('multiple batches respect the 100-song limit and preserve A-only order and all of B', async (t) => {
  const shared = Array.from({ length: 205 }, (_, index) => index + 1)
  const state = fixture(t, { sourceIds: [999, ...shared, 998], referenceIds: [...shared, 997] })
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'completed')
  assert.deepEqual(state.writes.map((write) => write.trackIds.length), [100, 100, 5])
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [999, 998])
  assertReferenceUnchanged(state)
})

test('HTTP success with a failed business response is not reported as successful cleanup', async (t) => {
  const state = fixture(t)
  state.onDelete = () => ({ code: 502, message: '操作过于频繁' })
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'stopped')
  assert.match(outcome.message, /操作过于频繁/)
  assert.equal(outcome.removedCount, 0)
  assert.equal(outcome.pendingCount, 2)
  assert.equal(state.writes.length, 1)
  assertReferenceUnchanged(state)
})

test('failure in a later batch stops further writes and reports only verified removals', async (t) => {
  const shared = Array.from({ length: 205 }, (_, index) => index + 1)
  const state = fixture(t, { sourceIds: [...shared, 999], referenceIds: shared })
  state.onDelete = (_write, count) => count === 2 ? { code: 500, message: '服务暂不可用' } : undefined
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'stopped')
  assert.equal(state.writes.length, 2)
  assert.equal(outcome.removedCount, 100)
  assert.equal(outcome.pendingCount, 105)
  assert.equal(outcome.sourceVerified, true)
  assertReferenceUnchanged(state)
})

test('changes to B during cleanup stop the next batch without attempting to restore B', async (t) => {
  const shared = Array.from({ length: 105 }, (_, index) => index + 1)
  const state = fixture(t, { sourceIds: shared, referenceIds: shared })
  state.onDelete = () => { state.playlists.get(REFERENCE).trackIds.reverse() }
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.referenceUnchanged, false)
  assert.equal(state.writes.length, 1)
  assert.equal(outcome.removedCount, 100)
  assert.equal(outcome.pendingCount, 5)
})

test('a lost response after server-side deletion is reread and never blindly retried', async (t) => {
  const state = fixture(t)
  state.onDelete = (write) => {
    state.applyDeletion(write.trackIds)
    throw new Error('连接中断')
  }
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.removedCount, 2)
  assert.equal(outcome.pendingCount, 0)
  assert.equal(outcome.sourceVerified, true)
  assert.equal(state.writes.length, 1)
  assertReferenceUnchanged(state)
})

test('partial server-side deletion is detected even with a successful business response', async (t) => {
  const state = fixture(t)
  state.onDelete = (write) => {
    state.applyDeletion(write.trackIds.slice(0, 1))
    return { code: 200 }
  }
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'partial')
  assert.deepEqual(outcome.failedTracks.map((item) => item.songId), [3])
  assert.equal(outcome.removedCount, 1)
  assert.equal(outcome.pendingCount, 1)
  assert.equal(state.writes.length, 1)
  assertReferenceUnchanged(state)
})

test('unreadable post-operation state remains unknown rather than displaying success', async (t) => {
  const state = fixture(t)
  state.onDelete = (write) => {
    state.applyDeletion(write.trackIds)
    state.onRead = () => { throw new Error('读取失败') }
    return { code: 200 }
  }
  const outcome = await cleanup.executePlaylistCleanup(await preview())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.removedCount, null)
  assert.equal(outcome.sourceVerified, null)
  assert.equal(outcome.referenceUnchanged, null)
  assert.doesNotMatch(outcome.message, /^清理完成/)
  assert.equal(state.writes.length, 1)
  assertReferenceUnchanged(state)
})

test('a second execution cannot run concurrently with the first', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  let release
  let markStarted
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  state.onDelete = async () => {
    markStarted()
    await gate
  }
  const firstExecution = cleanup.executePlaylistCleanup(plan)
  await started
  try {
    await assert.rejects(cleanup.executePlaylistCleanup(plan), /正在执行/)
  } finally {
    release()
  }
  assert.equal((await firstExecution).status, 'completed')
  assert.equal(state.writes.length, 1)
  assertReferenceUnchanged(state)
})

test('a new preview after successful cleanup is idempotent and performs no further writes', async (t) => {
  const state = fixture(t)
  await cleanup.executePlaylistCleanup(await preview())
  const nextPlan = await preview()
  assert.deepEqual(nextPlan.removableTrackIds, [])
  const outcome = await cleanup.executePlaylistCleanup(nextPlan)
  assert.equal(outcome.status, 'completed')
  assert.equal(state.writes.length, 1)
  assertReferenceUnchanged(state)
})

test('snapshot validation rejects missing, wrong and invalid ID responses', async (t) => {
  const cases = [
    ['business failure', () => ({ code: 403, message: '无权读取' })],
    ['missing playlist', () => ({ code: 200 })],
    ['wrong playlist', (body) => { body.playlist.id = REFERENCE; return body }],
    ['missing IDs', (body) => { delete body.playlist.trackIds; return body }],
    ['invalid count', (body) => { body.playlist.trackCount = -1; return body }],
    ['duplicate IDs', (body) => { body.playlist.trackIds[1].id = 1; return body }],
    ['invalid ID', (body) => { body.playlist.trackIds[1].id = 0; return body }],
    ['missing owner', (body) => { delete body.playlist.creator; return body }],
  ]
  for (const [name, alter] of cases) {
    await t.test(name, async (subtest) => {
      const state = fixture(subtest)
      state.onRead = (id) => alter(state.detail(id))
      await assert.rejects(api.getPlaylistSnapshotChecked(SOURCE))
      assert.equal(state.writes.length, 0)
    })
  }
})

test('a larger metadata count in B does not block cleanup or expand the returned ID intersection', async (t) => {
  const state = fixture(t)
  state.reportedCounts.set(REFERENCE, 5)
  const plan = await preview()
  assert.equal(plan.reference.reportedTrackCount, 5)
  assert.deepEqual(plan.reference.trackIds, [2, 3, 5])
  assert.deepEqual(plan.removableTrackIds, [2, 3])
  const outcome = await cleanup.executePlaylistCleanup(plan)
  assert.equal(outcome.status, 'completed')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [1, 4])
  assert.deepEqual(state.writes, [{ pid: SOURCE, op: 'del', trackIds: [2, 3] }])
  assertReferenceUnchanged(state)
})

test('metadata count drift during cleanup does not masquerade as a song change', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  state.reportedCounts.set(SOURCE, 2)
  state.reportedCounts.set(REFERENCE, 5)
  const outcome = await cleanup.executePlaylistCleanup(plan)
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.sourceVerified, true)
  assert.equal(outcome.referenceUnchanged, true)
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [1, 4])
  assertReferenceUnchanged(state)
})

test('songs absent from the returned B IDs remain in A even when B reports a larger count', async (t) => {
  const state = fixture(t, { sourceIds: [1, 2], referenceIds: [3] })
  state.reportedCounts.set(REFERENCE, 3)
  const plan = await preview()
  assert.deepEqual(plan.removableTrackIds, [])
  const outcome = await cleanup.executePlaylistCleanup(plan)
  assert.equal(outcome.status, 'completed')
  assert.equal(state.writes.length, 0)
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [1, 2])
  assertReferenceUnchanged(state)
})

test('the mutation API refuses invalid IDs and batches larger than 100 before sending requests', async (t) => {
  const state = fixture(t)
  await assert.rejects(api.removeSourcePlaylistTracks(SOURCE, REFERENCE, [0]))
  await assert.rejects(api.removeSourcePlaylistTracks(SOURCE, REFERENCE, [2, 2]))
  await assert.rejects(api.removeSourcePlaylistTracks(SOURCE, REFERENCE, Array.from({ length: 101 }, (_, id) => id + 1)))
  assert.equal(state.requests.length, 0)
})

test('owned playlist listing reads subsequent pages and excludes playlists created by others', async (t) => {
  const state = fixture(t)
  state.onList = ({ params }) => Number(params.get('offset')) === 0 ? {
    code: 200,
    playlist: [{ id: SOURCE, name: '最近', trackCount: 4, creator: { userId: USER } }],
    more: true,
  } : {
    code: 200,
    playlist: [
      { id: REFERENCE, name: '归档', trackCount: 3, creator: { userId: USER } },
      { id: 303, name: '收藏的其他人歌单', trackCount: 3, creator: { userId: 99 } },
    ],
    more: false,
  }
  const playlists = await api.getCleanupPlaylists(USER)
  assert.deepEqual(playlists.map((playlist) => playlist.id), [SOURCE, REFERENCE])
  assert.equal(state.requests.length, 2)
  assert.equal(state.writes.length, 0)
})

test('owned playlist listing rejects a repeated page instead of requesting indefinitely', async (t) => {
  const state = fixture(t)
  state.onList = () => ({
    code: 200,
    playlist: [{ id: SOURCE, name: '最近', trackCount: 4, creator: { userId: USER } }],
    more: true,
  })
  await assert.rejects(api.getCleanupPlaylists(USER), /未返回新数据/)
  assert.equal(state.requests.length, 2)
  assert.equal(state.writes.length, 0)
})
