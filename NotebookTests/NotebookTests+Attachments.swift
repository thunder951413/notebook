import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook


extension NotebookTests {

    func testAttachmentTextAttachmentUsesEmbeddedDataWhenFileIsUnavailable() throws {
        let missingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let sourceURL = missingDirectory.appendingPathComponent("persisted-image.png")
        let sourceData = Data([0x89, 0x50, 0x4E, 0x47])
        let attachment = AttachmentTextAttachment(
            fileURL: sourceURL,
            kind: .image,
            embeddedFileData: sourceData,
            attachmentFilename: "persisted-image.png"
        )

        XCTAssertEqual(attachment.attachmentFilename, "persisted-image.png")
        XCTAssertEqual(attachment.kind, .image)
        XCTAssertEqual(attachment.attachmentData(), sourceData)
    }

    func testAudioBlockAttachmentKeepsOriginalFilenameAndManifest() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let audioURL = tempDirectory.appendingPathComponent("meeting.mp3")
        let manifestURL = tempDirectory.appendingPathComponent("meeting.tracks.json")
        try Data([0x01, 0x02, 0x03]).write(to: audioURL)
        try Data("{\"tracks\":2}".utf8).write(to: manifestURL)

        let attachment = AudioBlockAttachment(fileURL: audioURL, duration: 12, createDate: Date())

