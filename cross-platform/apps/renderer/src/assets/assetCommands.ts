import type { Asset } from '@notebook/domain'

export const INSERT_ASSET_EVENT = 'notebook:insert-asset'

export interface InsertAssetDetail {
  pageId: string
  asset: Asset
  position?: number
}

export function insertAssetIntoEditor(pageId: string, asset: Asset, position?: number) {
  window.dispatchEvent(new CustomEvent<InsertAssetDetail>(INSERT_ASSET_EVENT, {
    detail: { pageId, asset, position },
  }))
}
