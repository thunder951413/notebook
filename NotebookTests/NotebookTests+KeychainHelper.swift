import XCTest
@testable import Notebook

// MARK: - KeychainHelper 单元测试

extension NotebookTests {
    /// save → load → delete 往返：验证基础读写正确性
    func testKeychainHelperSaveLoadDeleteRoundTrip() throws {
        let service = "com.notebook.tests.keychain.\(UUID().uuidString)"
        let account = "test-account"
        let payload = "test-secret-value".data(using: .utf8)!

        // 清理可能残留的同名条目
        try? KeychainHelper.delete(service: service, account: account)

        // save
        try KeychainHelper.save(payload, service: service, account: account)

        // load
        let loaded = KeychainHelper.load(service: service, account: account)
        XCTAssertEqual(loaded, payload, "save 后 load 应返回相同数据")

        // loadString
        let loadedString = KeychainHelper.loadString(service: service, account: account)
        XCTAssertEqual(loadedString, "test-secret-value")

        // delete
        try KeychainHelper.delete(service: service, account: account)
        XCTAssertNil(KeychainHelper.load(service: service, account: account), "delete 后 load 应返回 nil")
    }

    /// save 幂等性：重复 save 应覆盖旧值，不报错
    func testKeychainHelperSaveIsIdempotent() throws {
        let service = "com.notebook.tests.keychain.\(UUID().uuidString)"
        let account = "test-account"

        try KeychainHelper.save("first".data(using: .utf8)!, service: service, account: account)
        try KeychainHelper.save("second".data(using: .utf8)!, service: service, account: account)

        let loaded = KeychainHelper.loadString(service: service, account: account)
        XCTAssertEqual(loaded, "second", "重复 save 应覆盖旧值")

        try KeychainHelper.delete(service: service, account: account)
    }

    /// delete 不存在的条目应静默成功（errSecItemNotFound 不抛错）
    func testKeychainHelperDeleteMissingIsSilent() throws {
        let service = "com.notebook.tests.keychain.missing.\(UUID().uuidString)"
        let account = "nonexistent"

        // 不应抛错
        try KeychainHelper.delete(service: service, account: account)
        XCTAssertTrue(true, "删除不存在的 keychain 条目应静默成功")
    }

    /// load 不存在的条目应返回 nil
    func testKeychainHelperLoadMissingReturnsNil() {
        let service = "com.notebook.tests.keychain.missing.\(UUID().uuidString)"
        let account = "nonexistent"

        let result = KeychainHelper.load(service: service, account: account)
        XCTAssertNil(result, "load 不存在的条目应返回 nil")
    }

    /// save 空数据应正常工作
    func testKeychainHelperSaveEmptyData() throws {
        let service = "com.notebook.tests.keychain.\(UUID().uuidString)"
        let account = "test-account"
        let emptyData = Data()

        try KeychainHelper.save(emptyData, service: service, account: account)
        let loaded = KeychainHelper.load(service: service, account: account)
        XCTAssertEqual(loaded, emptyData)

        try KeychainHelper.delete(service: service, account: account)
    }
}
