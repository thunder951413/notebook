import Foundation
import SwiftData

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

enum NotebookSchemaMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] {
        [
            NotebookSchemaV1.self
        ]
    }

    static var stages: [MigrationStage] {
        []
    }
}
