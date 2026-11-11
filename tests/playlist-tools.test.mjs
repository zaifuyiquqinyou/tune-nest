import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { crc32 } from 'node:zlib'
import test from 'node:test'
import ts from 'typescript'

const root = new URL('../', import.meta.url)

// 执行真实 TypeScript 源码，仅替换浏览器和网络边界，不引入测试依赖。
function loadSource(path, imports = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.ok(name in imports, 'Unexpected runtime import: ' + name)
    return imports[name]
  }, module, module.exports)
  return module.exports
}

const api = loadSource('src/api/netease-direct.ts')
const textTools = loadSource('src/utils/playlist-text.ts')
const zipTools = loadSource('src/utils/playlist-zip.ts')
const fileTools = loadSource('src/utils/playlist-files.ts', { './playlist-zip': zipTools })
const exporter = loadSource('src/services/playlist-export.ts', {
  '@/api/netease-direct': api, '@/utils/playlist-text': textTools,
})
const merger = loadSource('src/services/playlist-merge.ts', {
  '@/api/netease-direct': api, '@/utils/playlist-text': textTools,
})
const USER = 7
const A = 101
const B = 102
const TARGET = 202
const COLLECTED = 303
const detailPath = '/api/v6/playlist/detail'
const mutationPath = '/api/playlist/manipulate/tracks'

function backup(ids = [1, 2, 3], overrides = {}) {
  return {
    version: 1, platform: 'netease', accountId: USER, playlistId: A, playlistName: '最近',
    ownerId: USER, reportedTrackCount: ids.length, exportedAt: '2026-11-11T01:00:00.000Z',
    songs: ids.map((id) => ({
      id, name: '歌曲' + id, artists: ['歌手'], album: '专辑', durationMs: 123000, detailsAvailable: true,
    })),
    ...overrides,
  }
}

/** 全部 fetch 均被截获；任何目标删除、未知写目标或过大批次立即导致测试失败。 */
function fixture(t, { a = [1, 2, 3], b = [3, 4, 5], target = [2, 9, 8] } = {}) {
  const oldFetch = globalThis.fetch
  const oldDocument = globalThis.document
  const state = {
    userId: USER,
    playlists: new Map([
      [A, { id: A, name: '最近', creatorId: USER, trackIds: [...a] }],
      [B, { id: B, name: '其他来源', creatorId: USER, trackIds: [...b] }],
      [TARGET, { id: TARGET, name: '归档', creatorId: USER, trackIds: [...target] }],
      [COLLECTED, { id: COLLECTED, name: '收藏的歌单', creatorId: 99, trackIds: [6] }],
    ]),
    requests: [], writes: [], events: [], reportedCounts: new Map(),
    onRead: null, onWrite: null, onList: null, onSongs: null, onAccount: null,
    accountReads: 0,
  }
  state.detail = (id) => {
    const playlist = state.playlists.get(id)
    if (!playlist) return { code: 404, message: '歌单不存在' }
    return {
      code: 200,
      playlist: {
        id, name: playlist.name, creator: { userId: playlist.creatorId },
        trackCount: state.reportedCounts.get(id) ?? playlist.trackIds.length,
        trackIds: playlist.trackIds.map((id) => ({ id })),
      },
    }
  }
  state.apply = (write) => {
    const playlist = state.playlists.get(write.pid)
    const ids = new Set(write.trackIds)
    playlist.trackIds = write.op === 'add'
      ? [...write.trackIds.filter((id) => !playlist.trackIds.includes(id)), ...playlist.trackIds]
      : playlist.trackIds.filter((id) => !ids.has(id))
  }
  const response = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
  globalThis.document = { cookie: '__csrf=mock-csrf' }
  globalThis.fetch = async (input, options) => {
    const path = new URL(input).pathname
    const params = new URLSearchParams(options.body)
    const request = { path, params }
    state.requests.push(request)
    assert.equal(options.credentials, 'include')
    assert.equal(params.get('csrf_token'), 'mock-csrf')
    if (path === '/api/w/nuser/account/get') {
      const override = state.onAccount ? await state.onAccount(++state.accountReads) : undefined
      return response(override ?? { code: 200, profile: { userId: state.userId } })
    }
    if (path === '/api/user/playlist') {
      const override = state.onList ? await state.onList(request) : undefined
      return response(override ?? {
        code: 200, more: false,
        playlist: [...state.playlists.values()].map((playlist) => ({
          id: playlist.id, name: playlist.name, creator: { userId: playlist.creatorId },
          trackCount: playlist.trackIds.length,
        })),
      })
    }
    if (path === detailPath) {
      const id = Number(params.get('id'))
      state.events.push({ kind: 'read', id })
      const override = state.onRead ? await state.onRead(id) : undefined
      return response(override ?? state.detail(id))
    }
    if (path === '/api/v3/song/detail') {
      const ids = JSON.parse(params.get('c')).map((item) => item.id)
      const override = state.onSongs ? await state.onSongs(ids) : undefined
      return response(override ?? {
        code: 200, songs: ids.map((id) => ({
          id, name: '歌曲' + id, ar: [{ id: 1, name: '歌手' }], al: { id: 2, name: '专辑' }, dt: 123000,
        })),
      })
    }
    assert.equal(path, mutationPath, 'Unexpected endpoint: ' + path)
    const write = { pid: Number(params.get('pid')), op: params.get('op'), trackIds: JSON.parse(params.get('trackIds')) }
    state.writes.push(write)
    state.events.push({ kind: 'write', ...write })
    assert.ok(write.trackIds.length > 0 && write.trackIds.length <= 100)
    assert.equal(new Set(write.trackIds).size, write.trackIds.length)
    assert.ok(write.pid === TARGET && write.op === 'add' || [A, B].includes(write.pid) && write.op === 'del',
      'Target must only receive adds; only selected sources may receive deletes')
    const override = state.onWrite ? await state.onWrite(write, state.writes.length) : undefined
    if (override !== undefined) return response(override)
    state.apply(write)
    return response({ code: 200 })
  }
  t.after(() => {
    globalThis.fetch = oldFetch
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  })
  return state
}

