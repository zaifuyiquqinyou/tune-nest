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

/**
 * 按本人目标歌单推荐多个去向：相同 ID、明确作品/歌手及用户规则可默认选择。
 * 同歌手、同专辑及同名异 ID 仅显示待确认建议；没有依据时返回空去向，绝不强制兜底。
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
  return songs.map((song) => {
    const candidates = new Map<number, OrganizeCandidate>()
    let hasOtherVersion = false
    const add = (playlistId: number, certain: boolean, reason: string) => {
      if (!allowedIds.has(playlistId)) return
      const previous = candidates.get(playlistId)
      if (!previous || certain && !previous.certain) candidates.set(playlistId, { playlistId, certain, reason })
    }
    for (const target of decisions.find((decision) => decision.songId === song.id)?.targetPlaylistIds || []) {
      add(target, true, '沿用你此前确认并成功归档的同一歌曲 ID')
    }
    for (const profile of profiles) {
      const targetId = profile.snapshot.id
      if (profile.snapshot.trackIds.includes(song.id)) add(targetId, true, '相同歌曲 ID 已存在于该歌单')
      if (!song.detailsAvailable || !song.name) continue
      for (const rule of rules) {
        if (rule.targetPlaylistId === targetId && matchesRule(song, rule)) {
          add(targetId, true, '命中你保存的' + ruleLabels[rule.kind] + '规则：「' + rule.value + '」')
        }
      }
      const metadataReason = certainMetadataReason(song, profile.snapshot.name)
      if (metadataReason) add(targetId, true, metadataReason)
      const variants = profile.tracks.filter((track) => track.id !== song.id && normalize(track.name) === normalize(song.name) &&
        JSON.stringify(track.artists.map(normalize).sort()) === JSON.stringify(song.artists.map(normalize).sort()))
      if (variants.length > 0) {
        hasOtherVersion = true
        add(targetId, false, '已有同名同歌手的其他 ID（' + variants.slice(0, 3).map((track) => track.id).join('、') + '），需确认版本')
      }
      const peers = profile.tracks.filter((track) => track.id !== song.id && track.artists.some((artist) =>
        !genericArtists.has(normalize(artist)) && song.artists.some((name) => normalize(name) === normalize(artist))))
      if (peers.length >= 2) add(targetId, false, '已有 ' + peers.length + ' 首同歌手歌曲，仅作个人偏好参考')
      if (song.album && !/热门|合集|精选|best|compilation/i.test(song.album)) {
        const albumPeers = profile.tracks.filter((track) => track.id !== song.id && normalize(track.album) === normalize(song.album))
        if (albumPeers.length >= 2) add(targetId, false, '已有 ' + albumPeers.length + ' 首同专辑歌曲，作品归属仍需确认')
      }
    }
    return Object.freeze({
      songId: song.id,
      candidates: Object.freeze([...candidates.values()].sort((a, b) => Number(b.certain) - Number(a.certain))),
      warning: !song.detailsAvailable ? '未取得歌曲详情；除同一 ID 的已确认归档外，请保留原地或手工确认'
        : hasOtherVersion ? '同名不同 ID 可能是不同录音或版本，不按歌名合并或移除' : null,
    })
  })
}
