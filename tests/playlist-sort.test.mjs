import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

function loadSource(path, imports = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
    fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.ok(name in imports, 'Unexpected runtime import: ' + name)
    return imports[name]
  }, module, module.exports)
  return module.exports
}

const api = loadSource('src/api/netease-direct.ts')
const sorter = loadSource('src/utils/playlist-sort.ts')
const service = loadSource('src/services/playlist-sort.ts', {
  '@/api/netease-direct': api, '@/utils/playlist-sort': sorter,
})
const USER = 7, SOURCE = 101, OTHER = 202, COLLECTED = 303, BASE = 1700000000000
const options = (rule = 'added', direction = 'desc', missing = 'last') => ({ rule, direction, missing })
const tracks = (values) => values.map((value, index) => ({
  songId: index + 1, name: '歌曲' + (index + 1), artists: ['歌手'], originalPosition: index + 1, value,
}))

test('a rejected song detail does not block popularity sorting or remove its ID', async (t) => {
  const state = fixture(t)
  state.onSongs = (ids) => ids.includes(2) ? { code: 512, message: '下架歌曲不可用' } : undefined
  const plan = await service.previewPlaylistSort(USER, SOURCE, options('popularity'))
  assert.equal(plan.tracks.find((song) => song.songId === 2).value, null)
  assert.equal(plan.tracks.find((song) => song.songId === 3).value, 100)
  assert.deepEqual([...plan.orderedTrackIds].sort(), [1, 2, 3, 4, 5])
  assert.equal((await service.executePlaylistSort(plan)).status, 'completed')
  assert.deepEqual([...state.playlists.get(SOURCE).trackIds].sort(), [1, 2, 3, 4, 5])
})

/** 所有网络被截获，禁止添加、删除、清空或对其他歌单写入。 */
function fixture(t, ids = [1, 2, 3, 4, 5]) {
  const old = { fetch: globalThis.fetch, document: globalThis.document }
  const state = {
    userId: USER, requests: [], writes: [], events: [], accountReads: 0,
    onRead: null, onSongs: null, onRecord: null, onWrite: null, onAccount: null,
    count: undefined, cloudCount: undefined,
    playlists: new Map([
      [SOURCE, { id: SOURCE, name: '测试歌单', creatorId: USER, trackIds: [...ids] }],
      [OTHER, { id: OTHER, name: '其他歌单', creatorId: USER, trackIds: [9, 8] }],
      [COLLECTED, { id: COLLECTED, name: '收藏歌单', creatorId: 99, trackIds: [1] }],
    ]),
    added: new Map([[1, BASE + 1000], [2, BASE + 5000], [3, BASE + 5000], [4, null], [5, BASE + 3000]]),
    popularity: new Map([[1, 20], [2, 100], [3, 100], [4, null], [5, 0]]),
    all: [{ song: { id: 1 }, playCount: 3 }, { song: { id: 3 }, playCount: 10 },
      { song: { id: 5 }, playCount: 0 }, { song: { id: 4 }, score: 70 }, { song: { id: 99 }, playCount: 100 }],
    week: [{ song: { id: 1 }, playCount: 5 }, { song: { id: 2 }, playCount: 2 }],
  }
  state.detail = (id) => {
    const playlist = state.playlists.get(id)
    return { code: 200, playlist: {
      id, name: playlist.name, creator: { userId: playlist.creatorId },
      trackCount: state.count ?? playlist.trackIds.length, cloudTrackCount: state.cloudCount,
      trackIds: playlist.trackIds.map((id) => ({ id, at: state.added.get(id) })),
    } }
  }
  state.apply = (write) => { state.playlists.get(write.pid).trackIds = [...write.ids] }
  const respond = (body) => new Response(JSON.stringify(body), { status: 200 })
  globalThis.document = { cookie: '__csrf=mock' }
  globalThis.fetch = async (url, request) => {
    const path = new URL(url).pathname
    const params = new URLSearchParams(request.body)
    state.requests.push({ path, params })
    assert.equal(request.credentials, 'include')
    assert.equal(params.get('csrf_token'), 'mock')
    if (path === '/api/w/nuser/account/get') {
      const override = state.onAccount ? await state.onAccount(++state.accountReads) : undefined
      return respond(override ?? { code: 200, profile: { userId: state.userId } })
    }
    if (path === '/api/v6/playlist/detail') {
      const id = Number(params.get('id'))
      state.events.push({ kind: 'read', id })
      const override = state.onRead ? await state.onRead(id) : undefined
      return respond(override ?? state.detail(id))
    }
    if (path === '/api/v3/song/detail') {
      const ids = JSON.parse(params.get('c')).map((item) => item.id)
      assert.ok(ids.length > 0 && ids.length <= 200)
      const override = state.onSongs ? await state.onSongs(ids) : undefined
      return respond(override ?? {
        code: 200, songs: ids.map((id) => ({
          id, name: '歌曲' + id, ar: [{ name: '歌手' + id }], pop: state.popularity.get(id),
        })),
      })
    }
    if (path === '/api/v1/play/record') {
      assert.equal(Number(params.get('uid')), USER)
      const period = Number(params.get('type'))
      assert.ok(period === 0 || period === 1)
      const override = state.onRecord ? await state.onRecord(period) : undefined
      return respond(override ?? { code: 200, allData: state.all, weekData: state.week })
    }
    assert.equal(path, '/api/playlist/manipulate/tracks', 'Unexpected real endpoint: ' + path)
    const write = { pid: Number(params.get('pid')), op: params.get('op'), ids: JSON.parse(params.get('trackIds')) }
    assert.equal(write.pid, SOURCE, 'Other playlists must remain readonly')
    assert.equal(write.op, 'update', 'No adds, deletes or clearing permitted')
    assert.deepEqual([...write.ids].sort((a, b) => a - b), [...state.playlists.get(SOURCE).trackIds].sort((a, b) => a - b))
    state.writes.push(write)
    state.events.push({ kind: 'write', ...write })
    const override = state.onWrite ? await state.onWrite(write) : undefined
    if (override !== undefined) return respond(override)
    state.apply(write)
    return respond({ code: 200 })
  }
  t.after(() => {
    globalThis.fetch = old.fetch
    if (old.document === undefined) delete globalThis.document
    else globalThis.document = old.document
  })
  return state
}

const preview = (sortOptions = options()) => service.previewPlaylistSort(USER, SOURCE, sortOptions)