const previewOnline = (ids = [A, B], move = true) =>
  merger.previewPlaylistMerge(USER, TARGET, { kind: 'online', playlistIds: ids }, move)
const previewFiles = (documents, move = false) =>
  merger.previewPlaylistMerge(USER, TARGET, { kind: 'files', documents }, move)
const noDeletes = (state) => assert.ok(state.writes.every((write) => write.op !== 'del'))

test('TXT round trip preserves Unicode, control characters, song order and metadata', () => {
  const document = backup([12, 34], { playlistName: '日系 / ACG 🎧' })
  document.songs[0].name = '引号"、制表\t、换行\n第二行'
  document.songs[0].artists = ['歌手一', '歌手二']
  const serialized = textTools.serializePlaylistText(document)
  assert.equal(serialized.charCodeAt(0), 0xFEFF)
  assert.equal(serialized.split('\r\n').filter((line) => line.startsWith('{')).length, 2)
  const parsed = textTools.parsePlaylistText(serialized)
  assert.deepEqual(parsed, document)
  assert.ok(Object.isFrozen(parsed))
  assert.ok(Object.isFrozen(parsed.songs))
  assert.ok(Object.isFrozen(parsed.songs[0].artists))
})

test('TXT retains IDs when details are absent and permits metadata count differences', () => {
  const document = backup([99], { reportedTrackCount: 5 })
  document.songs[0] = { id: 99, name: '', artists: [], album: '', durationMs: 0, detailsAvailable: false }
  assert.deepEqual(textTools.parsePlaylistText(textTools.serializePlaylistText(document)), document)
})

