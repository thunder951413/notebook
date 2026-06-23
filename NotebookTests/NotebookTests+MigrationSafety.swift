import XCTest
import SwiftData
import AppKit
import SwiftUI
@testable import Notebook

// MARK: - Migration safety tests

extension NotebookTests {
    @MainActor
    func testMigrationSafetyCreatesDatabaseBackupBeforeUnknownStoreVersion() throws {
        let root = FileManager.default.temporaryDirectory
        let notebookData = root.appendingPathComponent("NotebookData", isDirectory: true)
        let database = notebookData.appendingPathComponent("Database", isDirectory: true)
        let store = database.appendingPathComponent("notebook.store")

        // 清理上次运行的残留
        try? FileManager.default.removeItem(at: notebookData)

        // 创建空的 store 文件和 database 目录
        try FileManager.default.createDirectory(at: database, withIntermediateDirectories: true)
        try Data().write(to: store, options: .atomic)

        // 模拟一个不同的旧版本号（状态文件不存在，视为未知版本）
        try PersistenceMigrationSafety.prepareStoreForOpening(
            storeURL: store,
            databaseDirectory: database,
            notebookDataDirectory: notebookData,
            targetFormatVersion: 2,
            reason: "testMigrationSafety"
        )

        // 验证备份被创建
        let backupURL = try XCTUnwrap(PersistenceMigrationSafety.latestBackup(in: notebookData))
        let backedUpStore = backupURL
            .appendingPathComponent("Database", isDirectory: true)
            .appendingPathComponent("notebook.store")
        XCTAssertTrue(FileManager.default.fileExists(atPath: backedUpStore.path), "Backup should contain store file")

        // 验证 manifest 包含正确的版本信息
        let manifestURL = backupURL.appendingPathComponent("manifest.json")
        let manifest = try JSONDecoder().decode(
            PersistenceMigrationBackupManifest.self,
            from: Data(contentsOf: manifestURL)
        )
        XCTAssertNil(manifest.sourceFormatVersion, "旧版本号应为 nil（无状态文件）")
        XCTAssertEqual(manifest.targetFormatVersion, 2)

        // 恢复到新的 database 位置
        let restoreDir = notebookData.appendingPathComponent("RestoredDatabase", isDirectory: true)
        try PersistenceMigrationSafety.restoreBackup(backupURL, to: restoreDir)
        let restoredStore = restoreDir.appendingPathComponent("notebook.store")
        XCTAssertTrue(FileManager.default.fileExists(atPath: restoredStore.path))

        // 清理
        try FileManager.default.removeItem(at: notebookData)
    }
}