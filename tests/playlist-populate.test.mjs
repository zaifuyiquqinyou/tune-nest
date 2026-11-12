import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import * as jsxRuntime from 'react/jsx-runtime'

// 使用真实 API 及服务源码，网络和计时全部由隔离替身接管。
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
const mutations = loadSource('src/services/playlist-track-mutation.ts', { '@/api/netease-direct': api })
const service = loadSource('src/services/playlist-populate.ts', {
  '@/api/netease-direct': api, '@/services/playlist-track-mutation': mutations,
})
const failures = loadSource('src/panel/components/PlaylistFailures.tsx', { 'react/jsx-runtime': jsxRuntime })
const USER = 7, TARGET = 101

function fixture(t, original = [9, 8]) {
  const old = { fetch: globalThis.fetch, document: globalThis.document, setTimeout: globalThis.setTimeout }
  const state = { userId: USER, name: '分类目标', owner: USER, ids: [...original], writes: [], creates: 0, onWrite: null, onRead: null, onCreate: null }
  state.apply = (write) => {
    state.ids = write.op === 'add' ? [...write.ids.filter((id) => !state.ids.includes(id)), ...state.ids]
      : state.ids.filter((id) => !write.ids.includes(id))
  }
  const respond = (body) => new Response(JSON.stringify(body), { status: 200 })
  globalThis.document = { cookie: '__csrf=mock' }
  globalThis.setTimeout = (callback, delay, ...args) => old.setTimeout(callback, delay === 500 || delay === 2000 ? 0 : delay, ...args)
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname
    const params = new URLSearchParams(options.body)
    if (path === '/api/w/nuser/account/get') return respond({ code: 200, profile: { userId: state.userId } })
    if (path === '/api/v6/playlist/detail') {
      assert.equal(Number(params.get('id')), TARGET)
      state.onRead?.()
      return respond({ code: 200, playlist: { id: TARGET, name: state.name, creator: { userId: state.owner },
        trackCount: state.ids.length, trackIds: state.ids.map((id) => ({ id })),
      } })
    }
    if (path === '/api/playlist/create') {
      state.creates++
      const override = state.onCreate ? await state.onCreate() : undefined
      return respond(override ?? { code: 200, id: TARGET })
    }
    assert.equal(path, '/api/playlist/manipulate/tracks', 'Unexpected network request')
    assert.equal(Number(params.get('pid')), TARGET)
    const write = { op: params.get('op'), ids: JSON.parse(params.get('trackIds')) }
    assert.ok(write.ids.length > 0 && write.ids.length <= 100)
    assert.ok(write.op === 'add' || write.op === 'del')
    state.writes.push(write)
    const override = state.onWrite ? await state.onWrite(write) : undefined
    if (override !== undefined) return respond(override)
    state.apply(write)
    return respond({ code: 200 })
  }
  t.after(() => Object.assign(globalThis, old))
  return state
}

test('replace verifies all new songs before deleting obsolete originals', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    if (write.op === 'del') assert.ok([1, 2, 3].every((id) => state.ids.includes(id)))
  }
  const result = await service.populatePlaylistChecked(USER, TARGET, [1, 2, 3], true)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.writes.map((write) => write.op), ['add', 'del'])
  assert.deepEqual(state.ids, [1, 2, 3])
})

test('replace with one delisted song preserves all old songs and adds all remaining new songs', async (t) => {
  const state = fixture(t)
  const ids = Array.from({ length: 105 }, (_, i) => i + 1000)
  state.onWrite = (write) => write.ids.includes(1050) ? { code: 512, message: '下架歌曲无法收藏' } : undefined
  const result = await service.populatePlaylistChecked(USER, TARGET, ids, true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.failedTracks.map((item) => item.songId), [1050])
  assert.match(result.message, /旧歌全部保留/)
  assert.ok(state.writes.every((write) => write.op === 'add'))
  assert.deepEqual(state.ids.filter((id) => id < 1000), [9, 8])
  assert.equal(state.ids.length, 106)
  assert.ok(state.ids.includes(1104), 'The last batch must still complete')
})

test('replace partial successful add response never clears old songs', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply({ ...write, ids: [1] }); return { code: 200 } }
  const result = await service.populatePlaylistChecked(USER, TARGET, [1, 2], true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(state.ids, [1, 9, 8])
  assert.equal(state.writes.length, 1)
})

test('replace skips an undeletable old song without undoing verified new songs', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => write.op === 'del' && write.ids.includes(9)
    ? { code: 512, message: '该歌曲无法删除' } : undefined
  const result = await service.populatePlaylistChecked(USER, TARGET, [1, 2], true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(state.ids, [1, 2, 9])
  assert.deepEqual(result.failedTracks.map((item) => [item.songId, item.operation]), [[9, 'remove']])
})

test('append never removes originals and only adds absent IDs', async (t) => {
  const state = fixture(t)
  const result = await service.populatePlaylistChecked(USER, TARGET, [1, 9, 1], false)
  assert.equal(result.status, 'completed')
  assert.deepEqual(state.writes, [{ op: 'add', ids: [1] }])
  assert.deepEqual(state.ids, [1, 9, 8])
})

