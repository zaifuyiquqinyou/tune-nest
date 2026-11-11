import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

// 执行真实源码，所有账号、歌单写入、AI 和存储均由测试替身接管。
function loadSource(path, imports = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
    fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.ok(name in imports, 'Unexpected runtime import: ' + name)
    return imports[name]
  }, module, module.exports)
  return module.exports
}

const rules = loadSource('src/classifier/playlist-organizer.ts')
const ai = loadSource('src/classifier/organize-ai.ts')
const preferences = loadSource('src/utils/organize-preferences.ts', { '@/classifier/playlist-organizer': rules })
const api = loadSource('src/api/netease-direct.ts')
const service = loadSource('src/services/playlist-organize.ts', {
  '@/api/netease-direct': api, '@/classifier/playlist-organizer': rules,
})
const USER = 7, SOURCE = 101, B = 202, C = 203, COLLECTED = 303
const song = (id = 1, overrides = {}) => ({
  id, name: '歌曲' + id, artists: ['歌手'], album: '专辑', durationMs: 180000, detailsAvailable: true, ...overrides,
})
const playlist = (id, name, owner = USER) => ({
  id, name, trackCount: 0, coverImgUrl: '', creator: { userId: owner, nickname: '' },
})
const profile = (id, name, tracks = []) => ({
  snapshot: { id, name, creatorId: USER, reportedTrackCount: tracks.length, trackIds: tracks.map((track) => track.id) },
  tracks,
})
const recommend = (track, profiles, savedRules = [], decisions = []) =>
  rules.recommendExistingPlaylists([track], profiles, savedRules, decisions)[0]
const include = { mode: 'include', playlistIds: [B, C] }
const assignment = (songId, targetPlaylistIds = [B, C]) => ({ songId, targetPlaylistIds })

function fixture(t, { source = [1, 2, 3, 4], b = [2, 9, 8], c = [7, 6] } = {}) {
  const old = { fetch: globalThis.fetch, document: globalThis.document, setTimeout: globalThis.setTimeout }
  const state = {
    userId: USER, requests: [], writes: [], events: [], counts: new Map(),
    onRead: null, onWrite: null, onSongs: null, onAccount: null,
    playlists: new Map([
      [SOURCE, { id: SOURCE, name: '未分类', creatorId: USER, trackIds: [...source] }],
      [B, { id: B, name: '日系', creatorId: USER, trackIds: [...b] }],
      [C, { id: C, name: 'ACG', creatorId: USER, trackIds: [...c] }],
      [COLLECTED, { id: COLLECTED, name: '收藏', creatorId: 99, trackIds: [55] }],
    ]),
  }
  state.apply = (write) => {
    const target = state.playlists.get(write.pid)
    target.trackIds = write.op === 'add'
      ? [...write.trackIds.filter((id) => !target.trackIds.includes(id)), ...target.trackIds]
      : target.trackIds.filter((id) => !write.trackIds.includes(id))
  }
  state.detail = (id) => {
    const target = state.playlists.get(id)
    if (!target) return { code: 404 }
    return { code: 200, playlist: {
      id, name: target.name, creator: { userId: target.creatorId },
      trackCount: state.counts.get(id) ?? target.trackIds.length, trackIds: target.trackIds.map((id) => ({ id })),
    } }
  }
  const response = (body) => new Response(JSON.stringify(body), { status: 200 })
  globalThis.document = { cookie: '__csrf=mock' }
  globalThis.setTimeout = (callback, delay, ...args) => old.setTimeout(callback, delay === 500 ? 0 : delay, ...args)
  globalThis.fetch = async (input, options) => {
    const path = new URL(input).pathname
    const params = new URLSearchParams(options.body)
    state.requests.push({ path, params })
    assert.equal(options.credentials, 'include')
    if (path === '/api/w/nuser/account/get') {
      const override = state.onAccount ? await state.onAccount() : undefined
      return response(override ?? { code: 200, profile: { userId: state.userId } })
    }
    if (path === '/api/user/playlist') return response({
      code: 200, more: false,
      playlist: [...state.playlists.values()].map((item) => playlist(item.id, item.name, item.creatorId)),
    })
    if (path === '/api/v6/playlist/detail') {
      const id = Number(params.get('id'))
      state.events.push({ kind: 'read', id })
      const override = state.onRead ? await state.onRead(id) : undefined
      return response(override ?? state.detail(id))
    }
    if (path === '/api/v3/song/detail') {
      const ids = JSON.parse(params.get('c')).map((item) => item.id)
      assert.ok(ids.length <= 200)
      const override = state.onSongs ? await state.onSongs(ids) : undefined
      return response(override ?? { code: 200, songs: ids.map((id) => ({
        id, name: '歌曲' + id, ar: [{ id: 1, name: '歌手' }], al: { id: 1, name: '专辑' }, dt: 180000,
      })) })
    }
    assert.equal(path, '/api/playlist/manipulate/tracks', 'Unexpected real request: ' + path)
    const write = { pid: Number(params.get('pid')), op: params.get('op'), trackIds: JSON.parse(params.get('trackIds')) }
    assert.ok(write.trackIds.length > 0 && write.trackIds.length <= 100)
    assert.equal(new Set(write.trackIds).size, write.trackIds.length)
    assert.ok(write.op === 'add' && [B, C].includes(write.pid) || write.op === 'del' && write.pid === SOURCE,
      'Only targets may receive adds; only source may receive deletes')
    state.writes.push(write)
    state.events.push({ kind: 'write', ...write })
    const override = state.onWrite ? await state.onWrite(write, state.writes.length) : undefined
    if (override !== undefined) return response(override)
    state.apply(write)
    return response({ code: 200 })
  }
  t.after(() => {
    globalThis.fetch = old.fetch
    globalThis.setTimeout = old.setTimeout
    if (old.document === undefined) delete globalThis.document
    else globalThis.document = old.document
  })
  return state
}

