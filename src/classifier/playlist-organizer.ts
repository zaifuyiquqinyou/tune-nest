import type { Playlist } from '@/types'
import type { PlaylistTextTrack } from '@/types/playlist-tools'
import type {
  OrganizeAssignment, OrganizeCandidate, OrganizeProfile, OrganizeRecommendation, OrganizeRule, OrganizeScope,
} from '@/types/playlist-organize'

const genericArtists = new Set(['群星', 'various artists', 'unknown', '佚名', '未知'])
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0

/** 作品名按明确别名匹配，不将 AC 当作 ACG，也不将“原声”一概视为动画。 */
const workAliases: Record<string, readonly string[]> = {
  '古剑': ['古剑奇谭', '古劍奇譚', '古剣奇譚', '古剑', '古劍', '古剣'],
  '诛仙': ['诛仙', '誅仙'],
  '仙剑': ['仙剑奇侠传', '仙劍奇俠傳', '仙剣奇侠伝', '仙剑', '仙劍', '仙剣', 'Chinese Paladin'],
  '剑网三': ['剑网三', '剑网3', '劍網三', '劍網3', 'JX3'],
  '罪恶王冠': ['罪恶王冠', '罪惡王冠', 'ギルティクラウン', 'Guilty Crown'],
  '明日方舟': ['明日方舟', 'Arknights'],
  'AC': ["Assassin's Creed", 'Assassins Creed', '刺客信条', '刺客信條'],
  'Overwatch': ['Overwatch', '守望先锋', '鬥陣特攻'],
  '巫师3': ['The Witcher 3', '巫师3', '巫师三', '巫師3'],
  '33号远征队': ['Expedition 33', '33号远征队', '33號遠征隊'],
  'BanG Dream!': ['BanG Dream!'],
}

/** 排除模式首次使用时提示过滤收纳型歌单；用户仍可修改勾选结果。 */
export function defaultOrganizeExclusions(playlists: readonly Playlist[]): number[] {
  return playlists.filter((playlist) => playlist.name === '最近' || playlist.name === '未分类' ||
    playlist.name.endsWith('喜欢的音乐') || playlist.name === '你喜欢的歌曲重新上架').map((playlist) => playlist.id)
}

export function validateOrganizeScope(scope: OrganizeScope): void {
  if (!scope || !['include', 'exclude'].includes(scope.mode) || !Array.isArray(scope.playlistIds) ||
      scope.playlistIds.some((id) => !positiveId(id)) || new Set(scope.playlistIds).size !== scope.playlistIds.length) {
    throw new Error('目标歌单的允许或排除范围无效，请重新选择')
  }
}

export function isOrganizeTargetAllowed(scope: OrganizeScope, sourceId: number, targetId: number): boolean {
  return targetId !== sourceId && (scope.mode === 'include'
    ? scope.playlistIds.includes(targetId) : !scope.playlistIds.includes(targetId))
}

/** 从最新账号列表计算目标范围；收藏歌单及来源都不能成为写入目标。 */
export function resolveOrganizeTargets(
  userId: number, sourceId: number, playlists: readonly Playlist[], scope: OrganizeScope
): Playlist[] {
  validateOrganizeScope(scope)
  if (!positiveId(userId) || !positiveId(sourceId)) throw new Error('账号或来源歌单无效')
  const owned = playlists.filter((playlist) => playlist.creator.userId === userId)
  if (!owned.some((playlist) => playlist.id === sourceId)) throw new Error('来源必须是当前账号自己创建的歌单')
  if (scope.mode === 'include' && scope.playlistIds.some((id) => !owned.some((playlist) => playlist.id === id))) {
    throw new Error('允许的目标中有歌单已不存在或不属于本人，请重新加载')
  }
  return owned.filter((playlist) => isOrganizeTargetAllowed(scope, sourceId, playlist.id))
}