test('TXT rejects unsupported, truncated, duplicate and invalid records', async (t) => {
  const valid = textTools.serializePlaylistText(backup())
  const cases = [
    ['wrong magic', valid.replace('TXT v1', 'TXT v2')],
    ['wrong version', valid.replace('"version":1', '"version":2')],
    ['wrong platform', valid.replace('"netease"', '"other"')],
    ['invalid account', valid.replace('"accountId":7', '"accountId":0')],
    ['invalid date', valid.replace('2026-11-11T01:00:00.000Z', 'not-a-date')],
    ['truncated rows', valid.split('\r\n').slice(0, -2).join('\r\n')],
    ['invalid ID', valid.replace('"id":1,', '"id":0,')],
    ['duplicate ID', valid.replace('"id":2,', '"id":1,')],
    ['invalid artists', valid.replace('"artists":["歌手"]', '"artists":[null]')],
    ['invalid duration', valid.replace('"durationMs":123000', '"durationMs":-1')],
    ['invalid metadata JSON', valid.replace('"version":1', '"version":')],
    ['invalid song JSON', valid.replace('"id":1,', '"id":,')],
    ['null metadata', '\uFEFF# TuneNest Playlist TXT v1\r\n# null'],
  ]
  for (const [name, serialized] of cases) {
    await t.test(name, () => assert.throws(() => textTools.parsePlaylistText(serialized)))
  }
})

test('TXT filenames are Windows-safe and distinguish collisions and case variants', () => {
  const used = new Set()
  assert.equal(textTools.playlistTextFilename('日系', 1, used), '日系.txt')
  assert.equal(textTools.playlistTextFilename('日系', 2, used), '日系 (2).txt')
  assert.equal(textTools.playlistTextFilename('A/B:*?"<>|', 3, used), 'A_B_______.txt')
  assert.equal(textTools.playlistTextFilename('CON', 4, used), '_CON.txt')
  assert.equal(textTools.playlistTextFilename('nul.txt', 5, used), '_nul.txt.txt')
  assert.equal(textTools.playlistTextFilename('...', 6, used), '未命名歌单.txt')
  assert.equal(textTools.playlistTextFilename('English', 7, used), 'English.txt')
  assert.equal(textTools.playlistTextFilename('english', 8, used), 'english (8).txt')
  assert.ok(Array.from(textTools.playlistTextFilename('🎧'.repeat(100), 9, used)).length <= 84)
})

test('ZIP central directory locates UTF-8 entries with valid native CRC32 and TXT bytes', () => {
  const files = [{ name: '日系 🎧.txt', content: textTools.serializePlaylistText(backup()) }, { name: '空歌单.txt', content: '' }]
  const bytes = zipTools.createPlaylistZip(files)
  const view = new DataView(bytes.buffer)
  const end = bytes.length - 22
  assert.equal(view.getUint32(end, true), 0x06054B50)
  assert.equal(view.getUint16(end + 10, true), files.length)
  let directory = view.getUint32(end + 16, true)
  for (const file of files) {
    assert.equal(view.getUint32(directory, true), 0x02014B50)
    assert.equal(view.getUint16(directory + 8, true), 0x0800)
    assert.equal(view.getUint16(directory + 10, true), 0)
    const length = view.getUint32(directory + 24, true)
    const nameLength = view.getUint16(directory + 28, true)
    const extraLength = view.getUint16(directory + 30, true)
    const commentLength = view.getUint16(directory + 32, true)
    const local = view.getUint32(directory + 42, true)
    assert.equal(view.getUint32(local, true), 0x04034B50)
    const contentStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const content = bytes.slice(contentStart, contentStart + length)
    assert.equal(new TextDecoder().decode(bytes.slice(directory + 46, directory + 46 + nameLength)), file.name)
    assert.deepEqual(content, new TextEncoder().encode(file.content))
    assert.equal(crc32(content), view.getUint32(directory + 16, true))
    assert.equal(crc32(content), view.getUint32(local + 14, true))
    directory += 46 + nameLength + extraLength + commentLength
  }
  assert.equal(directory, end)
})