const preview = (scope = include) => service.previewPlaylistOrganize(USER, SOURCE, scope)
const noDeletes = (state) => assert.ok(state.writes.every((write) => write.op !== 'del'))

test('include and exclude resolve equivalent owned targets; source always excluded', () => {
  const lists = [playlist(SOURCE, '未分类'), playlist(B, '日系'), playlist(C, 'ACG'), playlist(COLLECTED, '收藏', 99)]
  const included = rules.resolveOrganizeTargets(USER, SOURCE, lists, { mode: 'include', playlistIds: [SOURCE, B] })
  const excluded = rules.resolveOrganizeTargets(USER, SOURCE, lists, { mode: 'exclude', playlistIds: [C] })
  assert.deepEqual(included.map((item) => item.id), [B])
  assert.deepEqual(excluded, included)
  assert.equal(rules.isOrganizeTargetAllowed({ mode: 'exclude', playlistIds: [] }, SOURCE, SOURCE), false)
})

test('invalid include scope and collected or missing source are rejected; obsolete exclusions remain harmless', () => {
  const lists = [playlist(SOURCE, '来源'), playlist(B, '目标'), playlist(COLLECTED, '收藏', 99)]
  for (const scope of [
    { mode: 'include', playlistIds: [999] }, { mode: 'include', playlistIds: [COLLECTED] },
    { mode: 'include', playlistIds: [B, B] }, { mode: 'other', playlistIds: [] },
    { mode: 'exclude', playlistIds: [0] },
  ]) assert.throws(() => rules.resolveOrganizeTargets(USER, SOURCE, lists, scope))
  assert.throws(() => rules.resolveOrganizeTargets(USER, COLLECTED, lists, include))
  assert.deepEqual(rules.resolveOrganizeTargets(USER, SOURCE, lists, { mode: 'exclude', playlistIds: [999] }).map((p) => p.id), [B])
})

