import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

// 执行真实源码，所有账号、歌单写入、AI 和存储均由测试替身接管。
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

const rules = loadSource('src/classifier/playlist-organizer.ts')
const ai = loadSource('src/classifier/organize-ai.ts')
const preferences = loadSource('src/utils/organize-preferences.ts', { '@/classifier/playlist-organizer': rules })
const api = loadSource('src/api/netease-direct.ts')
const mutations = loadSource('src/services/playlist-track-mutation.ts', { '@/api/netease-direct': api })
const drafts = loadSource('src/utils/organize-draft.ts')
const service = loadSource('src/services/playlist-organize.ts', {
  '@/services/playlist-track-mutation': mutations,
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

// 参考歌曲分布在多个专辑，便于区分稳定偏好和仅一张专辑的偶然重合。
const artistHistory = (count, offset = 10, artist = '歌手甲') => Array.from({ length: count }, (_, index) =>
  song(offset + index, { artists: [artist], album: '历史专辑' + index % 3 }))
const defaultIds = (recommendation) => recommendation.candidates.filter((candidate) => candidate.defaultSelected)
  .map((candidate) => candidate.playlistId)
const newArtistSong = () => song(1, { artists: ['歌手甲'], album: '新专辑' })

test('strong artist history leads weak options and selection does not depend on playlist input order', () => {
  const weak = profile(B, '日系', artistHistory(2, 100))
  const strong = profile(C, '古风', artistHistory(11))
  const first = recommend(newArtistSong(), [weak, strong])
  const reversed = recommend(newArtistSong(), [strong, weak])
  assert.deepEqual(first, reversed)
  assert.equal(first.candidates[0].playlistId, C)
  assert.ok(first.candidates[0].score >= 75)
  assert.equal(first.candidates[0].certain, false)
  assert.deepEqual(defaultIds(first), [C])
  assert.match(first.selectionReason, /领先次选/)
  assert.ok(Object.isFrozen(first.candidates[0]))
})

test('equal or closely ranked strong destinations stay unchecked even if one is first', () => {
  const history = artistHistory(10)
  for (const other of [history, history.slice(0, 9)]) {
    const result = recommend(newArtistSong(), [profile(B, '古风', history), profile(C, '日系', other)])
    assert.ok(result.candidates[0].score >= 75)
    assert.deepEqual(defaultIds(result), [])
    assert.match(result.selectionReason, /推荐分接近/)
  }
})

test('a lone candidate still needs enough samples and diverse releases', () => {
  for (const history of [artistHistory(2), artistHistory(7), artistHistory(10).map((track) => ({ ...track, album: '唯一专辑' }))]) {
    const result = recommend(newArtistSong(), [profile(B, '古风', history)])
    assert.equal(result.candidates.length, 1)
    assert.deepEqual(defaultIds(result), [])
  }
  assert.deepEqual(defaultIds(recommend(newArtistSong(), [profile(B, '古风', artistHistory(8))])), [B])
})

test('artist-only evidence must cover every credited collaborator rather than a single guest', () => {
  const result = recommend(song(1, { artists: ['歌手甲', '歌手乙'], album: '新专辑' }),
    [profile(B, '古风', [...artistHistory(10), ...artistHistory(1, 100, '歌手乙')])])
  assert.ok(result.candidates[0].score >= 75)
  assert.deepEqual(defaultIds(result), [])
})

test('shared songs across target playlists are counted once in reference concentration', () => {
  const history = artistHistory(10)
  const result = recommend(newArtistSong(), [profile(B, '古风', history), profile(C, '日系', history.slice(0, 8))])
  assert.equal(result.candidates[0].score, 85)
  assert.equal(result.candidates[1].score, 68)
  assert.deepEqual(defaultIds(result), [B])
})

test('strong album history can suggest a newcomer without requiring the same artist', () => {
  const history = Array.from({ length: 4 }, (_, index) => song(index + 10, { artists: ['歌手' + index], album: '共同专辑' }))
  const result = recommend(song(1, { artists: ['新人'], album: '共同专辑' }), [profile(B, 'ACG', history)])
  assert.deepEqual(defaultIds(result), [B])
  assert.equal(result.candidates[0].certain, false)
  assert.match(result.candidates[0].reason, /同专辑/)
})

test('work history connects different albums without assuming the current song is an existing ID', () => {
  const history = Array.from({ length: 4 }, (_, index) => song(index + 10, { artists: ['演奏者' + index], album: '古剑奇谭 作品集' + index }))
  const result = recommend(song(1, { artists: ['新人'], album: '古剑奇谭 新录音' }), [profile(B, 'ACG', history)])
  assert.deepEqual(defaultIds(result), [B])
  assert.equal(result.candidates[0].certain, false)
  assert.match(result.candidates[0].reason, /同作品/)
})

test('an explicit soundtrack title connects original and translated suffixes for the same work', () => {
  const history = Array.from({ length: 4 }, (_, index) => song(index + 10, { artists: ['演奏者' + index], album: '天行九歌 OST' }))
  const result = recommend(song(1, { artists: ['新人'], album: '天行九歌 原声音乐' }), [profile(B, 'ACG', history)])
  assert.deepEqual(defaultIds(result), [B])
  assert.match(result.candidates[0].reason, /同作品/)
})

test('album and work evidence do not count the same two samples twice to force a selection', () => {
  const history = [song(10, { artists: ['甲'], album: '古剑奇谭 OST' }), song(11, { artists: ['乙'], album: '古剑奇谭 OST' })]
  const result = recommend(song(1, { artists: ['新人'], album: '古剑奇谭 OST' }), [profile(B, 'ACG', history)])
  assert.ok(result.candidates[0].score < 75)
  assert.deepEqual(defaultIds(result), [])
})

test('corroborating artist and album history may select one clear target with three distinct songs', () => {
  const history = artistHistory(3).map((track) => ({ ...track, album: '共同专辑' }))
  const result = recommend(song(1, { artists: ['歌手甲'], album: '共同专辑' }), [profile(B, 'ACG', history)])
  assert.deepEqual(defaultIds(result), [B])
  assert.match(result.candidates[0].reason, /同歌手.*同专辑/)
})

test('generic collections and generic artist names never produce strong album or artist defaults', () => {
  for (const album of ['热门精选', '原声', '专辑', 'Best compilation', 'Generic original soundtrack']) {
    const history = artistHistory(10).map((track) => ({ ...track, artists: ['群星'], album }))
    const result = recommend(song(1, { artists: ['群星'], album }), [profile(B, 'ACG', history)])
    assert.deepEqual(defaultIds(result), [])
  }
})

test('other versions remain unchecked despite a strong statistical lead', () => {
  const history = [...artistHistory(10), song(100, { name: '歌曲1', artists: ['歌手甲'], album: '新专辑' })]
  const result = recommend(newArtistSong(), [profile(B, '古风', history)])
  assert.ok(result.candidates[0].score >= 75)
  assert.deepEqual(defaultIds(result), [])
  assert.match(result.warning, /不同 ID/)
})

test('personal destinations, unsupported vocal language and unrelated works remain manual', () => {
  for (const name of ['曾经的歌', '最烦了', '最近', '英语', 'eng', '韩语', '剑网三']) {
    const result = recommend(newArtistSong(), [profile(B, name, artistHistory(10))])
    assert.equal(result.candidates.length, 1)
    assert.ok(result.candidates[0].score <= 50)
    assert.deepEqual(defaultIds(result), [])
  }
})

test('collaborations do not auto-select a playlist dedicated to another credited artist', () => {
  const history = artistHistory(10).map((track) => ({ ...track, artists: ['歌手甲', '玄觞'] }))
  const result = recommend(newArtistSong(), [profile(B, '玄觞', history)])
  assert.deepEqual(defaultIds(result), [])
  assert.match(result.candidates[0].reason, /其他歌手/)
})

test('explicit rules override inference restrictions and preserve all clear destinations', () => {
  const result = recommend(newArtistSong(), [profile(B, '古风', artistHistory(10)), profile(C, '最近'), profile(204, '歌手甲')],
    [{ id: 'manual', kind: 'artist', value: '歌手甲', targetPlaylistId: C }])
  assert.deepEqual(defaultIds(result), [C, 204])
  assert.ok(result.candidates.filter((candidate) => candidate.certain).every((candidate) => candidate.defaultSelected))
  assert.equal(result.candidates.find((candidate) => candidate.playlistId === B).defaultSelected, false)
})

test('missing reference details or incomplete member lists cannot create an artificial strong lead', () => {
  const strong = profile(B, '古风', artistHistory(10))
  const missing = profile(C, 'ACG', artistHistory(20, 100).map((track) => ({ ...track, detailsAvailable: false, name: '' })))
  assert.deepEqual(defaultIds(recommend(newArtistSong(), [strong, missing])), [])
  const incomplete = { ...strong, snapshot: { ...strong.snapshot, reportedTrackCount: 100 } }
  assert.deepEqual(defaultIds(recommend(newArtistSong(), [incomplete])), [])
  const exact = profile(204, '已有', [newArtistSong()])
  assert.deepEqual(defaultIds(recommend(newArtistSong(), [strong, missing, exact])), [204])
})

test('duplicate names or repeated IDs do not manufacture enough independent history', () => {
  const repeated = artistHistory(10).map((track) => ({ ...track, name: '同一录音' }))
  assert.deepEqual(defaultIds(recommend(newArtistSong(), [profile(B, '古风', repeated)])), [])
  assert.deepEqual(defaultIds(recommend(newArtistSong(), [profile(B, '古风', Array(10).fill(song(10, { artists: ['歌手甲'] })))])), [])
})

test('inferred preview stays readonly and only checked defaults move after target verification', async (t) => {
  const history = artistHistory(10)
  const state = fixture(t, { source: [1, 2], b: history.map((track) => track.id), c: [100, 101] })
  const details = new Map([newArtistSong(), song(2, { artists: ['独立歌手'], album: '其他专辑' }),
    ...history, song(100, { artists: ['其他人'] }), song(101, { artists: ['其他人'] })].map((track) => [track.id, track]))
  state.onSongs = (ids) => ({ code: 200, songs: ids.map((id) => {
    const track = details.get(id)
    return { id, name: track.name, ar: track.artists.map((name) => ({ name })), al: { name: track.album }, dt: track.durationMs }
  }) })
  const plan = await preview()
  assert.equal(state.writes.length, 0)
  const selected = plan.recommendations.map((recommendation) => ({ songId: recommendation.songId, targetPlaylistIds: defaultIds(recommendation) }))
    .filter((item) => item.targetPlaylistIds.length)
  assert.deepEqual(selected, [assignment(1, [B])])
  const result = await service.executePlaylistOrganize(plan, selected, true)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [2])
  assert.deepEqual(state.playlists.get(C).trackIds, [100, 101])
  assert.ok(state.playlists.get(B).trackIds.includes(1))
  assert.ok(state.events.slice(0, state.events.findIndex((event) => event.kind === 'write' && event.op === 'del'))
    .some((event) => event.kind === 'write' && event.pid === B && event.op === 'add'))
})

test('page preview checks inferred defaults, displays reasons and preserves manual and AI choices', async (t) => {
  const strong = profile(B, '古风', artistHistory(10))
  const other = profile(C, 'ACG')
  const tracks = [newArtistSong(), song(2, { artists: ['没有参考的歌手'], album: '无关联专辑' })]
  const plan = {
    userId: USER, scope: include, source: profile(SOURCE, '未分类', tracks).snapshot,
    tracks, targets: [strong.snapshot, other.snapshot], warnings: [],
    recommendations: rules.recommendExistingPlaylists(tracks, [strong, other]),
    aiTargets: [strong, other].map((p) => ({ id: p.snapshot.id, name: p.snapshot.name, examples: [] })),
  }
  const settings = { version: 1, sourceId: SOURCE, mode: 'include', includedIds: [B, C], excludedIds: [], rules: [], decisions: [] }
  const states = []
  const refs = []
  let cursor = 0, refCursor = 0, writes = 0, savedChoices = []
  // 用轻量状态容器执行真实页面回调和 JSX，账号接口仍由测试替身接管。
  const page = loadSource('src/panel/pages/PlaylistOrganize.tsx', {
    'react/jsx-runtime': jsxRuntime,
    react: {
      useEffect: () => {}, useRef: (initial) => {
        const index = refCursor++
        return refs[index] ||= { current: index === 0 ? USER : initial }
      },
      useState: (initial) => {
        const index = cursor++
        if (!(index in states)) states[index] = index === 1 ? settings : initial
        return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
    },
    '@/classifier/playlist-organizer': rules,
    '@/classifier/organize-ai': ai,
    '@/services/playlist-organize': { previewPlaylistOrganize: async () => plan, executePlaylistOrganize: async () => { writes++; throw new Error('模拟请求中断') } },
    '@/utils/organize-preferences': { saveOrganizePreferences: async () => {}, loadOrganizePreferences: async () => settings },
    '@/utils/organize-draft': { ...drafts, loadOrganizeDraft: async () => savedChoices, saveOrganizeDraft: async (_uid, _source, choices) => { savedChoices = structuredClone(choices) } },
    '../components/PlaylistFailures': { PlaylistFailures: () => null },
    '../hooks/use-playlist-tools': {
      usePlaylistList: () => ({ playlists: [playlist(SOURCE, '未分类'), playlist(B, '古风'), playlist(C, 'ACG')], loading: false, error: null, reload: () => {} }),
      usePlaylistOperation: () => ({ busy: false, busyRef: { current: false }, setError: () => {}, run: (work) => work() }),
    },
  })
  const render = () => { cursor = 0; refCursor = 0; return page.PlaylistOrganize({ uid: USER, onBack: () => {}, onBusyChange: () => {} }) }
  const nodes = (element) => Array.isArray(element) ? element.flatMap(nodes)
    : element && typeof element === 'object' && element.props ? [element, ...nodes(element.props.children)] : []
  const textOf = (element) => Array.isArray(element) ? element.map(textOf).join('')
    : element && typeof element === 'object' ? textOf(element.props?.children) : element == null ? '' : String(element)
  const findButton = (tree, label) => nodes(tree).find((node) => node.type === 'button' && textOf(node).includes(label))
  const card = (tree, id) => nodes(tree).find((node) => node.type === 'div' && node.key === String(id))
  const checkboxes = (tree, id) => nodes(card(tree, id)).filter((node) => node.type === 'input' && node.props.type === 'checkbox')
  await findButton(render(), '分析并预览归档建议').props.onClick()
  let tree = render()
  assert.equal(checkboxes(tree, 1)[0].props.checked, true)
  assert.match(textOf(card(tree, 1)), /首选建议.*推荐分/)
  assert.match(textOf(card(tree, 1)), /分析结论/)
  assert.equal(writes, 0)
  const oldChrome = globalThis.chrome
  t.after(() => { if (oldChrome === undefined) delete globalThis.chrome; else globalThis.chrome = oldChrome })
  globalThis.chrome = { runtime: { sendMessage: async () => ({ success: true, data: [{ songId: 2, targetPlaylistIds: [C], reason: '待确认的关联' }] }) } }
  await findButton(tree, 'AI 补充未选歌曲').props.onClick()
  tree = render()
  assert.equal(checkboxes(tree, 1)[0].props.checked, true)
  assert.equal(checkboxes(tree, 2)[0].props.checked, false)
  checkboxes(tree, 1)[0].props.onChange()
  assert.equal(checkboxes(render(), 1)[0].props.checked, false)
  checkboxes(render(), 2)[0].props.onChange()
  assert.equal(checkboxes(render(), 2)[0].props.checked, true)
  findButton(card(render(), 2), '保留原地').props.onClick()
  assert.equal(checkboxes(render(), 2)[0].props.checked, false)
  assert.equal(writes, 0)
  checkboxes(render(), 2)[0].props.onChange()
  await assert.rejects(findButton(render(), '确认归档并从来源移除').props.onClick(), /模拟请求中断/)
  assert.equal(writes, 1)
  assert.deepEqual(savedChoices, [assignment(1, []), assignment(2, [C])])
  await findButton(render(), '分析并预览归档建议').props.onClick()
  assert.equal(checkboxes(render(), 1)[0].props.checked, false, 'Explicit leave-in-place must survive preview')
  assert.equal(checkboxes(render(), 2)[0].props.checked, true, 'Manual destination must survive execution failure')
  states.length = 0
  refs.length = 0
  await findButton(render(), '分析并预览归档建议').props.onClick()
  assert.equal(checkboxes(render(), 1)[0].props.checked, false)
  assert.equal(checkboxes(render(), 2)[0].props.checked, true, 'Saved choice must survive page remount')
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

function organizePageFixture(t, count) {
  const tracks = Array.from({ length: count }, (_, i) => song(i + 1))
  const state = { plan: {
    userId: USER, source: profile(SOURCE, '未分类', tracks).snapshot, tracks,
    targets: [profile(B, 'ACG').snapshot, profile(C, '日系').snapshot], scope: include, warnings: [],
    recommendations: tracks.map((track) => ({ songId: track.id, candidates: [], selectionReason: '等待手工确认' })),
    aiTargets: [{ id: B, name: 'ACG', examples: [] }],
  }, execute: null, onAI: null, storage: {} }
  const settings = { version: 1, sourceId: SOURCE, mode: 'include', includedIds: [B, C], excludedIds: [], rules: [], decisions: [] }
  const oldChrome = globalThis.chrome
  globalThis.chrome = { storage: { local: {
    get: async (key) => ({ [key]: structuredClone(state.storage[key]) }),
    set: async (values) => Object.assign(state.storage, structuredClone(values)),
  } }, runtime: { sendMessage: async (input) => state.onAI(input) } }
  t.after(() => { globalThis.chrome = oldChrome })
  const states = [], refs = []
  let cursor = 0, refCursor = 0
  const page = loadSource('src/panel/pages/PlaylistOrganize.tsx', {
    'react/jsx-runtime': jsxRuntime,
    react: {
      useEffect: () => {}, useRef: (initial) => {
        const index = refCursor++
        return refs[index] ||= { current: index === 0 ? USER : initial }
      },
      useState: (initial) => {
        const index = cursor++
        if (!(index in states)) states[index] = index === 1 ? settings : initial
        return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
    },
    '@/classifier/playlist-organizer': rules, '@/classifier/organize-ai': ai,
    '@/services/playlist-organize': { previewPlaylistOrganize: async () => state.plan, executePlaylistOrganize: (...args) => state.execute(...args) },
    '@/utils/organize-preferences': { loadOrganizePreferences: async () => settings, saveOrganizePreferences: async () => {} },
    '@/utils/organize-draft': drafts, '../components/PlaylistFailures': { PlaylistFailures: () => null },
    '../hooks/use-playlist-tools': {
      usePlaylistList: () => ({ playlists: [playlist(SOURCE, '未分类'), playlist(B, 'ACG'), playlist(C, '日系')], loading: false, error: null, reload: () => {} }),
      usePlaylistOperation: () => ({ busy: false, busyRef: { current: false }, setError: () => {}, run: (work) => work() }),
    },
  })
  const render = () => { cursor = 0; refCursor = 0; return page.PlaylistOrganize({ uid: USER, onBack: () => {}, onBusyChange: () => {} }) }
  const nodes = (element) => Array.isArray(element) ? element.flatMap(nodes)
    : element && typeof element === 'object' && element.props ? [element, ...nodes(element.props.children)] : []
  const textOf = (element) => Array.isArray(element) ? element.map(textOf).join('')
    : element && typeof element === 'object' ? textOf(element.props?.children) : element == null ? '' : String(element)
  state.click = (label) => nodes(render()).find((node) => node.type === 'button' && textOf(node).includes(label)).props.onClick()
  state.choose = (songId, targetId) => nodes(render()).find((node) => node.type === 'select' && node.props['aria-label'] === '为歌曲 ' + songId + ' 添加归档去向')
    .props.onChange({ target: { value: String(targetId) } })
  state.card = (songId) => nodes(render()).find((node) => node.type === 'div' && node.key === String(songId))
  state.checked = (songId) => nodes(state.card(songId)).filter((node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked).length
  state.text = () => textOf(render())
  state.reload = () => { states.length = 0; refs.length = 0 }
  return state
}

test('partial execution persists 125 choices and only clears verified completed songs', async (t) => {
  const page = organizePageFixture(t, 125)
  await page.click('分析并预览归档建议')
  for (let id = 1; id <= 124; id++) page.choose(id, B)
  page.execute = async (_preview, assignments) => {
    assert.equal(assignments.length, 124)
    assert.equal((await drafts.loadOrganizeDraft(USER, SOURCE)).length, 125, 'Save choices before the first write')
    return { status: 'partial', completedSongIds: Array.from({ length: 123 }, (_, i) => i + 1),
      failedTracks: [{ songId: 124, playlistId: B, operation: 'add', message: '下架' }], targets: [],
      message: '跳过 1 首', removedCount: 123, sourceRemainingCount: 2, leftUntouchedCount: 1, sourceVerified: true }
  }
  await page.click('确认归档并从来源移除')
  const pending = await drafts.loadOrganizeDraft(USER, SOURCE)
  assert.deepEqual(pending.find((item) => item.songId === 124).targetPlaylistIds, [B])
  assert.ok(pending.filter((item) => item.songId !== 124).every((item) => item.targetPlaylistIds.length === 0))
  page.plan = { ...page.plan, tracks: page.plan.tracks.slice(123),
    source: { ...page.plan.source, trackIds: [124, 125] }, recommendations: page.plan.recommendations.slice(123) }
  page.reload()
  await page.click('分析并预览归档建议')
  assert.equal(page.checked(124), 1)
  assert.equal(page.checked(125), 0)
  assert.equal(page.card(1), undefined)
})

test('AI batch failure preserves manual choices, continues later songs and exposes failed IDs', async (t) => {
  const page = organizePageFixture(t, 22)
  await page.click('分析并预览归档建议')
  page.choose(22, C)
  const requests = []
  page.onAI = ({ data }) => {
    requests.push(data.songs.map((song) => song.id))
    return requests.length === 1 ? { success: false, error: '本批 JSON 无效' } : {
      success: true, data: data.songs.map((song) => ({ songId: song.id, targetPlaylistIds: [B], reason: '待确认建议' })),
    }
  }
  await page.click('AI 补充未选歌曲')
  assert.deepEqual(requests.map((ids) => ids.length), [10, 10, 1])
  assert.equal(page.checked(22), 1)
  assert.equal(page.checked(21), 0)
  assert.match(page.text(), /有 10 首未获得 AI 建议/)
  assert.match(page.text(), /ID 1：本批 JSON 无效/)
})

test('AI authentication failure does not repeatedly request remaining batches or clear selections', async (t) => {
  const page = organizePageFixture(t, 22)
  await page.click('分析并预览归档建议')
  page.choose(22, C)
  let calls = 0
  page.onAI = () => { calls++; return { success: false, error: 'DeepSeek 请求失败（HTTP 401）' } }
  await page.click('AI 补充未选歌曲')
  assert.equal(calls, 1)
  assert.equal(page.checked(22), 1)
  assert.match(page.text(), /有 21 首未获得 AI 建议/)
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

test('205-song multi-target move skips a delisted song in a later batch and completes all other songs', async (t) => {
  const ids = Array.from({ length: 205 }, (_, i) => i + 1)
  const state = fixture(t, { source: [...ids, 999], b: [700, 701], c: [800, 801] })
  state.onWrite = (write) => write.op === 'add' && write.pid === C && write.trackIds.includes(117)
    ? { code: 512, message: '下架歌曲无法收藏。' } : undefined
  const result = await service.executePlaylistOrganize(await preview(), ids.map((id) => assignment(id)), true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [117, 999])
  assert.equal(result.completedSongIds.length, 204)
  assert.equal(result.removedCount, 204)
  assert.deepEqual(result.failedTracks.map((item) => [item.songId, item.playlistId, item.operation]), [[117, C, 'add']])
  assert.ok(state.playlists.get(B).trackIds.includes(117), 'Successful destination must retain this song')
  assert.ok(!state.playlists.get(C).trackIds.includes(117))
  assert.deepEqual(state.playlists.get(B).trackIds.filter((id) => id >= 700), [700, 701])
  assert.deepEqual(state.playlists.get(C).trackIds.filter((id) => id >= 700), [800, 801])
  assert.ok(result.targets.every((target) => target.verified && target.originalPreserved))
  const successfulWrites = state.writes.filter((write) => write.op === 'add' && !(write.pid === C && write.trackIds.includes(117)))
  for (const pid of [B, C]) {
    const added = successfulWrites.filter((write) => write.pid === pid).flatMap((write) => write.trackIds)
    assert.equal(new Set(added).size, added.length, 'Verified additions must not be resubmitted')
  }
})

test('song-specific source deletion failure leaves that song and continues the remaining batches', async (t) => {
  const ids = Array.from({ length: 105 }, (_, i) => i + 1)
  const state = fixture(t, { source: ids, b: ids, c: ids })
  state.onWrite = (write) => write.op === 'del' && write.trackIds.includes(50)
    ? { code: 512, message: '该歌曲无法移除' } : undefined
  const result = await service.executePlaylistOrganize(await preview(), ids.map((id) => assignment(id)), true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [50])
  assert.equal(result.removedCount, 104)
  assert.deepEqual(result.failedTracks.map((item) => [item.songId, item.operation]), [[50, 'remove']])
  assert.deepEqual(state.playlists.get(B).trackIds, ids)
  assert.deepEqual(state.playlists.get(C).trackIds, ids)
})

test('business rejection after partial application never retries confirmed additions', async (t) => {
  const state = fixture(t, { source: [1, 2, 3, 4], b: [], c: [] })
  state.onWrite = (write) => {
    if (write.op === 'add' && write.trackIds.includes(2)) {
      state.apply({ ...write, trackIds: write.trackIds.filter((id) => id !== 2) })
      return { code: 512, message: '下架歌曲无法收藏' }
    }
  }
  const result = await service.executePlaylistOrganize(await preview(), [1, 2, 3, 4].map((id) => assignment(id, [B])), true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [2])
  assert.equal(state.writes.filter((write) => write.op === 'add').length, 1)
  assert.deepEqual(result.failedTracks.map((item) => item.songId), [2])
})

test('a delisted message does not hide account, permission, rate-limit or unknown failures', async (t) => {
  const state = fixture(t)
  for (const response of [
    { code: 301, message: '下架歌曲无法收藏，请登录' },
    { code: 403, message: '下架歌曲无法收藏' },
    { code: 429, message: '下架歌曲无法收藏，请求频繁' },
    { code: 500, message: '未知错误' },
  ]) {
    state.writes.length = 0
    state.onWrite = () => response
    const result = await service.executePlaylistOrganize(await preview(), [assignment(1), assignment(3)], true)
    assert.equal(result.status, 'stopped')
    assert.equal(state.writes.length, 1)
    assert.deepEqual(result.failedTracks, [])
    noDeletes(state)
  }
})

test('draft restores over 100 choices and explicit empty selections, filters stale IDs and isolates accounts', async (t) => {
  const oldChrome = globalThis.chrome
  const storage = {}
  globalThis.chrome = { storage: { local: {
    get: async (key) => ({ [key]: structuredClone(storage[key]) }),
    set: async (values) => Object.assign(storage, structuredClone(values)),
  } } }
  t.after(() => { globalThis.chrome = oldChrome })
  const choices = Array.from({ length: 125 }, (_, i) => assignment(i + 1, i === 50 ? [] : [B, C]))
  await drafts.saveOrganizeDraft(USER, SOURCE, choices)
  assert.deepEqual(await drafts.loadOrganizeDraft(USER, SOURCE), choices)
  assert.deepEqual(await drafts.loadOrganizeDraft(88, SOURCE), [])
  assert.deepEqual(await drafts.loadOrganizeDraft(USER, C), [])
  const remaining = choices.slice(1).map((item) => item.songId).concat(500)
  const plan = { targets: [{ id: B }], recommendations: remaining.map((songId) => ({ songId, candidates: [
    { playlistId: B, defaultSelected: true },
  ] })) }
  const restored = drafts.restoreOrganizeChoices(plan, await drafts.loadOrganizeDraft(USER, SOURCE))
  assert.equal(Object.keys(restored).length, 125)
  assert.equal(restored[1], undefined)
  assert.deepEqual(restored[2], [B])
  assert.deepEqual(restored[51], [])
  assert.deepEqual(restored[500], [B])
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

test('partial addition removes only songs confirmed in all targets and retains failed songs', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    if (write.pid === C) { state.apply({ ...write, trackIds: [1] }); return { code: 200 } }
  }
  const result = await service.executePlaylistOrganize(await preview(), [assignment(1), assignment(3)], true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(state.playlists.get(SOURCE).trackIds, [2, 3, 4])
  assert.deepEqual(result.completedSongIds, [1])
  assert.deepEqual(result.failedTracks.map((item) => item.songId), [3])
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
