import { validateOrganizeRules, validateOrganizeScope } from '@/classifier/playlist-organizer'
import type { OrganizePreferences } from '@/types/playlist-organize'

const keyFor = (userId: number) => 'tn_organize_preferences_' + userId
const validId = (id: number) => Number.isSafeInteger(id) && id > 0

/** 存储按账号隔离；旧数据或无效规则不参与推荐，更不会扩大归档目标范围。 */
function validatePreferences(value: OrganizePreferences): void {
  if (!value || value.version !== 1 || (value.sourceId !== null && !validId(value.sourceId)) ||
      !Array.isArray(value.decisions) || value.decisions.length > 5000 ||
      new Set(value.decisions.map((decision) => decision?.songId)).size !== value.decisions.length ||
      value.decisions.some((decision) => !decision || !validId(decision.songId) ||
        !Array.isArray(decision.targetPlaylistIds) || decision.targetPlaylistIds.some((id) => !validId(id)) ||
        new Set(decision.targetPlaylistIds).size !== decision.targetPlaylistIds.length)) {
    throw new Error('保存的归档设置无效，请重新配置')
  }
  validateOrganizeScope({ mode: value.mode, playlistIds: value.mode === 'include' ? value.includedIds : value.excludedIds })
  validateOrganizeScope({ mode: 'include', playlistIds: value.includedIds })
  validateOrganizeScope({ mode: 'exclude', playlistIds: value.excludedIds })
  validateOrganizeRules(value.rules)
}

export async function loadOrganizePreferences(userId: number): Promise<OrganizePreferences | null> {
  if (!validId(userId)) throw new Error('无法读取无效账号的归档设置')
  const key = keyFor(userId)
  const saved = (await chrome.storage.local.get(key))[key] as OrganizePreferences | undefined
  if (!saved) return null
  validatePreferences(saved)
  return saved
}

export async function saveOrganizePreferences(userId: number, preferences: OrganizePreferences): Promise<void> {
  if (!validId(userId)) throw new Error('无法保存无效账号的归档设置')
  validatePreferences(preferences)
  await chrome.storage.local.set({ [keyFor(userId)]: preferences })
}