test('added time sorts by real timestamps, preserves ties and supports both directions', () => {
  const rows = tracks([1000, 5000, 5000, null, 3000])
  assert.deepEqual(sorter.sortPlaylistTracks(rows, options()), [2, 3, 5, 1, 4])
  assert.deepEqual(sorter.sortPlaylistTracks(rows, options('added', 'asc')), [1, 5, 2, 3, 4])
  assert.deepEqual(rows.map((row) => row.songId), [1, 2, 3, 4, 5])
})

test('unknown values may stay in exact original slots while known songs reorder stably', () => {
  assert.deepEqual(sorter.sortPlaylistTracks(tracks([1000, 5000, 5000, null, 3000]), options('added', 'desc', 'keep')),
    [2, 3, 5, 4, 1])
})

test('popularity zero is known and stays distinct from missing values for either direction', () => {
  const rows = tracks([20, 100, 100, null, 0])
  assert.deepEqual(sorter.sortPlaylistTracks(rows, options('popularity')), [2, 3, 1, 5, 4])
  assert.deepEqual(sorter.sortPlaylistTracks(rows, options('popularity', 'asc')), [5, 1, 2, 3, 4])
})

test('explicit play count zero remains known, unknowns stay stable and all-missing keeps original order', () => {
  assert.deepEqual(sorter.sortPlaylistTracks(tracks([3, null, 10, null, 0]), options('plays-all')), [3, 1, 5, 2, 4])
  assert.deepEqual(sorter.sortPlaylistTracks(tracks([null, null]), options('plays-week')), [1, 2])
})

// 每行依次为周次数、累计次数、热度、加入时间；包含跨组极值、同值和明确的 0。
const combinedValues = [
  [null, null, null, null], [2, 100, 90, BASE], [null, 80, 100, BASE + 100],
  [null, null, 80, BASE + 5000], [null, null, null, BASE + 1000], [5, 1, 2, BASE],
  [null, 1000, 100, BASE], [null, null, 95, null], [null, null, null, BASE + 3000],
  [null, null, null, null], [0, 99999, 100, BASE], [5, 9999, 100, BASE],
  [null, 0, 100, BASE], [null, null, 0, BASE], [null, null, null, BASE + 3000],
]
const combinedOrder = [6, 12, 2, 11, 7, 3, 13, 8, 4, 9, 15, 5, 14, 1, 10]
const combinedRows = () => combinedValues.map(([week, all, popularity, added], index) => ({
  songId: index + 1, name: '歌曲' + (index + 1), artists: [], originalPosition: index + 1,
  value: [week, all, popularity, added].find((value) => value !== null && value > 0) ?? null,
  metrics: { 'plays-week': week, 'plays-all': all, popularity, added },
}))

function combinedFixture(t) {
  const state = fixture(t, combinedValues.map((_, index) => index + 1))
  state.week = []
  state.all = []
  state.added.clear()
  state.popularity.clear()
  combinedValues.forEach(([week, all, popularity, added], index) => {
    const id = index + 1
    if (week !== null) state.week.push({ song: { id }, playCount: week })
    if (all !== null) state.all.push({ song: { id }, playCount: all })
    state.popularity.set(id, popularity)
    state.added.set(id, added)
  })
  return state
}

test('combined sorting creates five exclusive groups, falls through zero values and keeps stable ties', () => {
  const rows = combinedRows()
  assert.deepEqual(sorter.sortPlaylistTracks(rows, options('combined')), combinedOrder)
  assert.deepEqual(rows.map((row) => row.songId), Array.from({ length: 15 }, (_, i) => i + 1), 'Input order must not be mutated')
  assert.deepEqual(sorter.resolveCombinedSortBasis(rows[10].metrics), { rule: 'plays-all', groupIndex: 1, value: 99999 })
  assert.deepEqual(sorter.resolveCombinedSortBasis(rows[12].metrics), { rule: 'popularity', groupIndex: 2, value: 100 })
  assert.deepEqual(sorter.resolveCombinedSortBasis(rows[13].metrics), { rule: 'added', groupIndex: 3, value: BASE })
  assert.deepEqual(sorter.resolveCombinedSortBasis(rows[0].metrics), { rule: null, groupIndex: 4, value: null })
  const unknownInsteadOfZero = rows.map((row) => ({ ...row,
    metrics: Object.fromEntries(Object.entries(row.metrics).map(([rule, value]) => [rule, value === 0 ? null : value])),
  }))
  assert.deepEqual(sorter.sortPlaylistTracks(unknownInsteadOfZero, options('combined')), combinedOrder)
})

test('combined sorting rejects policies that would mix groups or keep unknown songs in earlier positions', () => {
  for (const config of [options('combined', 'asc'), options('combined', 'desc', 'keep')]) {
    assert.throws(() => sorter.sortPlaylistTracks(combinedRows(), config), /排序规则/)
  }
})

test('combined sorting rejects incomplete or invalid metrics and inconsistent effective values', () => {
  for (const metrics of [undefined, {}, { ...combinedRows()[0].metrics, 'plays-week': undefined },
    { ...combinedRows()[0].metrics, 'plays-week': -1 }, { ...combinedRows()[0].metrics, 'plays-all': 1.5 },
    { ...combinedRows()[0].metrics, popularity: 101 }, { ...combinedRows()[0].metrics, added: 0 }]) {
    assert.throws(() => sorter.sortPlaylistTracks([{ ...combinedRows()[0], metrics }], options('combined')), /四项指标/)
  }
  assert.throws(() => sorter.sortPlaylistTracks([{ ...combinedRows()[0], value: 1 }], options('combined')), /比较值/)
})

test('combined preview reads both periods, freezes four metrics and writes the full permutation exactly once', async (t) => {
  const state = combinedFixture(t)
  const originalIds = [...state.playlists.get(SOURCE).trackIds]
  const progress = []
  const plan = await service.previewPlaylistSort(USER, SOURCE, options('combined'), (value) => progress.push(value))
  assert.deepEqual(plan.orderedTrackIds, combinedOrder)
  assert.equal(plan.knownCount, 13)
  assert.equal(plan.missingCount, 2)
  assert.ok(plan.tracks.every((track) => Object.isFrozen(track.metrics)))
  assert.ok(Object.isFrozen(plan.combinedPlayCountSummaries.week))
  assert.deepEqual(plan.combinedPlayCountSummaries, {
    week: { returnedCount: 4, usableCount: 4, matchedCount: 4 },
    all: { returnedCount: 7, usableCount: 7, matchedCount: 7 },
  })
  assert.deepEqual(state.requests.filter((request) => request.path === '/api/v1/play/record').map((request) => request.params.get('type')), ['1', '0'])
  assert.equal(progress.filter((value) => value.phase === 'records').at(-1).completed, 2)
  assert.equal(state.writes.length, 0)
  const outcome = await service.executePlaylistSort(plan)
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.membershipPreserved, true)
  assert.equal(outcome.orderVerified, true)
  assert.deepEqual(state.writes, [{ pid: SOURCE, op: 'update', ids: combinedOrder }])
  assert.deepEqual([...state.playlists.get(SOURCE).trackIds].sort((a, b) => a - b), originalIds)
})