test('initial exclusions identify transient playlists without interpreting AC as ACG', () => {
  const lists = ['最近', '未分类', '我喜欢的音乐', '你喜欢的歌曲重新上架', 'AC', 'ACG', '曾经流行'].map((name, i) => playlist(i + 1, name))
  assert.deepEqual(rules.defaultOrganizeExclusions(lists), [1, 2, 3, 4])
})

test('same song ID may select several targets without requiring metadata', () => {
  const result = recommend(song(1, { detailsAvailable: false, name: '' }),
    [profile(B, '日系', [song(1)]), profile(C, 'ACG', [song(1)])])
  assert.equal(result.candidates.length, 2)
  assert.ok(result.candidates.every((candidate) => candidate.certain))
})

test('only exact, allowed historical decisions and user rules can default to chosen destinations', () => {
  const result = recommend(song(1, { artists: ['董真'] }), [profile(B, '贞惜有你')],
    [{ id: 'a', kind: 'artist', value: '董真', targetPlaylistId: B },
      { id: 'b', kind: 'text', value: '歌曲', targetPlaylistId: C }],
    [assignment(1, [B, C]), assignment(2, [B])])
  assert.deepEqual(result.candidates.map((item) => item.playlistId), [B])
  assert.equal(result.candidates[0].certain, true)
})

test('rules use exact artist or album and literal keywords; malformed or empty matches are rejected', () => {
  for (const value of ['', ' ', '歌']) {
    assert.throws(() => recommend(song(1), [profile(B, '目标')], [{ id: 'a', kind: 'artist', value, targetPlaylistId: B }]))
  }
  const target = [profile(B, '目标')]
  const artistRule = [{ id: 'a', kind: 'artist', value: '歌手甲', targetPlaylistId: B }]
  assert.equal(recommend(song(1, { artists: ['歌手甲'] }), target, artistRule).candidates[0].certain, true)
  assert.equal(recommend(song(1, { artists: ['歌手甲乙'] }), target, artistRule).candidates.length, 0)
  const albumRule = [{ id: 'b', kind: 'album', value: '专辑甲', targetPlaylistId: B }]
  assert.equal(recommend(song(1, { album: '专辑甲' }), target, albumRule).candidates[0].certain, true)
  assert.equal(recommend(song(1, { album: '专辑甲乙' }), target, albumRule).candidates.length, 0)
  const textRule = [{ id: 'c', kind: 'text', value: 'a.*', targetPlaylistId: B }]
  assert.equal(recommend(song(1, { name: 'a.* 字面量' }), target, textRule).candidates[0].certain, true)
  assert.equal(recommend(song(1, { name: 'abc' }), target, textRule).candidates.length, 0)
})

test('ambiguous same artist and album produce unchecked suggestions; other versions are not duplicates', () => {
  const result = recommend(song(1), [profile(B, '日系', [song(2), song(3)]),
    profile(C, 'ACG', [song(9, { name: '歌曲1', durationMs: 220000 })])])
  assert.equal(result.candidates.length, 2)
  assert.ok(result.candidates.every((candidate) => !candidate.certain))
  assert.match(result.warning, /不同 ID/)
})

test('unknown genre, script and artist nationality do not force assignments', () => {
  for (const artists of [['EGOIST'], ['Perfume'], ['Rammstein'], ['群星']]) {
    assert.deepEqual(recommend(song(1, { name: '不明作品', album: '原声', artists }),
      [profile(B, 'ACG'), profile(C, '英语')]).candidates, [])
  }
})

test('clear works and exact artist names support multiple categories without inferring vocal language', () => {
  const result = recommend(song(1, { name: 'κrOnё', artists: ['澤野弘之'], album: 'ギルティクラウン OST' }),
    [profile(B, '罪恶王冠'), profile(C, '泽野弘之'), profile(204, '日系')])
  assert.deepEqual(result.candidates.map((candidate) => candidate.playlistId), [B, C])
  assert.ok(result.candidates.every((candidate) => candidate.certain))
  const animation = recommend(song(2, { album: 'TVアニメ 世界一初恋 オリジナルサウンドトラック' }),
    [profile(B, 'ACG'), profile(C, '日系')])
  assert.deepEqual(animation.candidates.map((candidate) => candidate.playlistId), [B])
})

