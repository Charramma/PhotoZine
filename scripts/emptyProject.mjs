import { randomUUID } from 'node:crypto'

/**
 * 空项目文档：给冒烟脚本与开发用新建命令使用的夹具。
 *
 * 形状的唯一真值是 `src/shared/domain/project/schema.ts`，这里只是它的一个实例；
 * 写错或漂移不需要额外的守卫用例 —— `project:open` 会按契约校验并拒绝，冒烟随之失败。
 *
 * `templateId` 指向 T6 才落地的模板注册表：在那之前所有版式都算未知，
 * 校验器按不变式 I-08 只告警不猜槽位数，因此空文档可以照常打开。
 */
export function emptyProject({ name, now = new Date().toISOString(), id = randomUUID() }) {
  return {
    schemaVersion: 1,
    meta: { id, name, subtitle: '', coverPhotoId: null, createdAt: now, updatedAt: now },
    layout: { templateId: 'travel-chronicle', pageSize: 'A4-portrait', showPageNumbers: true },
    export: { quality: 'dpi300', includeCover: true },
    photos: [],
    pages: []
  }
}
