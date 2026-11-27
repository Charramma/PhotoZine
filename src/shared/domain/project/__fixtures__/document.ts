import { PROJECT_SCHEMA_VERSION, type PhotoItem, type ProjectDocument } from '../schema'

/** 测试夹具：一份形状完整、可直接落盘的项目文档，按需覆写（schema 一致性由 schema.test.ts 断言） */

export const PHOTO_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
] as const

export const PAGE_IDS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
] as const

const TEMPLATE_ID = 'editorial-white'

export function makePhoto(index = 0, patch: Partial<PhotoItem> = {}): PhotoItem {
  const id: string = PHOTO_IDS[index % PHOTO_IDS.length] as string
  return {
    id,
    fileName: `IMG_${id.slice(0, 8)}.jpg`,
    sourcePath: `/example-source/IMG_${id.slice(0, 8)}.jpg`,
    bytes: 4_200_000,
    hash: `${'a'.repeat(60)}${(index + 1).toString().padStart(4, '0')}`,
    takenAt: '2026-05-01T09:30:00.000Z',
    camera: 'iPhone 15 Pro',
    displayWidth: 4000,
    displayHeight: 3000,
    encodedWidth: 4000,
    encodedHeight: 3000,
    orientation: 1,
    aspect: 4 / 3,
    description: { blocks: [{ runs: [{ text: '海边的清晨' }] }] },
    ...patch
  }
}

export function makeDocument(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    meta: {
      id: '00000000-0000-4000-8000-000000000001',
      name: '夏日纪行',
      subtitle: '',
      coverPhotoId: PHOTO_IDS[0] as string,
      createdAt: '2026-05-02T02:00:00.000Z',
      updatedAt: '2026-05-02T02:00:00.000Z'
    },
    layout: { templateId: TEMPLATE_ID, pageSize: 'A4-portrait', showPageNumbers: true },
    export: { quality: 'dpi300', includeCover: true },
    photos: [makePhoto(0), makePhoto(1)],
    pages: [],
    ...overrides
  }
}

/** 落盘文本，供需要"磁盘原文"的用例使用 */
export function makeDocumentJson(document: ProjectDocument): string {
  return JSON.stringify(document, null, 2)
}