test('AC refers to explicit Assassin Creed works; unrelated substring and generic soundtrack do not match', () => {
  const profiles = [profile(B, 'AC'), profile(C, 'ACG')]
  assert.equal(recommend(song(1, { album: "Assassin's Creed Original Soundtrack" }), profiles).candidates[0].playlistId, B)
  assert.deepEqual(recommend(song(1, { album: 'Generic original soundtrack', name: 'JX30' }), profiles).candidates, [])
  assert.deepEqual(recommend(song(1, { album: 'JX30' }), [profile(B, '剑网三')]).candidates, [])
})

test('short Chinese work aliases and style labels do not match incidental word fragments', () => {
  const targets = [profile(B, '古剑'), profile(C, '古风')]
  assert.deepEqual(recommend(song(1, { name: '远古剑客', album: '中国风景' }), targets).candidates, [])
  assert.deepEqual(recommend(song(1, { name: '剑仙剑客', album: '自制作品' }), [profile(B, '仙剑')]).candidates, [])
  for (const album of ['古剑2 原声带', '古剑奇谭二', '【古剑】同人曲']) {
    assert.equal(recommend(song(1, { album }), targets).candidates.find((item) => item.playlistId === B).certain, true)
  }
  assert.equal(recommend(song(1, { album: '【诛仙】同人曲' }), [profile(B, '诛仙')]).candidates[0].certain, true)
  assert.equal(recommend(song(1, { album: '【国风】原创' }), targets).candidates.find((item) => item.playlistId === C).certain, true)
})

test('missing metadata never triggers artist, album or keyword rules', () => {
  assert.deepEqual(recommend(song(1, { detailsAvailable: false }), [profile(B, '歌手', [song(2), song(3)])],
    [{ id: 'a', kind: 'text', value: '歌曲', targetPlaylistId: B }]).candidates, [])
})

test('arbitrary playlist names cannot read inherited work aliases', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(recommend(song(1), [profile(B, name)]).candidates, [])
  }
})

test('preview is readonly, frozen and uses actual IDs despite statistical mismatch', async (t) => {
  const state = fixture(t)
  state.counts.set(SOURCE, 99)
  const plan = await preview()
  assert.equal(state.writes.length, 0)
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.scope.playlistIds) && Object.isFrozen(plan.targets))
  assert.equal(plan.tracks.length, 4)
  assert.equal(plan.warnings.length, 1)
  assert.equal(plan.recommendations.find((item) => item.songId === 2).candidates.find((item) => item.playlistId === B).certain, true)
})

test('preview missing details retains IDs and does not force suggestions', async (t) => {
  const state = fixture(t)
  state.onSongs = () => ({ code: 200, songs: [] })
  const plan = await preview()
  assert.equal(plan.tracks.length, 4)
  assert.ok(plan.tracks.every((track) => !track.detailsAvailable))
  assert.equal(plan.recommendations.find((item) => item.songId === 1).candidates.length, 0)
})

test('preview excludes all blocked targets from metadata, rules and remembered choices', async (t) => {
  fixture(t)
  const plan = await service.previewPlaylistOrganize(USER, SOURCE, { mode: 'exclude', playlistIds: [C] },
    [{ id: 'a', kind: 'text', value: '歌曲', targetPlaylistId: C }], [assignment(1, [C])])
  assert.deepEqual(plan.targets.map((target) => target.id), [B])
  assert.ok(plan.recommendations.every((item) => item.candidates.every((candidate) => candidate.playlistId !== C)))
})

