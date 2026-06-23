import Foundation
import SwiftData

struct BlockDocumentIntegrityIssue: Codable, Hashable {
    enum Kind: String, Codable {
        case orphanBlock
        case orphanAsset
        case orphanVersion
        case orphanSyncState
        case orphanTombstone
        case missingTag
        case missingFolder
        case countMismatch
    }

    let kind: Kind
    let ownerID: UUID
    let referencedID: String
    let message: String
}

struct BlockDocumentIntegrityReport: Codable {
    let checkedAt: Date
    let noteCount: Int
    let blockCount: Int
    let assetCount: Int
    let issueCount: Int
    let issues: [BlockDocumentIntegrityIssue]

    var isClean: Bool {
        issues.isEmpty
    }
}

enum BlockDocumentIntegrityValidator {
    static func validate(context: ModelContext) throws -> BlockDocumentIntegrityReport {
        let notes = try context.fetch(FetchDescriptor<BlockDocumentNoteEntity>())
        let blocks = try context.fetch(FetchDescriptor<BlockDocumentBlockEntity>())
        let assets = try context.fetch(FetchDescriptor<BlockDocumentAssetEntity>())
        let versions = try context.fetch(FetchDescriptor<BlockDocumentNoteVersionEntity>())
        let syncStates = try context.fetch(FetchDescriptor<BlockDocumentNoteSyncStateEntity>())
        let tombstones = try context.fetch(FetchDescriptor<BlockDocumentDeletedNoteTombstoneEntity>())
        let tags = try context.fetch(FetchDescriptor<BlockDocumentTagEntity>())
        let folders = try context.fetch(FetchDescriptor<BlockDocumentFolderEntity>())

        let noteIDs = Set(notes.map(\.id))
        let tagIDs = Set(tags.map(\.id))
        let folderIDs = Set(folders.map(\.id))
        var issues: [BlockDocumentIntegrityIssue] = []

        for block in blocks where !noteIDs.contains(block.noteID) {
            issues.append(
                issue(.orphanBlock, ownerID: block.noteID, referencedID: block.blockID, "块引用了不存在的笔记")
            )
        }

        for asset in assets where !noteIDs.contains(asset.noteID) {
            issues.append(
                issue(.orphanAsset, ownerID: asset.noteID, referencedID: asset.assetID, "附件引用了不存在的笔记")
            )
        }

        for version in versions where !noteIDs.contains(version.noteID) {
            issues.append(
                issue(.orphanVersion, ownerID: version.noteID, referencedID: version.version.description, "历史版本引用了不存在的笔记")
            )
        }

        for state in syncStates where !noteIDs.contains(state.noteID) {
            issues.append(
                issue(.orphanSyncState, ownerID: state.noteID, referencedID: state.noteID.uuidString, "同步状态引用了不存在的笔记")
            )
        }

        for tombstone in tombstones where noteIDs.contains(tombstone.noteID) {
            issues.append(
                issue(.orphanTombstone, ownerID: tombstone.noteID, referencedID: tombstone.noteID.uuidString, "删除墓碑仍指向现存笔记")
            )
        }

        for note in notes {
            for tagID in UUIDListCoding.decode(note.tagIDs) where !tagIDs.contains(tagID) {
                issues.append(
                    issue(.missingTag, ownerID: note.id, referencedID: tagID.uuidString, "笔记引用了不存在的标签")
                )
            }

            if let folderID = note.folderID, !folderIDs.contains(folderID) {
                issues.append(
                    issue(.missingFolder, ownerID: note.id, referencedID: folderID.uuidString, "笔记引用了不存在的文件夹")
                )
            }
        }

        let blocksByNoteID = Dictionary(grouping: blocks, by: \.noteID)
        let assetsByNoteID = Dictionary(grouping: assets, by: \.noteID)
        for note in notes {
            let actualBlockCount = blocksByNoteID[note.id, default: []].count
            if note.blockCount != actualBlockCount {
                issues.append(
                    issue(.countMismatch, ownerID: note.id, referencedID: "blocks", "笔记块计数不一致: stored=\(note.blockCount), actual=\(actualBlockCount)")
                )
            }

            let actualAssetCount = assetsByNoteID[note.id, default: []].count
            if note.assetCount != actualAssetCount {
                issues.append(
                    issue(.countMismatch, ownerID: note.id, referencedID: "assets", "笔记附件计数不一致: stored=\(note.assetCount), actual=\(actualAssetCount)")
                )
            }
        }

        return BlockDocumentIntegrityReport(
            checkedAt: Date(),
            noteCount: notes.count,
            blockCount: blocks.count,
            assetCount: assets.count,
            issueCount: issues.count,
            issues: issues
        )
    }

    private static func issue(
        _ kind: BlockDocumentIntegrityIssue.Kind,
        ownerID: UUID,
        referencedID: String,
        _ message: String
    ) -> BlockDocumentIntegrityIssue {
        BlockDocumentIntegrityIssue(kind: kind, ownerID: ownerID, referencedID: referencedID, message: message)
    }
}
