import XCTest

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

        XCTAssertTrue(app.windows["Notebook"].waitForExistence(timeout: 10))
        app.terminate()
    }
}