test('score-only counts and missing song details fall through to the next available metric', async (t) => {
  const state = fixture(t, [1, 2, 3, 4])
  state.week = [{ song: { id: 1 }, score: 100 }]
  state.all = [{ song: { id: 1 }, playCount: '12' }, { song: { id: 2 }, score: 90 }]
  state.onSongs = () => ({ code: 200, songs: [{ id: 2, pop: 88 }] })
  state.added = new Map([[3, BASE], [4, null]])
  const plan = await preview(options('combined'))
  assert.deepEqual(plan.tracks.map((track) => sorter.resolveCombinedSortBasis(track.metrics).rule), ['plays-all', 'popularity', 'added', null])
  assert.deepEqual(plan.tracks.map((track) => track.value), [12, 88, BASE, null])
  assert.deepEqual(plan.orderedTrackIds, [1, 2, 3, 4])
})

test('empty, all-unknown and zero-or-unknown combined previews retain every member and do not write', async (t) => {
  const state = fixture(t)
  state.week = []
  state.all = []
  state.popularity.clear()
  state.added.clear()
  let plan = await preview(options('combined'))
  assert.equal(plan.knownCount, 0)
  assert.equal(plan.missingCount, 5)
  assert.deepEqual(plan.orderedTrackIds, [1, 2, 3, 4, 5])
  assert.equal((await service.executePlaylistSort(plan)).status, 'completed')
  state.week = [{ song: { id: 1 }, playCount: '0' }]
  state.all = [{ song: { id: 2 }, playCount: 0 }]
  state.popularity.set(3, 0)
  plan = await preview(options('combined'))
  assert.equal(plan.knownCount, 0)
  assert.equal(plan.missingCount, 5)
  assert.deepEqual(plan.orderedTrackIds, [1, 2, 3, 4, 5])
  assert.equal(plan.tracks[0].metrics['plays-week'], 0)
  assert.equal(plan.tracks[1].metrics['plays-all'], 0)
  assert.equal(plan.tracks[2].metrics.popularity, 0)
  assert.equal((await service.executePlaylistSort(plan)).status, 'completed')
  state.playlists.get(SOURCE).trackIds = []
  plan = await preview(options('combined'))
  assert.deepEqual(plan.orderedTrackIds, [])
  assert.equal((await service.executePlaylistSort(plan)).status, 'completed')
  assert.equal(state.writes.length, 0)
})

test('zero counts fall through to lifetime plays, popularity or added time while raw zeros and all members remain', async (t) => {
  const state = fixture(t)
  state.week = [1, 2, 3, 4].map((id) => ({ song: { id }, playCount: '0' }))
  state.all = [1, 2, 3, 4].map((id) => ({ song: { id }, playCount: id === 2 ? 10 : 0 }))
  state.popularity = new Map([[1, 90], [2, 100], [3, 0], [4, 0]])
  state.added = new Map([[1, BASE], [2, BASE], [3, BASE + 2000]])
  const plan = await preview(options('combined'))
  assert.deepEqual(plan.orderedTrackIds, [2, 1, 3, 4, 5])
  assert.deepEqual(plan.tracks.map((track) => sorter.resolveCombinedSortBasis(track.metrics).rule),
    ['popularity', 'plays-all', 'added', null, null])
  assert.equal(plan.knownCount, 3)
  assert.equal(plan.missingCount, 2)
  assert.deepEqual(plan.tracks[3].metrics, { 'plays-week': 0, 'plays-all': 0, popularity: 0, added: null })
  const html = renderSortPreview(plan)
  assert.match(html, /有排序数据 3 首，无可用指标 2 首/)
  assert.match(html, /最近一周听歌次数：0 次/)
  assert.match(html, /第 5 部分 · 无可用指标，保持原相对顺序：2 首/)
  assert.doesNotMatch(html, /四项数据均未知|0 属于已知数据|第 1 部分 · 最近一周听歌次数：0 次/)
  const outcome = await service.executePlaylistSort(plan)
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.membershipPreserved, true)
  assert.deepEqual(state.writes, [{ pid: SOURCE, op: 'update', ids: [2, 1, 3, 4, 5] }])
})

test('combined sort preserves a separately counted cloud song across metadata batches and one full write', async (t) => {
  const cloudId = 401910689
  const ids = [...Array.from({ length: 260 }, (_, i) => i + 1), cloudId]
  const state = fixture(t, ids)
  state.count = 260
  state.cloudCount = 1
  state.week = []
  state.all = []
  state.added.clear()
  state.popularity.clear()
  for (let id = 1; id <= 260; id++) {
    if (id % 5 === 1) state.week.push({ song: { id }, playCount: id })
    else if (id % 5 === 2) state.all.push({ song: { id }, playCount: id })
    else if (id % 5 === 3) state.popularity.set(id, id % 101)
    else if (id % 5 === 4) state.added.set(id, BASE + id)
  }
  const plan = await preview(options('combined'))
  assert.equal(plan.orderedTrackIds.length, 261)
  assert.equal(new Set(plan.orderedTrackIds).size, 261)
  assert.deepEqual(plan.orderedTrackIds.slice(-53), [...ids.filter((id) => id <= 260 && id % 5 === 0), cloudId])
  assert.deepEqual(state.requests.filter((request) => request.path === '/api/v3/song/detail').map((request) => JSON.parse(request.params.get('c')).length), [200, 61])
  const outcome = await service.executePlaylistSort(plan)
  assert.equal(outcome.status, 'completed')
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].ids.length, 261)
  assert.deepEqual([...state.writes[0].ids].sort((a, b) => a - b), ids)
})

