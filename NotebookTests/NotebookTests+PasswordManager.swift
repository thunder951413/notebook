import XCTest
import CryptoKit
@testable import Notebook

// MARK: - PasswordManager 单元测试

extension NotebookTests {
    /// setPassword → verifyPassword 往返：验证 PBKDF2 哈希正确性
    @MainActor
    func testPasswordManagerSetAndVerifyPassword() {
        let manager = isolatedPasswordManager()
        let testPassword = "test-password-\(UUID().uuidString)"

        // 清理可能的残留
        manager.forceClearPassword()

        // 设置密码
        XCTAssertTrue(manager.setPassword(testPassword), "setPassword 应返回 true")
        XCTAssertTrue(manager.hasPassword, "hasPassword 应为 true")

        // 验证正确密码
        XCTAssertTrue(manager.verifyPassword(testPassword), "verifyPassword 正确密码应返回 true")

        // 验证错误密码
        XCTAssertFalse(manager.verifyPassword("wrong-password"), "verifyPassword 错误密码应返回 false")

        // 清理
        XCTAssertTrue(manager.clearPassword(currentPassword: testPassword), "clearPassword 应返回 true")
        XCTAssertFalse(manager.hasPassword, "clearPassword 后 hasPassword 应为 false")
    }

    /// setPassword 不足最短长度的密码应失败
    @MainActor
    func testPasswordManagerRejectsShortPassword() {
        let manager = isolatedPasswordManager()
        manager.forceClearPassword()

        XCTAssertFalse(manager.setPassword(""), "空密码应被拒绝")
        XCTAssertFalse(
            manager.setPassword(String(repeating: "a", count: PasswordManager.minimumPasswordLength - 1)),
            "不足最短长度的密码应被拒绝"
        )
        XCTAssertFalse(manager.hasPassword)
    }

    /// 旧版短密码仍可验证，并在成功验证后迁移为 PBKDF2 记录
    @MainActor
    func testPasswordManagerMigratesVerifiedLegacyShortPassword() {
        let service = "yy.NotebookTests.password.\(UUID().uuidString)"
        let manager = PasswordManager(keychainService: service)
        let password = "1234"
        let salt = "legacy-salt"
        let legacyHash = SHA256.hash(data: Data((password + salt).utf8))
            .map { String(format: "%02x", $0) }
            .joined()

        XCTAssertTrue(manager.importPasswordConfig(["hash": legacyHash, "salt": salt]))
        XCTAssertTrue(manager.verifyPassword(password), "旧版短密码应继续可用")

        let migratedHash = KeychainHelper.loadString(service: service, account: "app_password_hash")
        let migratedSalt = KeychainHelper.loadString(service: service, account: "app_password_salt")
        XCTAssertTrue(migratedHash?.hasPrefix("pbkdf2_sha256$") == true)
        XCTAssertNil(migratedSalt, "迁移成功后应删除旧版盐值")

        manager.forceClearPassword()
    }

    /// changePassword：旧密码验证 + 新密码设置
    @MainActor
    func testPasswordManagerChangePassword() {
        let manager = isolatedPasswordManager()
        let oldPassword = "old-pass-\(UUID().uuidString)"
        let newPassword = "new-pass-\(UUID().uuidString)"

        manager.forceClearPassword()
        XCTAssertTrue(manager.setPassword(oldPassword))

        // 错误旧密码应失败
        XCTAssertFalse(manager.changePassword(oldPassword: "wrong", newPassword: newPassword))

        // 正确旧密码应成功
        XCTAssertTrue(manager.changePassword(oldPassword: oldPassword, newPassword: newPassword))
        XCTAssertTrue(manager.verifyPassword(newPassword))
        XCTAssertFalse(manager.verifyPassword(oldPassword), "旧密码不应再有效")

        manager.forceClearPassword()
    }

    /// clearPassword 错误密码应失败
    @MainActor
    func testPasswordManagerClearPasswordWithWrongPasswordFails() {
        let manager = isolatedPasswordManager()
        let password = "test-pass-\(UUID().uuidString)"

        manager.forceClearPassword()
        XCTAssertTrue(manager.setPassword(password))

        XCTAssertFalse(manager.clearPassword(currentPassword: "wrong"), "错误密码清除应失败")
        XCTAssertTrue(manager.hasPassword, "清除失败后 hasPassword 仍应为 true")

        manager.forceClearPassword()
    }

    /// forceClearPassword 不需要验证
    @MainActor
    func testPasswordManagerForceClearPassword() {
        let manager = isolatedPasswordManager()
        XCTAssertTrue(manager.setPassword("temp-pass"))

        manager.forceClearPassword()
        XCTAssertFalse(manager.hasPassword, "forceClearPassword 后 hasPassword 应为 false")
    }

    /// verifyPassword 无密码时应返回 false
    @MainActor
    func testPasswordManagerVerifyWithNoPasswordReturnsFalse() {
        let manager = isolatedPasswordManager()
        manager.forceClearPassword()

        XCTAssertFalse(manager.verifyPassword("any-password"), "无密码时 verifyPassword 应返回 false")
    }

    /// PBKDF2 记录格式：验证生成的哈希字符串包含算法标识、迭代次数、盐、派生密钥四段
    @MainActor
    func testPasswordManagerPBKDF2RecordFormat() {
        let manager = isolatedPasswordManager()
        manager.forceClearPassword()
        XCTAssertTrue(manager.setPassword("format-test"))

        // 通过 verifyPassword 间接验证记录格式正确（内部解析 4 段）
        XCTAssertTrue(manager.verifyPassword("format-test"), "PBKDF2 记录应可被正确解析验证")

        manager.forceClearPassword()
    }

    /// 常量时间比较：相同长度不同内容应返回 false
    @MainActor
    func testPasswordManagerConstantTimeCompareDifferentValues() {
        // constantTimeCompare 是 private，通过 verifyPassword 间接测试
        let manager = isolatedPasswordManager()
        manager.forceClearPassword()
        XCTAssertTrue(manager.setPassword("abcdefgh"))

        // 长度相同但内容不同
        XCTAssertFalse(manager.verifyPassword("abcdefgi"), "仅末位不同的密码应被拒绝")
        XCTAssertFalse(manager.verifyPassword("abcdefghX"), "多一位的密码应被拒绝")

        manager.forceClearPassword()
    }

    @MainActor
    private func isolatedPasswordManager() -> PasswordManager {
        PasswordManager(keychainService: "yy.NotebookTests.password.\(UUID().uuidString)")
    }
}