test('multi-destination move adds and verifies all targets before first source deletion', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  const result = await service.executePlaylistOrganize(plan, [assignment(1), assignment(2, [B])], true)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [3, 4])
  assert.deepEqual(state.playlists.get(B).trackIds, [1, 2, 9, 8])
  assert.deepEqual(state.playlists.get(C).trackIds, [1, 7, 6])
  assert.deepEqual(state.writes.map((write) => [write.op, write.pid]), [['add', B], ['add', C], ['del', SOURCE]])
  const firstDelete = state.events.findIndex((event) => event.kind === 'write' && event.op === 'del')
  for (const targetId of [B, C]) {
    const addIndex = state.events.findIndex((event) => event.kind === 'write' && event.pid === targetId)
    assert.ok(state.events.slice(addIndex + 1, firstDelete).some((event) => event.kind === 'read' && event.id === targetId))
  }
  assert.ok(result.targets.every((target) => target.originalPreserved && target.verified))
  assert.equal(result.leftUntouchedCount, 2)
})

test('copy-only preserves full source and manual assignments are permitted only within scope', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  const result = await service.executePlaylistOrganize(plan, [assignment(1, [C])], false)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [1, 2, 3, 4])
  assert.equal(result.removedCount, 0)
  noDeletes(state)
})

test('song already present in all selected targets is removed only from source', async (t) => {
  const state = fixture(t, { b: [1, 9], c: [1, 8] })
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1)], true)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.writes.map((write) => write.op), ['del'])
  assert.deepEqual(state.playlists.get(B).trackIds, [1, 9])
})

test('failure at a later target preserves entire source and successful earlier additions', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => write.pid === C ? { code: 502, message: 'blocked' } : undefined
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1)], true)
  assert.equal(result.status, 'stopped')
  noDeletes(state)
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [1, 2, 3, 4])
  assert.ok(state.playlists.get(B).trackIds.includes(1))
  assert.equal(state.writes.length, 2)
})

test('partial success response cannot permit source removal', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    if (write.pid === C) { state.apply({ ...write, trackIds: [1] }); return { code: 200 } }
  }
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1), assignment(3)], true)
  assert.equal(result.status, 'stopped')
  noDeletes(state)
  assert.equal(result.targets.find((target) => target.id === C).missingCount, 1)
})

test('lost add response is not retried, and actual added counts are read back', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply(write); throw new Error('connection lost') }
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1)], true)
  assert.equal(result.status, 'stopped')
  assert.equal(state.writes.length, 1)
  assert.equal(result.targets.find((target) => target.id === B).addedCount, 1)
  noDeletes(state)
})

test('target reorder or unrelated additions after add stop all source removal', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    state.apply(write)
    state.playlists.get(write.pid).trackIds.reverse()
    return { code: 200 }
  }
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1)], true)
  assert.equal(result.status, 'stopped')
  assert.equal(result.targets[0].originalPreserved, false)
  noDeletes(state)
})

for (const changed of ['source', 'target', 'account', 'name', 'owner']) {
  test('stale ' + changed + ' is detected before any writes', async (t) => {
    const state = fixture(t)
    const plan = await preview()
    if (changed === 'source') state.playlists.get(SOURCE).trackIds.push(90)
    if (changed === 'target') state.playlists.get(C).trackIds.reverse()
    if (changed === 'account') state.userId = 88
    if (changed === 'name') state.playlists.get(B).name = '已改名'
    if (changed === 'owner') state.playlists.get(B).creatorId = 88
    const result = await service.executePlaylistOrganize(plan, [assignment(1)], true)
    assert.equal(result.status, 'stopped')
    assert.equal(state.writes.length, 0)
  })
}

test('source changes while adding are detected before removals', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    state.apply(write)
    state.playlists.get(SOURCE).trackIds.push(99)
    return { code: 200 }
  }
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1)], true)
  assert.equal(result.status, 'stopped')
  noDeletes(state)
  assert.equal(result.sourceVerified, false)
})

test('any target change between additions and deletion prevents deletion', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    if (write.pid === C) {
      state.apply(write)
      state.playlists.get(B).trackIds.push(99)
      return { code: 200 }
    }
  }
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1)], true)
  assert.equal(result.status, 'stopped')
  noDeletes(state)
})