test('ZIP opens with the independent Windows .NET archive reader', { skip: process.platform !== 'win32' }, () => {
  const bytes = zipTools.createPlaylistZip([{ name: '日系.txt', content: '歌曲 A\r\nID 123' }])
  const base64 = Buffer.from(bytes).toString('base64')
  const command = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.IO.Compression',
    "$stream = [System.IO.MemoryStream]::new([Convert]::FromBase64String('" + base64 + "'))",
    '$zip = [System.IO.Compression.ZipArchive]::new($stream)',
    '$reader = [System.IO.StreamReader]::new($zip.Entries[0].Open(), [System.Text.Encoding]::UTF8)',
    '@{Name=$zip.Entries[0].FullName; Content=$reader.ReadToEnd()} | ConvertTo-Json -Compress',
    '$reader.Dispose()', '$zip.Dispose()', '$stream.Dispose()',
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.replace(/^\uFEFF/, '')), { Name: '日系.txt', Content: '歌曲 A\r\nID 123' })
})

test('export includes owned and collected playlists, caches metadata and never writes online', async (t) => {
  const state = fixture(t)
  const files = []
  const progress = []
  const outcome = await exporter.exportAccountPlaylists(USER, async (file) => { files.push(file) }, (value) => progress.push(value))
  assert.equal(outcome.exportedCount, 4)
  assert.equal(outcome.songCount, 10)
  assert.deepEqual(files.map((file) => file.name), ['最近.txt', '其他来源.txt', '归档.txt', '收藏的歌单.txt'])
  assert.equal(textTools.parsePlaylistText(files[3].content).ownerId, 99)
  assert.equal(progress.length, 4)
  const queried = state.requests.filter((request) => request.path === '/api/v3/song/detail')
    .flatMap((request) => JSON.parse(request.params.get('c')).map((song) => song.id))
  assert.equal(queried.length, new Set(queried).size)
  assert.equal(state.writes.length, 0)
})

test('export retains missing metadata IDs and reports returned-count differences', async (t) => {
  const state = fixture(t)
  state.reportedCounts.set(A, 20)
  state.onSongs = () => ({ code: 200, songs: [] })
  const files = []
  const outcome = await exporter.exportAccountPlaylists(USER, async (file) => { files.push(file) })
  assert.equal(outcome.exportedCount, 4)
  assert.equal(outcome.detailsMissingCount, 10)
  assert.equal(outcome.countDifferences.length, 1)
  const document = textTools.parsePlaylistText(files[0].content)
  assert.deepEqual(document.songs.map((song) => song.id), [1, 2, 3])
  assert.ok(document.songs.every((song) => song.detailsAvailable === false))
  assert.equal(document.reportedTrackCount, 20)
  assert.equal(state.writes.length, 0)
})

test('export continues other playlists after read or file-save failure', async (t) => {
  const state = fixture(t)
  state.onRead = (id) => id === B ? { code: 403, message: '读取失败' } : undefined
  const saved = []
  const outcome = await exporter.exportAccountPlaylists(USER, async (file) => {
    if (file.name === '最近.txt') throw new Error('磁盘写入失败')
    saved.push(file)
  })
  assert.equal(outcome.exportedCount, 2)
  assert.equal(outcome.failures.length, 2)
  assert.equal(saved.length, 2)
  assert.equal(state.writes.length, 0)
})

test('export stops on an account change and reports every remaining playlist as unexported', async (t) => {
  const state = fixture(t)
  const saved = []
  const outcome = await exporter.exportAccountPlaylists(USER, async (file) => {
    saved.push(file)
    state.userId = 99
  })
  assert.equal(saved.length, 1)
  assert.equal(outcome.exportedCount, 1)
  assert.equal(outcome.failures.length, 3)
  assert.equal(state.writes.length, 0)
})

test('export falls back to IDs after a song-detail business failure', async (t) => {
  const state = fixture(t)
  state.onSongs = () => ({ code: 403, message: '详情不可读取' })
  const files = []
  const outcome = await exporter.exportAccountPlaylists(USER, async (file) => { files.push(file) })
  assert.equal(outcome.exportedCount, 4)
  assert.equal(outcome.detailsMissingCount, 10)
  assert.equal(textTools.parsePlaylistText(files[0].content).songs.length, 3)
  assert.equal(state.writes.length, 0)
})

test('directory cancellation is explicit and performs no network or file writes', async (t) => {
  const state = fixture(t)
  const previous = globalThis.window
  globalThis.window = { showDirectoryPicker: async () => { throw new DOMException('Cancelled', 'AbortError') } }
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous })
  await assert.rejects(fileTools.choosePlaylistDirectory(), /取消/)
  assert.equal(state.requests.length, 0)
})