        XCTAssertEqual(attachment.attachmentFilename, "meeting.mp3")
        XCTAssertEqual(attachment.manifestFilename, "meeting.tracks.json")
        XCTAssertEqual(attachment.audioData(), Data([0x01, 0x02, 0x03]))
        XCTAssertEqual(attachment.manifestData(), Data("{\"tracks\":2}".utf8))
    }

    func testAudioBlockAttachmentUsesEmbeddedDataWhenFileIsUnavailable() {
        let missingDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let audioURL = missingDirectory.appendingPathComponent("copied.m4a")
        let audioData = Data([0x10, 0x20, 0x30])
        let manifestData = Data("{\"dual\":true}".utf8)

        let attachment = AudioBlockAttachment(
            fileURL: audioURL,
            duration: 8,
            createDate: Date(),
            embeddedAudioData: audioData,
            attachmentFilename: "copied.m4a",
            embeddedManifestData: manifestData
        )

        XCTAssertEqual(attachment.attachmentFilename, "copied.m4a")
        XCTAssertEqual(attachment.manifestFilename, "copied.tracks.json")
        XCTAssertEqual(attachment.audioData(), audioData)
        XCTAssertEqual(attachment.manifestData(), manifestData)
    }

    @MainActor
    func testNormalizedContentForSavingReusesManagedBlockAttachmentFile() throws {
        let noteID = UUID()
        let assetID = UUID().uuidString
        let baseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            StorageLocationManager.shared.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: baseDirectory)
        }

        let storage = StorageLocationManager.shared
        storage.setBaseDirectoryForTesting(baseDirectory)
        try storage.ensureDirectoryStructureExists()

        let attachmentsRoot = try storage.attachmentsDirectoryURL()
        let managedImageURL = attachmentsRoot
            .appendingPathComponent("BlockDocuments/\(noteID.uuidString)/\(assetID)", isDirectory: true)
            .appendingPathComponent("Attachment.png")
        try FileManager.default.createDirectory(at: managedImageURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: managedImageURL)

        let attachment = AttachmentTextAttachment(fileURL: managedImageURL, kind: .image)
        let content = NSAttributedString(attachment: attachment)

        let normalized = AttachmentManager.shared.normalizedContentForSaving(content, noteID: noteID)
        let normalizedAttachment = try XCTUnwrap(normalized.attribute(.attachment, at: 0, effectiveRange: nil) as? AttachmentTextAttachment)

        XCTAssertEqual(normalizedAttachment.attachmentFileURL.standardizedFileURL, managedImageURL.standardizedFileURL)
        XCTAssertEqual(normalizedAttachment.attachmentFilename, managedImageURL.lastPathComponent)

        let legacyNoteFolder = attachmentsRoot.appendingPathComponent(noteID.uuidString, isDirectory: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyNoteFolder.path))
    }

    func testRichTextEditorNormalizesLegacyDefaultColorsToAdaptiveTextColor() {
        let darkNormalized = RichTextEditor.normalizedDefaultForegroundColor(.black, for: .dark)
        let lightNormalized = RichTextEditor.normalizedDefaultForegroundColor(.white, for: .light)
        let customColor = NSColor.systemRed

        XCTAssertTrue(try XCTUnwrap(darkNormalized).isEqual(to: NSColor.textColor))
        XCTAssertTrue(try XCTUnwrap(lightNormalized).isEqual(to: NSColor.textColor))
        XCTAssertNil(RichTextEditor.normalizedDefaultForegroundColor(customColor, for: .dark))
        XCTAssertTrue(RichTextEditor.isLegacyDefaultTextColor(.black, for: .dark))
        XCTAssertFalse(RichTextEditor.isLegacyDefaultTextColor(customColor, for: .dark))
    }

    func testAttachmentAppearanceUsesSemanticSystemColors() {
        XCTAssertTrue(AttachmentAppearance.primaryTextColor.isEqual(to: NSColor.textColor))
        XCTAssertTrue(AttachmentAppearance.secondaryTextColor.isEqual(to: NSColor.secondaryLabelColor))
        XCTAssertTrue(AttachmentAppearance.backgroundColor.isEqual(to: NSColor.textBackgroundColor))
        XCTAssertTrue(AttachmentAppearance.secondaryBackgroundColor.isEqual(to: NSColor.controlBackgroundColor))
        XCTAssertTrue(AttachmentAppearance.borderColor.isEqual(to: NSColor.separatorColor))
        XCTAssertTrue(AttachmentAppearance.uncheckedStrokeColor.isEqual(to: NSColor.tertiaryLabelColor))
    }

    @MainActor
    func testRefreshAppearanceSensitiveAttachmentsRebuildsAttachmentImages() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let audioURL = tempDirectory.appendingPathComponent("theme-check.m4a")
        try Data([0x01, 0x02, 0x03]).write(to: audioURL)

        let audioAttachment = AudioBlockAttachment(fileURL: audioURL, duration: 5, createDate: Date())
        let tableAttachment = TableTextAttachment(rows: 2, columns: 2)
        let checkboxAttachment = CheckboxTextAttachment(checked: false)

        audioAttachment.image = nil
        tableAttachment.image = nil
        checkboxAttachment.image = nil

        let content = NSMutableAttributedString()
        content.append(NSAttributedString(attachment: audioAttachment))
        content.append(NSAttributedString(string: "\n"))
        content.append(NSAttributedString(attachment: tableAttachment))
        content.append(NSAttributedString(string: "\n"))
        content.append(NSAttributedString(attachment: checkboxAttachment))

        let textView = RichTextView(frame: .zero)
        textView.textStorage?.setAttributedString(content)

        RichTextEditor.refreshAppearanceSensitiveAttachments(in: textView)

        XCTAssertNotNil(audioAttachment.image)
        XCTAssertNotNil(tableAttachment.image)
        XCTAssertNotNil(checkboxAttachment.image)
    }

    @MainActor
    func testRefreshAppearanceSensitiveAttachmentsRerendersAttachmentBackgroundsForThemeChanges() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let audioURL = tempDirectory.appendingPathComponent("appearance-shift.m4a")
        try Data([0xAA, 0xBB, 0xCC]).write(to: audioURL)

        let audioAttachment = AudioBlockAttachment(fileURL: audioURL, duration: 7, createDate: Date())
        let tableAttachment = TableTextAttachment(rows: 2, columns: 2)
        tableAttachment.tableData.updateCell(row: 0, column: 0, value: "Theme")
        tableAttachment.updateImage()

        let content = NSMutableAttributedString()
        content.append(NSAttributedString(attachment: audioAttachment))
        content.append(NSAttributedString(string: "\n"))
        content.append(NSAttributedString(attachment: tableAttachment))

        let textView = RichTextView(frame: .zero)
        textView.textStorage?.setAttributedString(content)

        let lightAppearance = try XCTUnwrap(NSAppearance(named: .aqua))
        let darkAppearance = try XCTUnwrap(NSAppearance(named: .darkAqua))

        let lightAudioData = try XCTUnwrap(refreshedAttachmentRenderData(in: textView, appearance: lightAppearance, attachment: audioAttachment))
        let darkAudioData = try XCTUnwrap(refreshedAttachmentRenderData(in: textView, appearance: darkAppearance, attachment: audioAttachment))
        let lightTableData = try XCTUnwrap(refreshedAttachmentRenderData(in: textView, appearance: lightAppearance, attachment: tableAttachment))
        let darkTableData = try XCTUnwrap(refreshedAttachmentRenderData(in: textView, appearance: darkAppearance, attachment: tableAttachment))

        XCTAssertNotEqual(lightAudioData, darkAudioData)
        XCTAssertNotEqual(lightTableData, darkTableData)
    }

    func testAttachmentTextAttachmentKeepsOriginalFilename() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let sourceURL = tempDirectory.appendingPathComponent("sample-audio.mp3")
        let sourceData = Data([0x00, 0x11, 0x22, 0x33])
        try sourceData.write(to: sourceURL)

        let attachment = AttachmentTextAttachment(fileURL: sourceURL, kind: .audio)

        XCTAssertEqual(attachment.attachmentFilename, "sample-audio.mp3")
    }

    func testSerializedAttachmentsRecoverPresentationAfterRTFDRoundTrip() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)

        let storageManager = StorageLocationManager.shared
        storageManager.setBaseDirectoryForTesting(tempDirectory)
        defer {
            storageManager.setBaseDirectoryForTesting(nil)
            try? FileManager.default.removeItem(at: tempDirectory)
        }

        try storageManager.ensureDirectoryStructureExists()

        let noteID = UUID()
        let audioURL = tempDirectory.appendingPathComponent("roundtrip-audio.m4a")
        let manifestURL = tempDirectory.appendingPathComponent("roundtrip-audio.tracks.json")
        try Data([0x11, 0x22, 0x33]).write(to: audioURL)
        try Data("{\"tracks\":2}".utf8).write(to: manifestURL)

        let audioAttachment = AudioBlockAttachment(fileURL: audioURL, duration: 11, createDate: Date())
        let tableAttachment = TableTextAttachment(rows: 2, columns: 2)
        tableAttachment.tableData.updateCell(row: 0, column: 0, value: "A1")
        tableAttachment.updateImage()
        let content = NSMutableAttributedString()
        let audioRange = NSRange(location: content.length, length: 1)
        content.append(NSAttributedString(attachment: audioAttachment))
        content.addAttribute(.link, value: audioURL, range: audioRange)
        content.append(NSAttributedString(string: "\n"))
        let tableRange = NSRange(location: content.length, length: 1)
        content.append(NSAttributedString(attachment: tableAttachment))
        let tableData = try JSONEncoder().encode(tableAttachment.tableData)
        content.addAttribute(.notebookTableData, value: tableData, range: tableRange)

        let request = try XCTUnwrap(
            NoteSaveManager.shared.createRequest(
                noteID: noteID,
                title: "序列化附件",
                folderID: nil,
                folder: "未分类",
                reminderAt: nil,
                recurrenceRule: "none",
                content: content,
                reason: "test"
            )
        )
        let decoded = try XCTUnwrap(
            NSAttributedString(
                data: request.rtfdData,
                options: [.documentType: NSAttributedString.DocumentType.rtfd],
                documentAttributes: nil
            )
        )

        let textView = RichTextView(frame: .zero)
        textView.textStorage?.setAttributedString(decoded)
        textView.normalizeAttachmentsAfterLoad()
        RichTextEditor.refreshAppearanceSensitiveAttachments(in: textView)

        var foundLinkedAttachment = false
        var foundTable = false

        let textStorage = try XCTUnwrap(textView.textStorage)
        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length), options: []) { value, range, _ in
            guard let attachment = value as? NSTextAttachment else { return }
            let hasLink = textStorage.attribute(.link, at: range.location, effectiveRange: nil) != nil

            if let audio = attachment as? AudioBlockAttachment {
                foundLinkedAttachment = true
                XCTAssertNotNil(audio.image)
                XCTAssertTrue(hasLink)
                return
            }

            if let audio = attachment as? AttachmentTextAttachment, audio.kind == .audio {
                foundLinkedAttachment = true
                XCTAssertNotNil(audio.image)
                XCTAssertTrue(hasLink)
                return
            }

            if !(attachment is TableTextAttachment), hasLink {
                foundLinkedAttachment = true
                XCTAssertNotNil(attachment.image)
                return
            }

            if let table = attachment as? TableTextAttachment {
                foundTable = true
                XCTAssertNotNil(table.image)
                XCTAssertEqual(table.tableData.rows.first?.first, "A1")
            }
        }

        XCTAssertTrue(foundLinkedAttachment)
        XCTAssertTrue(foundTable)
    }
}