for (const failedMetric of ['week', 'all', 'popularity']) {
  test('combined preview does not silently treat a failed ' + failedMetric + ' request as all-unknown data', async (t) => {
    const state = combinedFixture(t)
    if (failedMetric === 'popularity') state.onSongs = () => ({ code: 403, message: '指标读取失败' })
    else state.onRecord = (period) => period === (failedMetric === 'week' ? 1 : 0) ? { code: 403, message: '指标读取失败' } : undefined
    await assert.rejects(preview(options('combined')), /指标读取失败/)
    assert.equal(state.writes.length, 0)
  })
}

test('tampered combined timestamps, effective values, result order and missing members are rejected before requests', async (t) => {
  const state = combinedFixture(t)
  const plan = await preview(options('combined'))
  const originalRequests = state.requests.length
  const alteredTracks = plan.tracks.map((track) => ({ ...track, metrics: { ...track.metrics } }))
  alteredTracks[0].metrics.added = BASE
  for (const altered of [
    { ...plan, tracks: alteredTracks },
    { ...plan, tracks: plan.tracks.map((track, index) => index === 0 ? { ...track, value: 5 } : track) },
    { ...plan, orderedTrackIds: [...plan.orderedTrackIds].reverse() },
    { ...plan, orderedTrackIds: plan.orderedTrackIds.slice(1) },
    { ...plan, tracks: plan.tracks.slice(1) },
  ]) await assert.rejects(service.executePlaylistSort(altered))
  assert.equal(state.requests.length, originalRequests)
  assert.equal(state.writes.length, 0)
})

test('a playlist change after combined preview prevents the write instead of discarding the extra song', async (t) => {
  const state = combinedFixture(t)
  const plan = await preview(options('combined'))
  state.playlists.get(SOURCE).trackIds.push(999)
  const outcome = await service.executePlaylistSort(plan)
  assert.equal(outcome.status, 'stopped')
  assert.equal(state.writes.length, 0)
  assert.ok(state.playlists.get(SOURCE).trackIds.includes(999))
})

test('combined write readback detects missing members and never retries or reports success', async (t) => {
  const state = combinedFixture(t)
  state.onWrite = (write) => { state.apply(write); state.playlists.get(SOURCE).trackIds.pop(); return { code: 200 } }
  const outcome = await service.executePlaylistSort(await preview(options('combined')))
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.membershipPreserved, false)
  assert.equal(outcome.orderVerified, false)
  assert.equal(state.writes.length, 1)
})

test('combined preview shows five groups, their counts, actual metric values and all four underlying values', async (t) => {
  combinedFixture(t)
  const html = renderSortPreview(await preview(options('combined')))
  assert.match(html, /第 1 部分 · 本人最近一周听歌排行次数：3 首/)
  assert.match(html, /第 2 部分 · 本人累计听歌排行次数：3 首/)
  assert.match(html, /第 3 部分 · 平台歌曲热度：3 首/)
  assert.match(html, /第 4 部分 · 加入歌单的时间：4 首/)
  assert.match(html, /第 5 部分 · 无可用指标，保持原相对顺序：2 首/)
  assert.match(html, /第 1 部分 · 最近一周听歌次数：2 次/)
  assert.match(html, /第 2 部分 · 累计听歌次数：80 次/)
  assert.match(html, /第 3 部分 · 平台热度：100 \/ 100/)
  assert.match(html, /第 4 部分 · 加入时间：[0-9]/)
  assert.match(html, /查看四项排序数据/)
  assert.doesNotMatch(html, />排序方向</)
  assert.doesNotMatch(html, />缺少排序数据的歌曲</)
})

test('sort validation rejects unsupported month, prototype names and malformed policy values', () => {
  for (const value of [
    options('plays-month'), options('__proto__'), options('constructor'), options('toString'),
    options('added', 'other'), options('added', 'desc', 'zero'), null,
  ]) assert.throws(() => sorter.sortPlaylistTracks(tracks([1, 2]), value))
})

test('sort validation rejects duplicate members, bad positions and invalid metric values', () => {
  for (const [value, rule] of [[-1, 'popularity'], [101, 'popularity'], [NaN, 'popularity'],
    [Infinity, 'popularity'], ['100', 'popularity'], [0, 'added'], [1.5, 'added'], [1.5, 'plays-all']]) {
    assert.throws(() => sorter.sortPlaylistTracks(tracks([value]), options(rule)))
  }
  assert.throws(() => sorter.sortPlaylistTracks([{ ...tracks([1])[0], originalPosition: 3 }], options()))
  assert.throws(() => sorter.sortPlaylistTracks([tracks([1])[0], tracks([2])[0]], options()))
})

test('sort snapshot reads member at values instead of treating current sequence as chronology', async (t) => {
  const state = fixture(t)
  state.added.set(4, 0)
  const snapshot = await api.getPlaylistSortSnapshotChecked(SOURCE)
  assert.deepEqual(snapshot.addedTimes, [BASE + 1000, BASE + 5000, BASE + 5000, null, BASE + 3000])
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.addedTimes))
  assert.equal(state.writes.length, 0)
})

