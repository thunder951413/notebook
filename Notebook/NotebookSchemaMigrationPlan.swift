import Foundation
import SwiftData

/// Schema 版本 1 —— 项目最初发布的 SwiftData 模型集合。
/// 仅包含未引入 `previewText` / `hasLegacyCheckboxMigrated` 字段时的实体定义。
enum NotebookSchemaV1: VersionedSchema {
    static var versionIdentifier = Schema.Version(1, 0, 0)

    static var models: [any PersistentModel.Type] {
        [
            BlockDocumentLibraryEntity.self,
            BlockDocumentFolderEntity.self,
            BlockDocumentTagEntity.self,
            BlockDocumentNoteEntity.self,
            BlockDocumentBlockEntity.self,
            BlockDocumentAssetEntity.self,
            BlockDocumentNoteVersionEntity.self,
            BlockDocumentNoteSyncStateEntity.self,
            BlockDocumentDeletedNoteTombstoneEntity.self
        ]
    }
}

/// Schema 版本 2 —— 在 V1 基础上为列表加载性能与旧版复选框迁移引入了两个轻量字段：
/// - `BlockDocumentNoteEntity.previewText: String`（默认 ""）
/// - `BlockDocumentNoteEntity.hasLegacyCheckboxMigrated: Bool`（默认 false）
///
/// 这两个字段均带默认值，SwiftData lightweight migration 可自动处理；
/// 此处的显式声明仅为版本记录，便于未来 V3+ 迁移做版本对齐。
enum NotebookSchemaV2: VersionedSchema {
    static var versionIdentifier = Schema.Version(2, 0, 0)

    static var models: [any PersistentModel.Type] {
        NotebookSchemaV1.models
    }
}

/// Schema 版本 3 —— 在 V2 基础上为 Note→Blocks / Note→Assets 引入 @Relationship(.cascade)，
/// 同时保留 noteID 字段以维持 predicate 查询兼容性。
///
/// 迁移时需要回填已有 Block/Asset 实体的 `note` 反向关系（旧数据该字段为 nil）。
enum NotebookSchemaV3: VersionedSchema {
    static var versionIdentifier = Schema.Version(3, 0, 0)

    static var models: [any PersistentModel.Type] {
        NotebookSchemaV1.models
    }
}

/// Schema 版本 4 —— 在 V3 基础上新增 `BlockDocumentNoteTagEntity` 关联表，
/// 为"按标签筛选笔记"提供 SQLite 索引查询。
/// `BlockDocumentNoteEntity.tagIDs` 字符串字段保留作为权威序列化格式。
enum NotebookSchemaV4: VersionedSchema {
    static var versionIdentifier = Schema.Version(4, 0, 0)

    static var models: [any PersistentModel.Type] {
        NotebookSchemaV1.models + [BlockDocumentNoteTagEntity.self]
    }
}

/// Schema 版本 5 —— 在 V4 基础上为 Todo 功能增加轻量字段和步骤实体。
///
/// - `BlockDocumentNoteEntity.itemType` 等 Todo 元数据字段
/// - `BlockDocumentFolderEntity.folderType`
/// - `TodoStepEntity`
enum NotebookSchemaV5: VersionedSchema {
    static var versionIdentifier = Schema.Version(5, 0, 0)

    static var models: [any PersistentModel.Type] {
        NotebookSchemaV4.models + [TodoStepEntity.self]
    }
}

/// Schema 演进清单（当前不连接到生产 ModelContainer）。
///
/// 重要：V1...V5 目前复用当前实体类型，因此这里只能用于记录版本序列和测试新增模型，
/// 不能安全表示真实历史 schema。生产环境使用迁移前完整数据库快照 + SwiftData 自动
/// lightweight migration。未来若出现删除/重命名/类型变更，必须把每个版本改成独立实体
/// 定义，并用真实旧 store fixture 验证后才能把本计划连接到 ModelContainer。
///
/// 当前记录：
/// - V1 → V2：字段新增（previewText / hasLegacyCheckboxMigrated），由 SwiftData 自动 lightweight migration 完成
/// - V2 → V3：@Relationship 引入，作为 lightweight migration 记录版本
/// - V3 → V4：tagIDs 关联表引入，作为 lightweight migration 记录版本；
///   关联表历史数据由 NoteStore.fetchData() 的 backfill 兜底补齐
/// - V4 → V5：Todo 轻量字段和 TodoStepEntity 引入，作为 lightweight migration 记录版本
enum NotebookSchemaMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] {
        [
            NotebookSchemaV1.self,
            NotebookSchemaV2.self,
            NotebookSchemaV3.self,
            NotebookSchemaV4.self,
            NotebookSchemaV5.self
        ]
    }

    static var stages: [MigrationStage] {
        [
            MigrationStage.lightweight(
                fromVersion: NotebookSchemaV1.self,
                toVersion: NotebookSchemaV2.self
            ),
            MigrationStage.lightweight(
                fromVersion: NotebookSchemaV2.self,
                toVersion: NotebookSchemaV3.self
            ),
            MigrationStage.lightweight(
                fromVersion: NotebookSchemaV3.self,
                toVersion: NotebookSchemaV4.self
            ),
            MigrationStage.lightweight(
                fromVersion: NotebookSchemaV4.self,
                toVersion: NotebookSchemaV5.self
            )
        ]
    }
}