test('invalid assignment IDs, blocked targets, duplicates and source as target never write', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  for (const assignments of [[], [assignment(999)], [assignment(1, [SOURCE])], [assignment(1, [COLLECTED])],
    [assignment(1, [])], [assignment(1, [B, B])], [assignment(1), assignment(1)]]) {
    await assert.rejects(service.executePlaylistOrganize(plan, assignments, true))
  }
  await assert.rejects(service.executePlaylistOrganize({ ...plan, scope: { mode: 'exclude', playlistIds: [C] } }, [assignment(1)], true))
  assert.equal(state.writes.length, 0)
})

test('more than 100 songs are batched and no deletion occurs until all destinations complete', async (t) => {
  const ids = Array.from({ length: 205 }, (_, i) => i + 1)
  const state = fixture(t, { source: [...ids, 999], b: [], c: [] })
  const result = await service.executePlaylistOrganize(await preview(), ids.map((id) => assignment(id)), true)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.writes.map((write) => write.trackIds.length), [100, 100, 5, 100, 100, 5, 100, 100, 5])
  assert.deepEqual(state.writes.map((write) => write.op), ['add', 'add', 'add', 'add', 'add', 'add', 'del', 'del', 'del'])
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [999])
})

test('lost delete response stops remaining batches without retrying and reports actual removed count', async (t) => {
  const ids = Array.from({ length: 105 }, (_, i) => i + 1)
  const state = fixture(t, { source: ids, b: ids, c: ids })
  state.onWrite = (write) => { state.apply(write); throw new Error('lost response') }
  const result = await service.executePlaylistOrganize(await preview(), ids.map((id) => assignment(id)), true)
  assert.equal(result.status, 'stopped')
  assert.equal(result.removedCount, 100)
  assert.equal(state.writes.length, 1)
})

test('read failures after unknown writes are reported as null rather than success', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  state.onWrite = (write) => {
    state.apply(write)
    state.onRead = () => { throw new Error('unreadable') }
    throw new Error('unknown outcome')
  }
  const result = await service.executePlaylistOrganize(plan, [assignment(1)], true)
  assert.equal(result.status, 'stopped')
  assert.equal(result.sourceVerified, null)
  assert.equal(result.removedCount, null)
  assert.ok(result.targets.every((target) => target.verified === null && target.addedCount === null))
})

test('concurrent execution is locked and caller mutations after start do not widen assignments', async (t) => {
  const state = fixture(t)
  const plan = await preview()
  let release
  const paused = new Promise((resolve) => { release = resolve })
  state.onAccount = async () => { await paused }
  const assignments = [assignment(1, [B])]
  const running = service.executePlaylistOrganize(plan, assignments, true)
  assignments[0].targetPlaylistIds.push(C)
  assignments.push(assignment(2))
  await assert.rejects(service.executePlaylistOrganize(plan, [assignment(3)], true), /正在执行/)
  release()
  const result = await running
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.writes.map((write) => write.pid), [B, SOURCE])
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [2, 3, 4])
})

test('fresh preview resumes safe partial additions without adding them again', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => write.pid === C ? { code: 503 } : undefined
  await service.executePlaylistOrganize(await preview(), [assignment(1)], true)
  state.onWrite = null
  state.writes.length = 0
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1)], true)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.writes.map((write) => [write.op, write.pid]), [['add', C], ['del', SOURCE]])
})