test('snapshot retains valid cloud counts and leaves unavailable cloud statistics unknown', async (t) => {
  const state = fixture(t)
  for (const count of [0, 1, 261]) {
    state.cloudCount = count
    assert.equal((await api.getPlaylistSortSnapshotChecked(SOURCE)).cloudTrackCount, count)
  }
  for (const count of [undefined, null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    state.cloudCount = count
    assert.equal((await api.getPlaylistSortSnapshotChecked(SOURCE)).cloudTrackCount, null)
  }
  assert.equal(state.writes.length, 0)
})

test('invalid or absent joined timestamps remain unknown rather than fabricated', async (t) => {
  const state = fixture(t)
  for (const value of [0, -1, '1700000000000', 1.5, 8640000000000001, null]) {
    state.added.set(1, value)
    assert.equal((await api.getPlaylistSortSnapshotChecked(SOURCE)).addedTimes[0], null)
  }
})

test('popularity API uses pop, keeps zero, ignores non-requested songs and rejects duplicate IDs', async (t) => {
  const state = fixture(t)
  let rows = await api.getPlaylistSortSongsChecked([1, 4, 5])
  assert.deepEqual(rows.map((row) => row.popularity), [20, null, 0])
  state.onSongs = () => ({ code: 200, songs: [{ id: 1, pop: 90 }, { id: 999, pop: 99 }] })
  assert.deepEqual((await api.getPlaylistSortSongsChecked([1])).map((row) => row.songId), [1])
  state.onSongs = () => ({ code: 200, songs: [{ id: 1, pop: 90 }, { id: 1, pop: 10 }] })
  await assert.rejects(api.getPlaylistSortSongsChecked([1]), /重复/)
})

test('popularity rejects invalid request sizes, IDs and non-success responses without writes', async (t) => {
  const state = fixture(t)
  for (const ids of [[0], [1, 1], Array.from({ length: 201 }, (_, i) => i + 1)]) {
    await assert.rejects(api.getPlaylistSortSongsChecked(ids))
  }
  assert.deepEqual(await api.getPlaylistSortSongsChecked([]), [])
  state.onSongs = () => ({ code: 403 })
  await assert.rejects(api.getPlaylistSortSongsChecked([1]))
  state.onSongs = () => ({ code: 200 })
  await assert.rejects(api.getPlaylistSortSongsChecked([1]))
  assert.equal(state.writes.length, 0)
})

test('personal counts select exact all/week field; score-only records never become counts', async (t) => {
  const state = fixture(t)
  const all = await api.getPlaylistSortPlayCountsChecked(USER, 'all')
  assert.equal(all.find((row) => row.songId === 4).playCount, null)
  assert.equal(all.find((row) => row.songId === 4).unavailableReason, 'score-only')
  assert.equal(all.find((row) => row.songId === 5).playCount, 0)
  assert.equal(all.find((row) => row.songId === 5).unavailableReason, null)
  assert.deepEqual((await api.getPlaylistSortPlayCountsChecked(USER, 'week')).map((row) => row.playCount), [5, 2])
  assert.deepEqual(state.requests.filter((request) => request.path === '/api/v1/play/record').map((request) => request.params.get('type')),
    ['0', '1'])
  state.onRecord = () => ({ code: 200, allData: state.all })
  await assert.rejects(api.getPlaylistSortPlayCountsChecked(USER, 'week'), /所选时间范围/)
})

test('personal counts reject duplicate or invalid IDs, hidden data, and unsupported periods', async (t) => {
  const state = fixture(t)
  await assert.rejects(api.getPlaylistSortPlayCountsChecked(USER, 'month'))
  await assert.rejects(api.getPlaylistSortPlayCountsChecked(0, 'all'))
  for (const records of [
    [{ song: { id: 1 }, playCount: 1 }, { song: { id: 1 }, playCount: 5 }],
    [{ song: { id: 0 }, playCount: 1 }], [{}], [null],
  ]) {
    state.onRecord = () => ({ code: 200, allData: records })
    await assert.rejects(api.getPlaylistSortPlayCountsChecked(USER, 'all'))
  }
  state.onRecord = () => ({ code: 403, message: '没有权限' })
  await assert.rejects(api.getPlaylistSortPlayCountsChecked(USER, 'all'), /没有权限/)
})

test('plain integer count strings are accepted while malformed counts and score-only records remain unknown', async (t) => {
  const state = fixture(t)
  const valid = ['12', '0', ' 1234 ', 0, 50]
  const invalid = ['', ' ', '12次', '12.5', '-1', '1e2', '0x10', 1.5, -1, true, [], {}, '9007199254740992']
  state.all = [...valid, ...invalid, null, undefined].map((playCount, index) => ({ song: { id: index + 1 }, playCount }))
  const records = await api.getPlaylistSortPlayCountsChecked(USER, 'all')
  assert.deepEqual(records.slice(0, valid.length).map((row) => row.playCount), [12, 0, 1234, 0, 50])
  assert.ok(records.slice(0, valid.length).every((row) => row.unavailableReason === null))
  assert.ok(records.slice(valid.length).every((row) => row.playCount === null))
  assert.ok(records.slice(valid.length, -2).every((row) => row.unavailableReason === 'invalid'))
  assert.ok(records.slice(-2).every((row) => row.unavailableReason === 'missing'))
})

test('order API rejects every non-permutation and skips unchanged or empty order', async (t) => {
  const state = fixture(t)
  for (const ids of [[1, 2], [1, 2, 3, 4, 999], [1, 2, 3, 4, 4], [0, 2, 3, 4, 5]]) {
    await assert.rejects(api.updatePlaylistTrackOrderChecked(SOURCE, [1, 2, 3, 4, 5], ids))
  }
  await assert.rejects(api.updatePlaylistTrackOrderChecked(0, [], []))
  await api.updatePlaylistTrackOrderChecked(SOURCE, [1, 2, 3], [1, 2, 3])
  await api.updatePlaylistTrackOrderChecked(SOURCE, [], [])
  assert.equal(state.requests.length, 0)
})

test('added-time preview is readonly, frozen and retains every song', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  assert.deepEqual(plan.orderedTrackIds, [2, 3, 5, 1, 4])
  assert.equal(plan.knownCount, 4)
  assert.equal(plan.missingCount, 1)
  assert.equal(plan.changedCount, 5)
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.tracks) && Object.isFrozen(plan.tracks[0].artists) &&
    Object.isFrozen(plan.options) && Object.isFrozen(plan.orderedTrackIds))
  assert.equal(state.writes.length, 0)
})

test('popularity preview uses platform values and stable ties, without changing members', async (t) => {
  fixture(t)
  const plan = await preview(options('popularity'))
  assert.deepEqual(plan.orderedTrackIds, [2, 3, 1, 5, 4])
  assert.equal(plan.tracks[4].value, 0)
  assert.equal(plan.tracks[3].value, null)
})

test('all-time listening preview ranks only returned personal counts, not score or missing-as-zero', async (t) => {
  fixture(t)
  const plan = await preview(options('plays-all'))
  assert.deepEqual(plan.orderedTrackIds, [3, 1, 5, 2, 4])
  assert.equal(plan.knownCount, 3)
  assert.equal(plan.tracks.find((track) => track.songId === 4).value, null)
  assert.match(plan.tracks.find((track) => track.songId === 4).missingReason, /只返回排行分数/)
  assert.match(plan.tracks.find((track) => track.songId === 2).missingReason, /未出现在本次返回的累计听歌排行中/)
  assert.equal(plan.tracks.find((track) => track.songId === 5).missingReason, undefined)
  assert.deepEqual(plan.playCountSummary, { returnedCount: 5, usableCount: 4, matchedCount: 4 })
  assert.ok(Object.isFrozen(plan.playCountSummary))
})

