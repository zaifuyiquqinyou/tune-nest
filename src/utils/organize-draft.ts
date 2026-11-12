import type { OrganizeAssignment, PlaylistOrganizePreview } from '@/types/playlist-organize'

interface OrganizeDraft {
  readonly version: 1
  readonly sourceId: number
  readonly choices: readonly OrganizeAssignment[]
}

const validId = (id: number) => Number.isSafeInteger(id) && id > 0
const draftKey = (userId: number, sourceId: number) => 'tn_organize_draft_' + userId + '_' + sourceId

/** 只恢复本次来源中仍存在的歌曲和允许目标；明确未选不会被推荐默认值覆盖。 */
export function restoreOrganizeChoices(
  preview: PlaylistOrganizePreview, choices: readonly OrganizeAssignment[]
): Record<number, number[]> {
  const saved = new Map(choices.map((item) => [item.songId, item.targetPlaylistIds]))
  const allowed = new Set(preview.targets.map((target) => target.id))
  return Object.fromEntries(preview.recommendations.map((recommendation) => [recommendation.songId,
    [...(saved.get(recommendation.songId) ?? recommendation.candidates.filter((item) => item.defaultSelected).map((item) => item.playlistId))]
      .filter((id) => allowed.has(id)),
  ]))
}

/** 草稿仅恢复勾选，不授权写入；后续预览还会按最新来源和允许目标过滤。 */
function validateDraft(draft: OrganizeDraft, sourceId: number): void {
  if (!draft || draft.version !== 1 || draft.sourceId !== sourceId || !Array.isArray(draft.choices) ||
      draft.choices.length > 100000 || new Set(draft.choices.map((item) => item?.songId)).size !== draft.choices.length ||
      draft.choices.some((item) => !item || !validId(item.songId) || !Array.isArray(item.targetPlaylistIds) ||
        new Set(item.targetPlaylistIds).size !== item.targetPlaylistIds.length || item.targetPlaylistIds.some((id: number) => !validId(id)))) {
    throw new Error('归档选择草稿无效，请重新确认勾选')
  }
}

export async function loadOrganizeDraft(userId: number, sourceId: number): Promise<readonly OrganizeAssignment[]> {
  if (!validId(userId) || !validId(sourceId)) throw new Error('无法读取无效账号或来源的归档草稿')
  const key = draftKey(userId, sourceId)
  const draft = (await chrome.storage.local.get(key))[key] as OrganizeDraft | undefined
  if (!draft) return []
  validateDraft(draft, sourceId)
  return draft.choices
}

/** 执行前持久保存每首歌的选择，包括明确未选；失败后刷新页面也可恢复。 */
export async function saveOrganizeDraft(
  userId: number, sourceId: number, choices: readonly OrganizeAssignment[]
): Promise<void> {
  if (!validId(userId) || !validId(sourceId)) throw new Error('无法保存无效账号或来源的归档草稿')
  const draft: OrganizeDraft = { version: 1, sourceId, choices }
  validateDraft(draft, sourceId)
  await chrome.storage.local.set({ [draftKey(userId, sourceId)]: draft })
}