/** 个人规则必须有明确匹配值，不执行正则表达式或空字符串的全量匹配。 */
export function validateOrganizeRules(rules: readonly OrganizeRule[]): void {
  if (!Array.isArray(rules) || rules.length > 200 || new Set(rules.map((rule) => rule?.id)).size !== rules.length ||
      rules.some((rule) => !rule || typeof rule.id !== 'string' || !rule.id ||
        !['artist', 'album', 'text'].includes(rule.kind) || typeof rule.value !== 'string' ||
        rule.value.trim().length < 2 || rule.value.length > 200 || !positiveId(rule.targetPlaylistId))) {
    throw new Error('个人规则无效，请检查匹配内容和目标歌单')
  }
}

function matchesRule(song: PlaylistTextTrack, rule: OrganizeRule): boolean {
  const value = normalize(rule.value)
  if (rule.kind === 'artist') return song.artists.some((artist) => normalize(artist) === value)
  if (rule.kind === 'album') return normalize(song.album) === value
  return normalize(song.name + ' ' + song.album).includes(value)
}

function matchesWork(text: string, alias: string): boolean {
  const normalized = normalize(alias)
  if (/^[a-z0-9 '!]+$/i.test(normalized)) {
    const escaped = normalized.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
    return new RegExp('(?:^|[^a-z0-9])' + escaped + '(?:$|[^a-z0-9])', 'i').test(text)
  }
  // 短作品名必须有明确边界或版本标记，避免“远古剑客”等普通词句被自动归档。
  if (normalized.length <= 2) {
    return new RegExp('(?:^|[\\s【\\[（(《「『:：/])' + normalized +
      '(?=$|[\\s】\\]）)》」』:：/0-9一二三四五六七八九十]|原声|原聲|soundtrack|ost)', 'i').test(text)
  }
  return text.includes(normalized)
}

function certainMetadataReason(song: PlaylistTextTrack, targetName: string): string | null {
  const target = normalize(targetName)
  const artist = song.artists.find((name) => !genericArtists.has(normalize(name)) && normalize(name) === target)
  if (artist) return '歌手「' + artist + '」与目标歌单同名'
  if (targetName === '泽野弘之' && song.artists.includes('澤野弘之')) return '歌手澤野弘之对应泽野弘之'
  if (targetName === '初音' && song.artists.some((name) => ['初音ミク', 'Hatsune Miku'].includes(name))) {
    return '歌手明确包含初音ミク / Hatsune Miku'
  }
  const text = normalize(song.name + ' ' + song.album)
  const aliases = Object.prototype.hasOwnProperty.call(workAliases, targetName) ? workAliases[targetName] : []
  const alias = aliases.find((name) => matchesWork(text, name))
  if (alias) return '歌曲或专辑明确包含作品名「' + alias + '」'
  if (targetName === 'ACG' && /TVアニメ|TV ANIMATION|\banime\b|动画原声|动漫原声/i.test(song.album)) {
    return '专辑明确标记动画来源'
  }
  if (targetName === '电视电影等' &&
      (/电视(?:剧)?[\s\S]*?(?:原声|主题曲|插曲)|电影[\s\S]*?(?:原声|主题曲|插曲)/.test(song.album) ||
       /新笑傲江湖/.test(song.album))) return '专辑明确标记影视作品来源'
  if (targetName === '古风' &&
      /(?:^|[\s【[（(《「『:：/])(?:古风|国风)(?:$|[\s】\]）)》」』:：/]|音乐|歌曲)/.test(text)) {
    return '歌曲或专辑明确标记古风 / 国风'
  }
  return null
}

// 推断推荐需同时满足最低强度和领先差距；明确 ID、个人规则等不受此阈值限制。
const inferredScoreThreshold = 75
const inferredScoreMargin = 15

interface IndexedOrganizeTrack {
  readonly track: PlaylistTextTrack
  readonly name: string
  readonly artists: readonly string[]
  readonly album: string
  readonly works: readonly string[]
}

interface OrganizeEvidence {
  readonly profile: OrganizeProfile
  readonly artists: readonly IndexedOrganizeTrack[]
  readonly albums: readonly IndexedOrganizeTrack[]
  readonly works: readonly IndexedOrganizeTrack[]
  readonly versions: readonly IndexedOrganizeTrack[]
}

/** 只使用明确作品别名或有原声后缀的专辑名，通用“原声”“合集”等不能成为作品依据。 */
function identifyOrganizeWorks(song: PlaylistTextTrack): string[] {
  const text = normalize(song.name + ' ' + song.album)
  const works = Object.entries(workAliases).filter(([, aliases]) => aliases.some((alias) => matchesWork(text, alias)))
    .map(([name]) => normalize(name))
  const match = normalize(song.album).match(/^(.+?)[\s·:：-]+(?:原声(?:音乐|带|专辑)|original soundtrack|ost)(?:\s|$)/i)
  const title = match?.[1].replace(/^[《「]|[》」]$/g, '').trim()
  if (title && title.length >= 3 && !/原声|合集|精选|热门|群星|compilation|best/i.test(title) &&
      !/^(generic|original|游戏|动画|电影|电视剧|影视|音乐)$/i.test(title)) works.push(title)
  return [...new Set(works)]
}

function indexOrganizeTrack(track: PlaylistTextTrack): IndexedOrganizeTrack {
  const usable = track.detailsAvailable && !!track.name.trim()
  const album = normalize(track.album)
  return {
    track, name: usable ? normalize(track.name) : '',
    artists: usable ? [...new Set(track.artists.map(normalize).filter((name) => name && !genericArtists.has(name)))].sort() : [],
    album: usable && album && !/热门|合集|精选|best|compilation/i.test(album) &&
      !/^(专辑|原声|原声音乐|原声带|原创|翻唱|单曲|single|unknown|untitled|(?:generic )?(?:original )?soundtrack|ost|オリジナルサウンドトラック)$/i.test(album) ? album : '',
    works: usable ? identifyOrganizeWorks(track) : [],
  }
}

/** 推断不能把合作歌手混入他人的专属歌单，也不能推测个人回忆、语种或不相符的作品。 */
function inferredTargetRestriction(
  name: string, song: IndexedOrganizeTrack, knownArtists: ReadonlySet<string>, knownWorks: ReadonlySet<string>
): string | null {
  const target = normalize(name)
  const artistAliases = target === '初音' ? ['初音ミク', 'hatsune miku']
    : target === '泽野弘之' ? ['泽野弘之', '澤野弘之'] : knownArtists.has(target) ? [target] : []
  if (artistAliases.length && !artistAliases.some((artist) => song.artists.includes(artist))) {
    return '歌单对应其他歌手，合作演唱关联仅供参考'
  }
  if (knownWorks.has(target) && !song.works.includes(target)) return '尚无该作品的明确标记，需手工确认'
  if (/最近|未分类|待分类|喜欢|收藏|收纳|曾经|回忆|最烦|心情|^她$|^生而为人$/.test(target)) {
    return '个人收纳、回忆或心情类歌单需手工确认'
  }
  if (/^(华语|中文|国语|粤语|英语|英文|eng|english|日语|日文|japanese|韩语|韩文|korean)$/i.test(target)) {
    return '未取得演唱语种依据，需手工确认'
  }
  return null
}

/**
 * 从允许目标建立一次索引；跨歌单重复歌曲只计一次，缺失详情按可能落在其他目标估算。
 * 歌手依据同时看样本数量和归类集中度，专辑与作品取较强一项，避免同一来源重复加分。
 */
function createOrganizeAffinityReader(profiles: readonly OrganizeProfile[]) {
  const tracks = new Map<number, IndexedOrganizeTrack>()
  for (const profile of profiles) for (const track of profile.tracks) {
    if (!tracks.has(track.id)) tracks.set(track.id, indexOrganizeTrack(track))
  }
  const knownArtists = new Set([...tracks.values()].flatMap((track) => [...track.artists]))
  const knownWorks = new Set([...Object.keys(workAliases).map(normalize), ...[...tracks.values()].flatMap((track) => [...track.works])])
  const unknownCount = [...tracks.values()].filter((track) => !track.name).length +
    profiles.reduce((count, profile) => count + Math.max(0, profile.snapshot.reportedTrackCount - profile.snapshot.trackIds.length), 0)
  const indexed = profiles.map((profile) => ({
    profile, tracks: [...new Set(profile.snapshot.trackIds)].map((id) => tracks.get(id)).filter((track): track is IndexedOrganizeTrack => !!track),
  }))
  return (song: PlaylistTextTrack) => {
    const source = indexOrganizeTrack(song)
    const evidence: OrganizeEvidence[] = indexed.map(({ profile, tracks: members }) => {
      const peers = members.filter((track) => track.track.id !== song.id && !!track.name)
      return {
        profile,
        artists: peers.filter((track) => track.artists.some((artist) => source.artists.includes(artist))),
        albums: peers.filter((track) => source.album && track.album === source.album),
        works: peers.filter((track) => track.works.some((work) => source.works.includes(work))),
        versions: peers.filter((track) => source.artists.length > 0 && track.name === source.name &&
          JSON.stringify(track.artists) === JSON.stringify(source.artists)),
      }
    })
    const total = (kind: 'artists' | 'albums' | 'works') =>
      new Set(evidence.flatMap((item) => item[kind].map((track) => track.track.id))).size + unknownCount
    const totals = { artists: total('artists'), albums: total('albums'), works: total('works') }
    return evidence.map((item) => {
      const artistCount = item.artists.length, albumCount = item.albums.length, workCount = item.works.length
      const artistShare = artistCount / Math.max(1, totals.artists)
      const albumShare = albumCount / Math.max(1, totals.albums)
      const workShare = workCount / Math.max(1, totals.works)
      const artistScore = artistCount >= 2 ? 40 * Math.min(artistCount / 10, 1) + 45 * artistShare : 0
      const albumScore = albumCount >= 2 ? 45 * Math.min(albumCount / 4, 1) + 40 * albumShare : 0
      const workScore = workCount >= 2 ? 45 * Math.min(workCount / 4, 1) + 40 * workShare : 0
      const corroborated = artistCount >= 3 && (albumCount >= 2 && albumShare >= 0.75 || workCount >= 2 && workShare >= 0.75)
      const reasons: string[] = []
      if (artistCount >= 2) reasons.push('已有 ' + artistCount + ' 首同歌手歌曲')
      if (albumCount >= 2) reasons.push('已有 ' + albumCount + ' 首同专辑歌曲')
      if (workCount >= 2) reasons.push('已有 ' + workCount + ' 首同作品歌曲')
      if (item.versions.length) reasons.push('已有同名同歌手的其他 ID（' +
        item.versions.slice(0, 3).map((track) => track.track.id).join('、') + '），需确认版本')
      const restriction = inferredTargetRestriction(item.profile.snapshot.name, source, knownArtists, knownWorks)
      if (restriction && reasons.length) reasons.push(restriction)
      const score = Math.min(restriction ? 50 : 95, Math.round(Math.max(artistScore, albumScore, workScore,
        item.versions.length ? 40 : 0) + (corroborated ? 10 : 0)))
      const diverseArtistHistory = artistCount >= 8 && artistShare >= 0.8 &&
        new Set(item.artists.map((track) => track.album).filter(Boolean)).size >= 3 &&
        source.artists.every((artist) => item.artists.filter((track) => track.artists.includes(artist)).length >= 2)
      const releaseHistory = albumCount >= 4 && albumShare >= 0.75 || workCount >= 4 && workShare >= 0.75
      const distinctSongs = new Set([...item.artists, ...item.albums, ...item.works].map((track) => track.name)).size
      return {
        playlistId: item.profile.snapshot.id, score, reason: reasons.join('；'), hasOtherVersion: item.versions.length > 0,
        eligible: !restriction && distinctSongs >= 3 && (diverseArtistHistory || releaseHistory || corroborated),
      }
    })
  }
}

/** 明确去向可多选；其余只在首选样本充分、达到阈值且明显领先时默认选择一个。 */
function selectOrganizeDefaults(
  candidates: OrganizeCandidate[], eligible: ReadonlySet<number>, hasOtherVersion: boolean
): { candidates: readonly OrganizeCandidate[]; selectionReason: string } {
  candidates.sort((a, b) => Number(b.certain) - Number(a.certain) || (b.score ?? 0) - (a.score ?? 0) || a.playlistId - b.playlistId)
  const certainCount = candidates.filter((candidate) => candidate.certain).length
  const first = candidates[0]
  const lead = (first?.score ?? 0) - (candidates[1]?.score ?? 0)
  let selectionReason = '没有足够的归类依据，保留原地'
  if (certainCount) selectionReason = '分析时按明确依据默认勾选 ' + certainCount + ' 个去向，可逐首调整'
  else if (hasOtherVersion) selectionReason = '存在同名不同 ID 的版本，去向需手工确认'
  else if (first) {
    if ((first.score ?? 0) < inferredScoreThreshold || !eligible.has(first.playlistId)) {
      selectionReason = '首选的参考样本或归类依据仍不足，暂不默认勾选'
    } else if (lead < inferredScoreMargin) {
      selectionReason = '前两项推荐分接近（' + first.score + ' / ' + candidates[1].score + '），暂不默认勾选'
    } else {
      candidates[0] = { ...first, defaultSelected: true }
      selectionReason = '首选依据较强' + (candidates.length > 1 ? '，领先次选 ' + lead + ' 分' : '') + '，分析时默认勾选；可自行调整'
    }
  }
  return { candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))), selectionReason }
}