test('directory writer creates a new subdirectory and closes or aborts each file', async (t) => {
  const previous = globalThis.window
  const calls = []
  let probes = 0
  let fail = false
  const writable = {
    async write(content) { calls.push(['write', content]); if (fail) throw new Error('disk full') },
    async close() { calls.push(['close']) },
    async abort() { calls.push(['abort']) },
  }
  const directory = {
    async getFileHandle(name) { calls.push(['file', name]); return { async createWritable() { return writable } } },
  }
  globalThis.window = {
    async showDirectoryPicker() {
      return {
        name: '备份',
        async getDirectoryHandle(name, options) {
          if (options?.create) { calls.push(['directory', name]); return directory }
          if (++probes === 1) return directory
          throw new DOMException('Not found', 'NotFoundError')
        },
      }
    },
  }
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous })
  const writer = await fileTools.choosePlaylistDirectory()
  assert.match(writer.name, /-1$/)
  await writer.write({ name: '日系.txt', content: 'test' })
  assert.ok(calls.some((call) => call[0] === 'close'))
  fail = true
  await assert.rejects(writer.write({ name: '失败.txt', content: 'test' }), /disk full/)
  assert.ok(calls.some((call) => call[0] === 'abort'))
})

test('online preview freezes source roles and deduplicates the combined song IDs', async (t) => {
  const state = fixture(t)
  const plan = await previewOnline()
  assert.deepEqual(plan.incomingTrackIds, [1, 2, 3, 4, 5])
  assert.deepEqual(plan.missingTargetTrackIds, [1, 3, 4, 5])
  assert.ok(Object.isFrozen(plan.sources[0].snapshot.trackIds))
  assert.ok(Object.isFrozen(plan.sources[0].removalTrackIds))
  assert.ok(Object.isFrozen(plan.incomingTrackIds))
  assert.equal(state.writes.length, 0)
})

test('multiple sources are moved only after all candidates exist in the target', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    if (write.op === 'del') {
      const target = state.playlists.get(TARGET).trackIds
      for (const id of [1, 2, 3, 4, 5]) assert.ok(target.includes(id))
      assert.deepEqual(target.filter((id) => [2, 9, 8].includes(id)), [2, 9, 8])
    }
  }
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.addedCount, 4)
  assert.equal(outcome.targetPreserved, true)
  assert.deepEqual(state.playlists.get(A).trackIds, [])
  assert.deepEqual(state.playlists.get(B).trackIds, [])
  assert.deepEqual(state.playlists.get(TARGET).trackIds, [1, 3, 4, 5, 2, 9, 8])
  assert.deepEqual(state.writes.map((write) => [write.op, write.pid]), [['add', TARGET], ['del', A], ['del', B]])
  assert.equal(state.playlists.has(A), true)
})

test('a single source uses the same move workflow and retains the target existing songs', async (t) => {
  const state = fixture(t)
  const outcome = await merger.executePlaylistMerge(await previewOnline([A]))
  assert.equal(outcome.status, 'completed')
  assert.deepEqual(state.playlists.get(A).trackIds, [])
  assert.deepEqual(state.playlists.get(B).trackIds, [3, 4, 5])
  assert.deepEqual(state.playlists.get(TARGET).trackIds, [1, 3, 2, 9, 8])
})

test('copy-only online merge leaves all source songs unchanged', async (t) => {
  const state = fixture(t)
  const outcome = await merger.executePlaylistMerge(await previewOnline([A, B], false))
  assert.equal(outcome.status, 'completed')
  noDeletes(state)
  assert.deepEqual(state.playlists.get(A).trackIds, [1, 2, 3])
  assert.deepEqual(state.playlists.get(B).trackIds, [3, 4, 5])
})