test('string counts actually reorder the playlist instead of silently treating every count as unknown', async (t) => {
  const state = fixture(t)
  state.all = [{ song: { id: 1 }, playCount: '2' }, { song: { id: 2 }, playCount: '12' }, { song: { id: 3 }, playCount: '0' }]
  const plan = await preview(options('plays-all'))
  assert.deepEqual(plan.orderedTrackIds, [2, 1, 3, 4, 5])
  assert.equal(plan.knownCount, 3)
  assert.deepEqual(plan.tracks.slice(0, 3).map((track) => track.value), [2, 12, 0])
  assert.equal(state.writes.length, 0)
})

test('preview distinguishes an empty ranking, unmatched songs, score-only records and invalid counts', async (t) => {
  const state = fixture(t)
  state.all = []
  let plan = await preview(options('plays-all'))
  assert.deepEqual(plan.playCountSummary, { returnedCount: 0, usableCount: 0, matchedCount: 0 })
  state.all = [{ song: { id: 99 }, playCount: 80 }]
  plan = await preview(options('plays-all'))
  assert.deepEqual(plan.playCountSummary, { returnedCount: 1, usableCount: 1, matchedCount: 0 })
  assert.ok(plan.tracks.every((track) => track.value === null && track.missingReason.includes('未出现在')))
  state.all = [{ song: { id: 1 }, score: 90 }, { song: { id: 2 } }, { song: { id: 3 }, playCount: -5 }]
  plan = await preview(options('plays-all'))
  assert.deepEqual(plan.playCountSummary, { returnedCount: 3, usableCount: 0, matchedCount: 3 })
  assert.match(plan.tracks[0].missingReason, /只返回排行分数/)
  assert.match(plan.tracks[1].missingReason, /未返回听歌次数/)
  assert.match(plan.tracks[2].missingReason, /不是有效的非负整数/)
  assert.deepEqual(plan.orderedTrackIds, [1, 2, 3, 4, 5])
  assert.equal(plan.changedCount, 0)
  assert.equal((await service.executePlaylistSort(plan)).status, 'completed')
  assert.equal(state.writes.length, 0)
})

function renderSortPreview(plan) {
  const states = [SOURCE, plan.options, plan, null, null, 50, false]
  let cursor = 0
  const page = loadSource('src/panel/pages/PlaylistSort.tsx', {
    react: { useState: () => [states[cursor++], () => {}] }, 'react/jsx-runtime': jsxRuntime,
    '@/services/playlist-sort': service, '@/utils/playlist-sort': sorter,
    '../hooks/use-playlist-tools': {
      usePlaylistList: () => ({ playlists: [{ id: SOURCE, name: '测试歌单', creator: { userId: USER }, trackCount: plan.tracks.length }], loading: false, error: null }),
      usePlaylistOperation: () => ({ busy: false, busyRef: { current: false }, error: null }),
    },
  })
  return renderToStaticMarkup(page.PlaylistSort({ uid: USER, onBack: () => {}, onBusyChange: () => {} }))
}

test('each preview row shows its explicit sorting metric and distinguishes unknown from zero', async (t) => {
  fixture(t)
  const all = renderSortPreview(await preview(options('plays-all')))
  assert.match(all, /累计听歌次数：10 次/)
  assert.match(all, /累计听歌次数：0 次/)
  assert.match(all, /累计听歌次数：未知/)
  assert.match(all, /只返回排行分数，未提供听歌次数/)
  assert.match(all, /听歌排行返回 5 首/)
  assert.match(all, /与当前歌单匹配 4 首/)
  assert.match(renderSortPreview(await preview(options('plays-week'))), /最近一周听歌次数：5 次/)
  assert.match(renderSortPreview(await preview(options('popularity'))), /平台热度：100 \/ 100/)
  const added = renderSortPreview(await preview())
  assert.match(added, /加入时间：[0-9]/)
  assert.match(added, /加入时间：未知/)
})

test('no-op preview explains absent data instead of implying that all songs have equal counts', async (t) => {
  const state = fixture(t)
  state.all = []
  assert.match(renderSortPreview(await preview(options('plays-all'))), /平台本次返回的听歌排行为空/)
  state.all = [{ song: { id: 99 }, playCount: 80 }]
  assert.match(renderSortPreview(await preview(options('plays-all'))), /均未出现在本次返回的排行中/)
  state.all = [{ song: { id: 1 }, score: 80 }]
  const html = renderSortPreview(await preview(options('plays-all')))
  assert.match(html, /有歌曲上榜，但均缺少有效的听歌次数/)
  assert.match(html, /没有可用的排序数据，当前顺序保留，不执行写入/)
  assert.doesNotMatch(html, /累计听歌次数：80 次/)
  assert.match(html, /disabled="">确认将此顺序写入歌单/)
})

test('weekly personal counts are independent from all-time and may keep unknown slots', async (t) => {
  const state = fixture(t)
  state.week = [{ song: { id: 1 }, playCount: 2 }, { song: { id: 3 }, playCount: 8 }]
  const plan = await preview(options('plays-week', 'desc', 'keep'))
  assert.deepEqual(plan.orderedTrackIds, [3, 2, 1, 4, 5])
  assert.equal(plan.knownCount, 2)
})

test('empty and entirely unknown datasets preserve order and cause no writes', async (t) => {
  const state = fixture(t)
  state.all = []
  let plan = await preview(options('plays-all'))
  assert.equal(plan.changedCount, 0)
  assert.equal(plan.knownCount, 0)
  assert.equal((await service.executePlaylistSort(plan)).status, 'completed')
  state.playlists.get(SOURCE).trackIds = []
  plan = await preview()
  assert.equal(plan.tracks.length, 0)
  assert.equal((await service.executePlaylistSort(plan)).status, 'completed')
  assert.equal(state.writes.length, 0)
})

test('only owned playlists may be sorted and invalid accounts fail before requests', async (t) => {
  const state = fixture(t)
  await assert.rejects(service.previewPlaylistSort(0, SOURCE, options()))
  assert.equal(state.requests.length, 0)
  await assert.rejects(service.previewPlaylistSort(USER, COLLECTED, options()), /本人自建/)
  assert.equal(state.writes.length, 0)
})