/**
 * 按本人目标歌单推荐多个去向：相同 ID、明确作品/歌手及用户规则可默认多选。
 * 其余候选按作品、专辑和歌手归类记录排序，仅默认选择充分且领先的首选；弱依据不强制归档。
 */
export function recommendExistingPlaylists(
  songs: readonly PlaylistTextTrack[],
  profiles: readonly OrganizeProfile[],
  rules: readonly OrganizeRule[] = [],
  decisions: readonly OrganizeAssignment[] = []
): OrganizeRecommendation[] {
  validateOrganizeRules(rules)
  const allowedIds = new Set(profiles.map((profile) => profile.snapshot.id))
  const ruleLabels = { artist: '歌手', album: '专辑', text: '关键词' }
  const readAffinities = createOrganizeAffinityReader(profiles)
  return songs.map((song) => {
    const candidates = new Map<number, OrganizeCandidate>()
    const affinities = song.detailsAvailable && song.name ? readAffinities(song) : []
    const hasOtherVersion = affinities.some((affinity) => affinity.hasOtherVersion)
    const addCertain = (playlistId: number, reason: string) => {
      if (!allowedIds.has(playlistId) || candidates.get(playlistId)?.certain) return
      candidates.set(playlistId, { playlistId, certain: true, reason, score: 100, defaultSelected: true })
    }
    for (const target of decisions.find((decision) => decision.songId === song.id)?.targetPlaylistIds || []) {
      addCertain(target, '沿用你此前确认并成功归档的同一歌曲 ID')
    }
    for (const profile of profiles) {
      const targetId = profile.snapshot.id
      if (profile.snapshot.trackIds.includes(song.id)) addCertain(targetId, '相同歌曲 ID 已存在于该歌单')
      if (!song.detailsAvailable || !song.name) continue
      for (const rule of rules) {
        if (rule.targetPlaylistId === targetId && matchesRule(song, rule)) {
          addCertain(targetId, '命中你保存的' + ruleLabels[rule.kind] + '规则：「' + rule.value + '」')
        }
      }
      const metadataReason = certainMetadataReason(song, profile.snapshot.name)
      if (metadataReason) addCertain(targetId, metadataReason)
    }
    for (const affinity of affinities) {
      if (affinity.reason && !candidates.has(affinity.playlistId)) candidates.set(affinity.playlistId, {
        playlistId: affinity.playlistId, certain: false, reason: affinity.reason, score: affinity.score, defaultSelected: false,
      })
    }
    const defaults = selectOrganizeDefaults([...candidates.values()],
      new Set(affinities.filter((affinity) => affinity.eligible).map((affinity) => affinity.playlistId)), hasOtherVersion)
    return Object.freeze({
      songId: song.id, ...defaults,
      warning: !song.detailsAvailable ? '未取得歌曲详情；除同一 ID 的已确认归档外，请保留原地或手工确认'
        : hasOtherVersion ? '同名不同 ID 可能是不同录音或版本，不按歌名合并或移除' : null,
    })
  })
}