test('role, ownership and duplicate-source errors are rejected without any writes', async (t) => {
  const state = fixture(t)
  await assert.rejects(previewOnline([A, TARGET]), /目标歌单/)
  await assert.rejects(previewOnline([A, A]), /来源歌单/)
  await assert.rejects(previewOnline([]), /来源歌单/)
  await assert.rejects(previewOnline([COLLECTED]), /在线来源/)
  await assert.rejects(merger.previewPlaylistMerge(USER, COLLECTED, { kind: 'online', playlistIds: [A] }, true), /目标/)
  assert.equal(state.writes.length, 0)
})

test('changed account, target or source after preview prevents all writes', async (t) => {
  for (const change of ['account', 'target', 'source', 'ownership']) {
    await t.test(change, async (subtest) => {
      const state = fixture(subtest)
      const plan = await previewOnline()
      if (change === 'account') state.userId = 99
      if (change === 'target') state.playlists.get(TARGET).trackIds.push(88)
      if (change === 'source') state.playlists.get(A).trackIds.push(88)
      if (change === 'ownership') state.playlists.get(A).creatorId = 99
      const outcome = await merger.executePlaylistMerge(plan)
      assert.equal(outcome.status, 'stopped')
      assert.equal(state.writes.length, 0)
    })
  }
})

test('target business failure leaves every source intact', async (t) => {
  const state = fixture(t)
  state.onWrite = () => ({ code: 502, message: '歌单已满' })
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.addedCount, 0)
  noDeletes(state)
  assert.deepEqual(state.playlists.get(A).trackIds, [1, 2, 3])
})

test('partial target addition with a success response stops before any source deletion', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    state.apply({ ...write, trackIds: write.trackIds.slice(0, 1) })
    return { code: 200 }
  }
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.addedCount, 1)
  assert.equal(outcome.missingTargetCount, 3)
  noDeletes(state)
  assert.deepEqual(state.playlists.get(A).trackIds, [1, 2, 3])
})

test('lost add response is not retried; a fresh preview can safely resume moving', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { state.apply(write); throw new Error('response lost') }
  const first = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(first.status, 'stopped')
  assert.equal(first.addedCount, 4)
  assert.equal(state.writes.length, 1)
  noDeletes(state)
  state.onWrite = null
  const next = await previewOnline()
  assert.deepEqual(next.missingTargetTrackIds, [])
  const resumed = await merger.executePlaylistMerge(next)
  assert.equal(resumed.status, 'completed')
  assert.equal(state.writes.filter((write) => write.op === 'add').length, 1)
})

test('a later add batch failure preserves every source, including already copied songs', async (t) => {
  const ids = Array.from({ length: 150 }, (_, index) => index + 1000)
  const state = fixture(t, { a: ids, b: [] })
  state.onWrite = (_write, index) => index === 2 ? { code: 403, message: '添加失败' } : undefined
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.addedCount, 100)
  assert.equal(outcome.missingTargetCount, 50)
  noDeletes(state)
  assert.deepEqual(state.playlists.get(A).trackIds, ids)
})

test('multi-batch success completes all target additions before the first source deletion', async (t) => {
  const ids = Array.from({ length: 121 }, (_, index) => index + 1000)
  const state = fixture(t, { a: ids, b: [] })
  const outcome = await merger.executePlaylistMerge(await previewOnline([A]))
  assert.equal(outcome.status, 'completed')
  assert.deepEqual(state.writes.map((write) => [write.op, write.trackIds.length]), [['add', 100], ['add', 21], ['del', 100], ['del', 21]])
  assert.deepEqual(state.playlists.get(A).trackIds, [])
  assert.equal(outcome.targetPreserved, true)
})

test('source deletion failure stops all following sources and never clears the target', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => write.op === 'del' ? { code: 403, message: '移除失败' } : undefined
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(state.writes.filter((write) => write.op === 'del').length, 1)
  assert.equal(outcome.targetPreserved, true)
  assert.deepEqual(state.playlists.get(A).trackIds, [1, 2, 3])
  assert.deepEqual(state.playlists.get(B).trackIds, [3, 4, 5])
})

test('lost delete response reports observed removals and never retries the write', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    if (write.op === 'del') { state.apply(write); throw new Error('delete response lost') }
  }
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.sources[0].removedCount, 3)
  assert.equal(outcome.sources[1].pendingCount, 3)
  assert.equal(state.writes.length, 2)
  assert.equal(outcome.targetPreserved, true)
})