test('260 reported songs plus one cloud song sort all 261 IDs and verify complete readback', async (t) => {
  const cloudId = 401910689
  const regularIds = Array.from({ length: 260 }, (_, index) => index + 1)
  const ids = [...regularIds, cloudId]
  const state = fixture(t, ids)
  state.count = 260
  state.cloudCount = 1
  for (const id of regularIds) state.added.set(id, BASE + id)
  // 云盘条目即使没有详情和排序指标，也必须原样保留在提交及回读成员中。
  state.onSongs = (requested) => ({ code: 200, songs: requested.filter((id) => id !== cloudId).map((id) => ({ id, name: '歌曲' + id })) })
  const plan = await preview()
  assert.equal(plan.playlist.reportedTrackCount, 260)
  assert.equal(plan.playlist.cloudTrackCount, 1)
  assert.equal(plan.tracks.length, 261)
  assert.equal(plan.missingCount, 1)
  assert.equal(plan.tracks.find((track) => track.songId === cloudId).name, '')
  assert.equal(state.writes.length, 0)
  const result = await service.executePlaylistSort(plan)
  assert.equal(result.status, 'completed')
  assert.equal(result.membershipPreserved, true)
  assert.equal(result.orderVerified, true)
  assert.equal(result.currentTrackCount, 261)
  assert.equal(state.writes.length, 1)
  assert.deepEqual(state.writes[0].ids, [...regularIds].reverse().concat(cloudId))
  assert.deepEqual([...state.playlists.get(SOURCE).trackIds].sort((a, b) => a - b), ids)
  assert.deepEqual(state.playlists.get(OTHER).trackIds, [9, 8])
})

test('reported totals that already include cloud songs are accepted without double counting', async (t) => {
  const state = fixture(t)
  state.count = 5
  state.cloudCount = 1
  const plan = await preview()
  assert.equal(plan.tracks.length, 5)
  const result = await service.executePlaylistSort(plan)
  assert.equal(result.status, 'completed')
  assert.equal(result.membershipPreserved, true)
  assert.equal(state.writes[0].ids.length, 5)
})

test('a playlist containing only separately counted cloud songs preserves every member', async (t) => {
  const state = fixture(t)
  state.count = 0
  state.cloudCount = 5
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'completed')
  assert.equal(result.membershipPreserved, true)
  assert.equal(state.writes[0].ids.length, 5)
})

test('cloud counts cannot excuse incomplete IDs, partial extras or invalid count metadata', async (t) => {
  const state = fixture(t)
  for (const [count, cloudCount] of [
    [6, 1], [4, 2], [4, 0], [4, undefined], [4, null], [4, '1'], [4, -1], [4, 1.5],
  ]) {
    state.count = count
    state.cloudCount = cloudCount
    await assert.rejects(preview(), /数量差异无法由云盘统计解释/)
  }
  assert.equal(state.writes.length, 0)
})

test('unexplained count mismatches in either direction block full-list sorting before writes', async (t) => {
  const state = fixture(t)
  for (const count of [4, 6]) {
    state.count = count
    await assert.rejects(preview(), /排序需提交完整成员/)
  }
  assert.equal(state.writes.length, 0)
})

test('malformed member IDs and missing playlist fields do not produce a sortable plan', async (t) => {
  const state = fixture(t)
  for (const ids of [[1, 1], [0, 2], [1.5], [null]]) {
    state.onRead = () => ({ code: 200, playlist: {
      id: SOURCE, name: '测试', creator: { userId: USER }, trackCount: ids.length, trackIds: ids.map((id) => ({ id })),
    } })
    await assert.rejects(preview())
  }
  state.onRead = () => ({ code: 200 })
  await assert.rejects(preview())
  assert.equal(state.writes.length, 0)
})

test('missing metadata retains IDs for time sorting, while failed popularity reads block that rule', async (t) => {
  const state = fixture(t)
  state.onSongs = () => { throw new Error('details unavailable') }
  const plan = await preview()
  assert.equal(plan.tracks.length, 5)
  assert.ok(plan.tracks.every((track) => !track.name))
  assert.deepEqual(plan.orderedTrackIds, [2, 3, 5, 1, 4])
  await assert.rejects(preview(options('popularity')), /details unavailable/)
  assert.equal(state.writes.length, 0)
})

test('single missing popularity detail stays in playlist as unknown', async (t) => {
  const state = fixture(t)
  state.onSongs = () => ({ code: 200, songs: [{ id: 3, name: '三', pop: 95 }, { id: 1, pop: 10 }] })
  const plan = await preview(options('popularity'))
  assert.equal(plan.tracks.length, 5)
  assert.deepEqual(plan.orderedTrackIds, [3, 1, 2, 4, 5])
  assert.equal(plan.missingCount, 3)
})

test('private or malformed personal record response fails preview instead of sorting fake zeros', async (t) => {
  const state = fixture(t)
  state.onRecord = () => ({ code: 403, message: '访问受限' })
  await assert.rejects(preview(options('plays-all')), /访问受限/)
  assert.equal(state.writes.length, 0)
})

test('execution submits one full permutation and verifies member preservation and exact order', async (t) => {
  const state = fixture(t)
  const originalOthers = [...state.playlists.get(OTHER).trackIds]
  const plan = await preview()
  const result = await service.executePlaylistSort(plan)
  assert.equal(result.status, 'completed')
  assert.equal(result.membershipPreserved, true)
  assert.equal(result.orderVerified, true)
  assert.equal(state.writes.length, 1)
  assert.deepEqual(state.writes[0], { pid: SOURCE, op: 'update', ids: [2, 3, 5, 1, 4] })
  assert.deepEqual(state.playlists.get(OTHER).trackIds, originalOthers)
  assert.equal(state.playlists.get(SOURCE).trackIds.length, 5)
})

test('more than 200 members fetch in batches but update once with the complete order', async (t) => {
  const ids = Array.from({ length: 451 }, (_, index) => index + 1)
  const state = fixture(t, ids)
  for (const id of ids) state.added.set(id, BASE + id)
  const plan = await preview()
  const result = await service.executePlaylistSort(plan)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.requests.filter((request) => request.path === '/api/v3/song/detail')
    .map((request) => JSON.parse(request.params.get('c')).length), [200, 200, 51])
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].ids.length, 451)
  assert.deepEqual(state.writes[0].ids, [...ids].reverse())
})

for (const change of ['order', 'membership', 'name', 'owner', 'timestamp', 'count', 'account']) {
  test('changed ' + change + ' since preview stops without writing', async (t) => {
    const state = fixture(t)
    const plan = await preview()
    const playlist = state.playlists.get(SOURCE)
    if (change === 'order') playlist.trackIds.reverse()
    if (change === 'membership') playlist.trackIds.push(99)
    if (change === 'name') playlist.name = '已改名'
    if (change === 'owner') playlist.creatorId = 88
    if (change === 'timestamp') state.added.set(1, BASE + 10000)
    if (change === 'count') state.count = 99
    if (change === 'account') state.userId = 88
    const result = await service.executePlaylistSort(plan)
    assert.equal(result.status, 'stopped')
    assert.equal(state.writes.length, 0)
  })
}