test('preferences are account isolated, preserve both scope lists, and reject malformed saved decisions', async (t) => {
  const oldChrome = globalThis.chrome
  const storage = {}
  globalThis.chrome = { storage: { local: {
    get: async (key) => ({ [key]: storage[key] }), set: async (values) => Object.assign(storage, structuredClone(values)),
  } } }
  t.after(() => { if (oldChrome === undefined) delete globalThis.chrome; else globalThis.chrome = oldChrome })
  const saved = { version: 1, sourceId: SOURCE, mode: 'exclude', includedIds: [B], excludedIds: [C], rules: [], decisions: [assignment(1, [B])] }
  await preferences.saveOrganizePreferences(USER, saved)
  assert.deepEqual(await preferences.loadOrganizePreferences(USER), saved)
  assert.equal(await preferences.loadOrganizePreferences(88), null)
  storage.tn_organize_preferences_7.decisions = [assignment(1, [B, B])]
  await assert.rejects(preferences.loadOrganizePreferences(USER))
  await assert.rejects(preferences.saveOrganizePreferences(0, saved))
})

const aiInput = () => ({ songs: [song(1)], targets: [{ id: B, name: 'ACG', examples: [] }] })

test('AI permits abstention and multiple valid targets but rejects unknown IDs, duplicate rows and malformed data', () => {
  const input = aiInput()
  assert.deepEqual(ai.validateOrganizeAIOutput([], input), [])
  assert.equal(ai.validateOrganizeAIOutput([{ songId: 1, targetPlaylistIds: [], reason: '依据不足' }], input).length, 1)
  for (const invalid of [
    [{ songId: 9, targetPlaylistIds: [B], reason: '未知歌曲' }],
    [{ songId: 1, targetPlaylistIds: [C], reason: '禁止目标' }],
    [{ songId: 1, targetPlaylistIds: [B, B], reason: '重复' }],
    [{ songId: 1, targetPlaylistIds: [B], reason: '' }], {},
    [{ songId: 1, targetPlaylistIds: [B], reason: 'a' }, { songId: 1, targetPlaylistIds: [B], reason: 'b' }],
  ]) assert.throws(() => ai.validateOrganizeAIOutput(invalid, input))
  assert.throws(() => ai.validateOrganizeAIInput({ ...input, songs: [song(1, { detailsAvailable: false })] }))
})

test('AI uses only configured endpoint, sanitizes payload, returns suggestions without writes and handles network failures', async (t) => {
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, 'https://api.deepseek.com/chat/completions')
    const payload = JSON.parse(options.body)
    assert.equal(payload.response_format.type, 'json_object')
    assert.ok(!options.body.includes('secret-key'))
    assert.ok(payload.messages[0].content.includes('必须返回空数组'))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      suggestions: [{ songId: 1, targetPlaylistIds: [B], reason: '动画作品' }],
    }) } }] }), { status: 200 })
  }
  assert.equal((await ai.suggestExistingPlaylists(aiInput(), 'secret-key'))[0].targetPlaylistIds[0], B)
  assert.equal(calls, 1)
  await assert.rejects(ai.suggestExistingPlaylists(aiInput(), ''), /API Key/)
  assert.equal(calls, 1)
  globalThis.fetch = async () => new Response('error', { status: 429 })
  await assert.rejects(ai.suggestExistingPlaylists(aiInput(), 'key'), /HTTP 429/)
})

test('AI rejects hallucinated target IDs and invalid JSON without automatic retry', async (t) => {
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  for (const content of ['not JSON', JSON.stringify({ suggestions: [{ songId: 1, targetPlaylistIds: [C], reason: 'guess' }] })]) {
    let count = 0
    globalThis.fetch = async () => {
      count++
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
    }
    await assert.rejects(ai.suggestExistingPlaylists(aiInput(), 'key'))
    assert.equal(count, 1)
  }
})

test('AI timeout aborts without retrying requests', async (t) => {
  const oldFetch = globalThis.fetch
  const oldTimer = globalThis.setTimeout
  t.after(() => { globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimer })
  globalThis.setTimeout = (callback, delay) => oldTimer(callback, delay === 30000 ? 1 : delay)
  let count = 0
  globalThis.fetch = async (_url, options) => {
    count++
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  }
  await assert.rejects(ai.suggestExistingPlaylists(aiInput(), 'key'), /超时/)
  assert.equal(count, 1)
})