test('partial deletion is detected and the next source is untouched', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    if (write.op === 'del') {
      state.apply({ ...write, trackIds: write.trackIds.slice(0, 1) })
      return { code: 200 }
    }
  }
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.sources[0].removedCount, 1)
  assert.equal(outcome.sources[0].pendingCount, 2)
  assert.deepEqual(state.playlists.get(B).trackIds, [3, 4, 5])
})

test('source change during additions prevents every source deletion', async (t) => {
  const state = fixture(t)
  const outcome = await merger.executePlaylistMerge(await previewOnline(), (progress) => {
    if (progress.phase === 'adding') state.playlists.get(A).trackIds.push(77)
  })
  assert.equal(outcome.status, 'stopped')
  noDeletes(state)
  assert.deepEqual(state.playlists.get(A).trackIds, [1, 2, 3, 77])
})

test('target external change after additions prevents source deletion', async (t) => {
  const state = fixture(t)
  const outcome = await merger.executePlaylistMerge(await previewOnline(), (progress) => {
    if (progress.phase === 'adding') state.playlists.get(TARGET).trackIds.pop()
  })
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.targetPreserved, false)
  noDeletes(state)
})

test('external target change during a deletion stops the remaining source writes', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    if (write.op === 'del') state.playlists.get(TARGET).trackIds.push(77)
  }
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(state.writes.filter((write) => write.op === 'del').length, 1)
  assert.deepEqual(state.playlists.get(B).trackIds, [3, 4, 5])
})

test('target reorder during addition is rejected even when the same IDs remain', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => {
    state.apply(write)
    state.playlists.get(TARGET).trackIds.reverse()
    return { code: 200 }
  }
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.targetPreserved, false)
  noDeletes(state)
})

test('an account change after a deletion stops the next source', async (t) => {
  const state = fixture(t)
  state.onWrite = (write) => { if (write.op === 'del') state.userId = 99 }
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.deepEqual(state.playlists.get(B).trackIds, [3, 4, 5])
  assert.equal(state.writes.filter((write) => write.op === 'del').length, 1)
})

test('unreadable result remains unknown rather than being reported as success', async (t) => {
  const state = fixture(t)
  state.onWrite = () => {
    state.onRead = () => { throw new Error('network unavailable') }
    throw new Error('write result unknown')
  }
  const outcome = await merger.executePlaylistMerge(await previewOnline())
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.addedCount, null)
  assert.equal(outcome.targetPreserved, null)
  assert.equal(outcome.sources[0].removedCount, null)
  noDeletes(state)
})

test('only one merge execution can run concurrently', async (t) => {
  const state = fixture(t)
  const plan = await previewOnline()
  let release
  let markStarted
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  state.onWrite = async () => { markStarted(); await gate }
  const first = merger.executePlaylistMerge(plan)
  await started
  try {
    await assert.rejects(merger.executePlaylistMerge(plan), /正在执行/)
  } finally {
    release()
  }
  assert.equal((await first).status, 'completed')
  assert.equal(state.writes.length, 3)
})

test('tampered removal or incoming sets fail before any network requests', async (t) => {
  const state = fixture(t)
  const plan = await previewOnline()
  const before = state.requests.length
  await assert.rejects(merger.executePlaylistMerge({
    ...plan, sources: [{ ...plan.sources[0], removalTrackIds: [999] }, plan.sources[1]],
  }), /交集/)
  await assert.rejects(merger.executePlaylistMerge({ ...plan, incomingTrackIds: [999] }), /预览不一致/)
  await assert.rejects(merger.executePlaylistMerge({
    ...plan, sources: [{ ...plan.sources[0], snapshot: null }, plan.sources[1]],
  }), /在线歌单/)
  assert.equal(state.requests.length, before)
})