test('last account check immediately before update blocks a changed login', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  let checks = 0
  state.onAccount = () => ({ code: 200, profile: { userId: ++checks >= 2 ? 88 : USER } })
  const result = await service.executePlaylistSort(plan)
  assert.equal(result.status, 'stopped')
  assert.equal(state.writes.length, 0)
})

test('tampered plans cannot submit subsets, supersets, duplicates, wrong sort or wrong coverage counts', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  const originalRequestCount = state.requests.length
  for (const orderedTrackIds of [[1, 2], [2, 3, 5, 1, 999], [2, 3, 5, 1, 1], [1, 2, 3, 4, 5]]) {
    await assert.rejects(service.executePlaylistSort({ ...plan, orderedTrackIds }))
  }
  await assert.rejects(service.executePlaylistSort({ ...plan, knownCount: 5 }))
  await assert.rejects(service.executePlaylistSort({ ...plan, options: options('plays-month') }))
  await assert.rejects(service.executePlaylistSort({ ...plan, tracks: plan.tracks.slice(1) }))
  assert.equal(state.requests.length, originalRequestCount)
  assert.equal(state.writes.length, 0)
})

test('concurrent execution is locked and changes to caller objects cannot alter the frozen plan', async (t) => {
  const state = fixture(t)
  const original = await preview()
  const mutable = {
    ...original, options: { ...original.options }, tracks: original.tracks.map((track) => ({ ...track, artists: [...track.artists] })),
    playlist: { ...original.playlist, trackIds: [...original.playlist.trackIds], addedTimes: [...original.playlist.addedTimes] },
    orderedTrackIds: [...original.orderedTrackIds],
  }
  let release
  const pause = new Promise((resolve) => { release = resolve })
  state.onAccount = async () => { await pause }
  const running = service.executePlaylistSort(mutable)
  mutable.options.direction = 'asc'
  mutable.orderedTrackIds.reverse()
  mutable.playlist.trackIds.length = 0
  mutable.tracks[0].value = 999
  await assert.rejects(service.executePlaylistSort(original), /正在执行/)
  release()
  assert.equal((await running).status, 'completed')
  assert.deepEqual(state.writes[0].ids, [2, 3, 5, 1, 4])
})

test('business failure is not a successful sort and never triggers retries or rebuilding', async (t) => {
  const state = fixture(t)
  state.onWrite = () => ({ code: 403, message: '禁止排序' })
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, true)
  assert.equal(result.orderVerified, false)
  assert.equal(state.writes.length, 1)
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [1, 2, 3, 4, 5])
})

test('lost update response reads actual order without retrying even when it applied', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply(write); throw new Error('response lost') }
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.orderVerified, true)
  assert.equal(result.membershipPreserved, true)
  assert.match(result.message, /回读顺序已符合预览/)
  assert.equal(state.writes.length, 1)
})

test('success response without applying order fails verification and is not retried', async (t) => {
  const state = fixture(t)
  state.onWrite = () => ({ code: 200 })
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, true)
  assert.equal(result.orderVerified, false)
  assert.equal(state.writes.length, 1)
})

test('unexpected member changes after update are reported without rollback or deleting others', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply(write); state.playlists.get(SOURCE).trackIds[0] = 999; return { code: 200 } }
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, false)
  assert.equal(result.orderVerified, false)
  assert.equal(state.writes.length, 1)
})

test('unreadable post-update state stays unknown instead of success', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    state.apply(write)
    state.onRead = () => { throw new Error('unreadable') }
    throw new Error('unknown write')
  }
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, null)
  assert.equal(result.orderVerified, null)
  assert.equal(result.currentTrackCount, null)
  assert.equal(state.writes.length, 1)
})

test('unknown account after successful update does not claim verified completion', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    state.apply(write)
    state.onAccount = () => { throw new Error('account unavailable') }
    return { code: 200 }
  }
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.orderVerified, true)
  assert.equal(result.accountVerified, null)
})

test('post-update count mismatch leaves completeness and order unknown rather than verified', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply(write); state.count = 6; return { code: 200 } }
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, null)
  assert.equal(result.orderVerified, null)
  assert.match(result.message, /完整成员和顺序未能核验/)
  assert.equal(state.writes.length, 1)
})

test('a cloud member disappearing before execution stops even if the count now matches the display', async (t) => {
  const state = fixture(t)
  state.count = 4
  state.cloudCount = 1
  const plan = await preview()
  state.playlists.get(SOURCE).trackIds.pop()
  const result = await service.executePlaylistSort(plan)
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, false)
  assert.equal(state.writes.length, 0)
})

test('a lost cloud member after update is a membership change despite matching the displayed count', async (t) => {
  const state = fixture(t)
  state.count = 4
  state.cloudCount = 1
  state.onWrite = (write) => {
    state.apply(write)
    state.playlists.get(SOURCE).trackIds = write.ids.filter((id) => id !== 5)
    return { code: 200 }
  }
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, false)
  assert.equal(result.orderVerified, false)
  assert.equal(state.writes.length, 1)
})

test('cloud count evidence must remain available before writing a count-mismatched playlist', async (t) => {
  const state = fixture(t)
  state.count = 4
  state.cloudCount = 1
  const plan = await preview()
  state.cloudCount = undefined
  const result = await service.executePlaylistSort(plan)
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, null)
  assert.equal(state.writes.length, 0)
})

test('missing cloud count evidence during readback leaves completion unknown', async (t) => {
  const state = fixture(t)
  state.count = 4
  state.cloudCount = 1
  state.onWrite = (write) => { state.apply(write); state.cloudCount = undefined; return { code: 200 } }
  const result = await service.executePlaylistSort(await preview())
  assert.equal(result.status, 'stopped')
  assert.equal(result.membershipPreserved, null)
  assert.equal(result.orderVerified, null)
  assert.match(result.message, /平台云盘统计 未知 首/)
  assert.equal(state.writes.length, 1)
})

test('fresh preview after successful sorting is idempotent and performs no further writes', async (t) => {
  const state = fixture(t)
  await service.executePlaylistSort(await preview())
  const plan = await preview()
  assert.equal(plan.changedCount, 0)
  const result = await service.executePlaylistSort(plan)
  assert.equal(result.status, 'completed')
  assert.equal(state.writes.length, 1)
})
