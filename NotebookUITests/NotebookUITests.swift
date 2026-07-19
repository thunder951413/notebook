import XCTest

@MainActor
final class NotebookUITests: XCTestCase {
    func testAppLaunchesWithIsolatedEmptyLibrary() throws {
        let isolatedDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookUITests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: isolatedDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: isolatedDirectory) }

        let app = XCUIApplication()
        app.launchEnvironment["NOTEBOOK_UI_TEST_DATA_DIR"] = isolatedDirectory.path
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        app.activate()

        XCTAssertTrue(app.windows["Notebook"].waitForExistence(timeout: 10))
        app.terminate()
    }

    func testCreateEditPersistAndRecycleNote() throws {
        let isolatedDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NotebookUITests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: isolatedDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: isolatedDirectory) }

        // XCUI 在部分 macOS beta 上合成中文输入事件会超时；ASCII 同样覆盖完整保存链路。
        let title = "UI Regression Note \(UUID().uuidString.prefix(8))"
        let body = "Body persisted across application relaunch."
        var app = makeApplication(dataDirectory: isolatedDirectory)
        app.launch()
        app.activate()

        let newItemButton = app.buttons["notebook.newItem"]
        XCTAssertTrue(newItemButton.waitForExistence(timeout: 10))
        newItemButton.click()

        let titleField = app.textFields["notebook.noteTitle"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 10))
        app.activate()
        titleField.click()
        // 首次聚焦输入框可能唤起系统输入法设置；切回应用后再次聚焦。
        app.activate()
        titleField.click()
        titleField.typeText(title)

        let bodyEditor = app.textViews["notebook.noteBody"]
        XCTAssertTrue(bodyEditor.waitForExistence(timeout: 10))
        app.activate()
        bodyEditor.click()
        // macOS 测试进程首次请求输入法时可能把系统设置置于前台。
        // 重新激活并聚焦正文，避免按键被发送到系统设置而产生假性保存失败。
        app.activate()
        bodyEditor.click()
        bodyEditor.typeText(body)
        XCTAssertTrue((bodyEditor.value as? String)?.contains(body) == true, "正文输入应先在编辑器中可见")
        let saveButton = app.buttons["notebook.saveItem"]
        XCTAssertTrue(saveButton.waitForExistence(timeout: 5))
        // 输入法设置窗口可能在 XCUI 合成首次正文输入后抢到前台，保存前显式切回。
        app.activate()
        saveButton.click()
        let savedTitle = try XCTUnwrap(titleField.value as? String)
        XCTAssertTrue(savedTitle.contains("UI Regression Note"))

        app.terminate()
        app = makeApplication(dataDirectory: isolatedDirectory)
        app.launch()
        app.activate()

        let persistedTitleField = app.textFields["notebook.noteTitle"]
        XCTAssertTrue(persistedTitleField.waitForExistence(timeout: 10), "重启后应恢复已保存笔记")
        XCTAssertEqual(persistedTitleField.value as? String, savedTitle)
        let persistedBody = app.textViews["notebook.noteBody"]
        XCTAssertTrue(persistedBody.waitForExistence(timeout: 10))
        XCTAssertTrue((persistedBody.value as? String)?.contains(body) == true)

        let deleteButton = app.buttons["notebook.deleteItem"]
        XCTAssertTrue(deleteButton.isEnabled)
        deleteButton.click()
        let confirmDeleteButton = app.sheets.buttons["删除"].firstMatch
        XCTAssertTrue(confirmDeleteButton.waitForExistence(timeout: 5))
        confirmDeleteButton.click()

        let recycleBin = app.buttons.matching(
            NSPredicate(format: "identifier == %@ AND label == %@", "notebook.recycleBin", "回收站")
        ).firstMatch
        XCTAssertTrue(recycleBin.waitForExistence(timeout: 5))
        recycleBin.click()
        let recycledRow = app.staticTexts.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "notebook.recycleNoteRow.")
        ).firstMatch
        XCTAssertTrue(recycledRow.waitForExistence(timeout: 5), "删除的笔记应进入回收站")

        app.terminate()
    }

    private func makeApplication(dataDirectory: URL) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["NOTEBOOK_UI_TEST_DATA_DIR"] = dataDirectory.path
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        return app
    }
}