test('unknown add result stops replace before removing any originals or retrying', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply(write); throw new Error('response lost') }
  const result = await service.populatePlaylistChecked(USER, TARGET, [1, 2], true)
  assert.equal(result.status, 'stopped')
  assert.deepEqual(state.ids, [1, 2, 9, 8])
  assert.equal(state.writes.length, 1)
})

test('an unrelated original removal during add stops replacement', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply(write); state.ids = state.ids.filter((id) => id !== 9); return { code: 200 } }
  const result = await service.populatePlaylistChecked(USER, TARGET, [1, 2], true)
  assert.equal(result.status, 'stopped')
  assert.equal(state.writes.length, 1)
})

test('account change during add prevents any obsolete-song removal', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply(write); state.userId = 88; return { code: 200 } }
  const result = await service.populatePlaylistChecked(USER, TARGET, [1, 2], true)
  assert.equal(result.status, 'stopped')
  assert.deepEqual(state.ids, [1, 2, 9, 8])
})

test('creation requires a successful business code even if a response contains an ID', async (t) => {
  const state = fixture(t)
  state.onCreate = () => ({ code: 500, id: TARGET, message: '创建失败' })
  await assert.rejects(api.createPlaylistDirect('测试'), /创建失败/)
  assert.equal(state.creates, 1)
  state.onCreate = () => ({ code: 200, id: -1 })
  await assert.rejects(api.createPlaylistDirect('测试'), /创建歌单失败/)
})

const nodes = (element) => Array.isArray(element) ? element.flatMap(nodes)
  : element && typeof element === 'object' && element.props ? [element, ...nodes(element.props.children)] : []
const textOf = (element) => Array.isArray(element) ? element.map(textOf).join('')
  : element && typeof element === 'object' ? textOf(element.props?.children) : element == null ? '' : String(element)

function createPage(populate, create = async () => TARGET) {
  const states = [], refs = []
  let cursor = 0, refCursor = 0
  const page = loadSource('src/panel/pages/CreateConfirm.tsx', {
    'react/jsx-runtime': jsxRuntime,
    react: {
      useEffect: () => {}, useRef: (initial) => refs[refCursor++] ||= { current: initial },
      useState: (initial) => {
        const index = cursor++
        if (!(index in states)) states[index] = index === 2 ? false : typeof initial === 'function' ? initial() : initial
        return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
    },
    '@/api/netease-direct': { getCleanupUserId: async () => USER, createPlaylistDirect: create },
    '@/services/playlist-populate': { populatePlaylistChecked: populate },
    '../components/PlaylistFailures': failures,
  })
  const props = { uid: USER, grouped: [1, 2].map((id) => ({ category: '分类' + id, dimension: 'genre', songs: [{ songId: id, songName: '歌曲' + id }] })), onDone: () => {} }
  return () => { cursor = 0; refCursor = 0; return page.CreateConfirm(props) }
}

test('classification page continues the next category after a partial result and lists failed songs', async (t) => {
  fixture(t)
  const calls = []
  const render = createPage(async (_uid, _pid, ids) => {
    calls.push(ids)
    return ids.includes(1) ? { status: 'partial', message: '单曲失败，已跳过', failedTracks: [{ songId: 1, playlistId: TARGET, playlistName: '分类1', operation: 'add', message: '下架' }] }
      : { status: 'completed', failedTracks: [] }
  })
  await nodes(render()).find((node) => node.type === 'button' && textOf(node).includes('开始创建')).props.onClick()
  assert.deepEqual(calls, [[1], [2]])
  assert.match(textOf(render()), /处理结束，失败歌曲见上方清单/)
  const failureProps = nodes(render()).filter((node) => node.type === failures.PlaylistFailures)
  assert.deepEqual(failureProps[0].props.failures.map((item) => item.songId), [1])
})

test('classification page stops following categories on unsafe results and reuses a created target on retry', async (t) => {
  fixture(t)
  let calls = 0, creates = 0
  const render = createPage(async () => { calls++; return { status: 'stopped', message: '状态未知', failedTracks: [] } }, async () => { creates++; return TARGET })
  const run = () => nodes(render()).find((node) => node.type === 'button' && textOf(node).includes('开始创建')).props.onClick()
  await run()
  assert.equal(calls, 1)
  await run()
  assert.equal(calls, 2)
  assert.equal(creates, 1)
})

test('unknown creation result is not retried automatically or by the unchanged page', async (t) => {
  fixture(t)
  let creates = 0
  const render = createPage(async () => { assert.fail('No population after unknown creation') }, async () => { creates++; throw new Error('连接中断') })
  await nodes(render()).find((node) => node.type === 'button' && textOf(node).includes('开始创建')).props.onClick()
  const button = nodes(render()).find((node) => node.type === 'button' && textOf(node).includes('开始创建'))
  assert.equal(button.props.disabled, true)
  await button.props.onClick()
  assert.equal(creates, 1)
})

test('failure list exposes song ID, name, playlist and server reason', () => {
  const tree = failures.PlaylistFailures({ failures: [{ songId: 1, playlistId: TARGET, playlistName: 'ACG', operation: 'add', message: '下架歌曲无法收藏' }], songName: () => '歌曲A' })
  assert.match(textOf(tree), /歌曲A.*ID 1.*ACG.*下架歌曲无法收藏/)
})