test('TXT copy imports backup IDs without reading or removing the original online sources', async (t) => {
  const state = fixture(t)
  const document = backup([1, 3, 77], { playlistId: 999, ownerId: 99, accountId: 99 })
  const outcome = await merger.executePlaylistMerge(await previewFiles([document]))
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.sources[0].remainingCount, null)
  noDeletes(state)
  const playlistReads = state.events.filter((event) => event.kind === 'read')
  assert.ok(playlistReads.every((event) => event.id === TARGET))
  assert.deepEqual(state.playlists.get(TARGET).trackIds, [1, 3, 77, 2, 9, 8])
})

test('TXT move removes only backup IDs still in the source and preserves songs added after backup', async (t) => {
  const state = fixture(t, { a: [1, 2, 3, 77] })
  const plan = await previewFiles([backup([1, 3, 6])], true)
  assert.deepEqual(plan.sources[0].removalTrackIds, [1, 3])
  const outcome = await merger.executePlaylistMerge(plan)
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.sources[0].removedCount, 2)
  assert.deepEqual(state.playlists.get(A).trackIds, [2, 77])
  assert.deepEqual(state.playlists.get(TARGET).trackIds, [1, 3, 6, 2, 9, 8])
  assert.deepEqual(state.writes.filter((write) => write.op === 'del'), [{ pid: A, op: 'del', trackIds: [1, 3] }])
})

test('multiple TXT sources merge into one target while retaining all post-backup songs', async (t) => {
  const state = fixture(t, { a: [1, 2, 77], b: [3, 4, 88] })
  const documents = [backup([1, 2]), backup([2, 3], { playlistId: B, playlistName: '第二份备份' })]
  const outcome = await merger.executePlaylistMerge(await previewFiles(documents, true))
  assert.equal(outcome.status, 'completed')
  assert.deepEqual(state.playlists.get(A).trackIds, [77])
  assert.deepEqual(state.playlists.get(B).trackIds, [4, 88])
  assert.equal(outcome.addedCount, 2)
})

test('TXT move validates backup account, backup owner and the actual source owner', async (t) => {
  const state = fixture(t)
  await assert.rejects(previewFiles([backup([1], { accountId: 99 })], true), /备份账号/)
  await assert.rejects(previewFiles([backup([1], { ownerId: 99 })], true), /备份账号/)
  state.playlists.get(A).creatorId = 99
  await assert.rejects(previewFiles([backup([1])], true), /在线来源/)
  assert.equal(state.writes.length, 0)
})

test('TXT duplicates and a target also used as a source are rejected', async (t) => {
  const state = fixture(t)
  await assert.rejects(previewFiles([backup(), backup()]), /来源歌单/)
  await assert.rejects(previewFiles([backup([1], { playlistId: TARGET })]), /目标歌单/)
  assert.equal(state.writes.length, 0)
})

test('count metadata drift does not broaden a move beyond actual returned song IDs', async (t) => {
  const state = fixture(t)
  state.reportedCounts.set(A, 30)
  state.reportedCounts.set(TARGET, 20)
  const plan = await previewOnline([A])
  state.reportedCounts.set(A, 99)
  const outcome = await merger.executePlaylistMerge(plan)
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.sources[0].removedCount, 3)
  assert.equal(outcome.targetPreserved, true)
})

test('fresh preview after a completed move is idempotent and performs no extra writes', async (t) => {
  const state = fixture(t)
  await merger.executePlaylistMerge(await previewOnline())
  const writes = state.writes.length
  const plan = await previewOnline()
  assert.deepEqual(plan.incomingTrackIds, [])
  assert.equal((await merger.executePlaylistMerge(plan)).status, 'completed')
  assert.equal(state.writes.length, writes)
})

test('add API rejects invalid roles, IDs and oversized batches without requests', async (t) => {
  const state = fixture(t)
  await assert.rejects(api.addTargetPlaylistTracks(TARGET, [A, TARGET], [1]))
  await assert.rejects(api.addTargetPlaylistTracks(TARGET, [A], [0]))
  await assert.rejects(api.addTargetPlaylistTracks(TARGET, [A], [1, 1]))
  await assert.rejects(api.addTargetPlaylistTracks(TARGET, [A], Array.from({ length: 101 }, (_, index) => index + 1)))
  assert.equal(state.requests.length, 0)
})
