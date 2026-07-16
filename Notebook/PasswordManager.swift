import Foundation
import CryptoKit
import Combine
import CommonCrypto

/// 密码管理器 - 用于设置、修改和验证应用密码
@MainActor
final class PasswordManager: ObservableObject {
    static let shared = PasswordManager()
    
    private let passwordKey = "app_password_hash"
    private let saltKey = "app_password_salt"
    private let keychainService: String
    private let pbkdf2Algorithm = "pbkdf2_sha256"
    private let pbkdf2Iterations = 120_000
    private let saltByteCount = 32
    private let derivedKeyByteCount = 32
    
    @Published var hasPassword: Bool = false
    
    init(keychainService: String = "com.notebook.app") {
        self.keychainService = keychainService
        hasPassword = loadPasswordHash() != nil
    }
    
    /// 设置新密码
    /// - Parameter password: 要设置的密码
    /// - Returns: 是否成功设置
    @discardableResult
    func setPassword(_ password: String) -> Bool {
        guard !password.isEmpty else { return false }
        
        guard let hash = makePBKDF2PasswordRecord(password) else {
            return false
        }
        
        // 保存到 Keychain
        if saveToKeychain(hash, key: passwordKey) {
            _ = deleteFromKeychain(key: saltKey)
            hasPassword = true
            return true
        }
        return false
    }
    
    /// 验证密码
    /// - Parameter password: 要验证的密码
    /// - Returns: 密码是否正确
    func verifyPassword(_ password: String) -> Bool {
        guard let storedHash = loadPasswordHash() else {
            return false
        }

        if verifyPBKDF2Password(password, record: storedHash) {
            return true
        }

        guard let salt = loadSalt() else {
            return false
        }

        let legacyHash = hashLegacyPassword(password, salt: salt)
        let matchesLegacyHash = constantTimeCompare(legacyHash, storedHash)
        if matchesLegacyHash {
            _ = setPassword(password)
        }
        return matchesLegacyHash
    }
    
    /// 修改密码
    /// - Parameters:
    ///   - oldPassword: 旧密码
    ///   - newPassword: 新密码
    /// - Returns: 是否成功修改
    @discardableResult
    func changePassword(oldPassword: String, newPassword: String) -> Bool {
        // 先验证旧密码
        guard verifyPassword(oldPassword) else { return false }
        
        // 设置新密码
        return setPassword(newPassword)
    }
    
    /// 清除密码
    /// - Parameter currentPassword: 当前密码（用于验证）
    /// - Returns: 是否成功清除
    @discardableResult
    func clearPassword(currentPassword: String) -> Bool {
        guard verifyPassword(currentPassword) else { return false }
        
        // 从 Keychain 删除
        let success = deleteFromKeychain(key: passwordKey) && deleteFromKeychain(key: saltKey)
        if success {
            hasPassword = false
        }
        return success
    }
    
    /// 强制清除密码（不需要验证，用于重置）
    func forceClearPassword() {
        _ = deleteFromKeychain(key: passwordKey)
        _ = deleteFromKeychain(key: saltKey)
        hasPassword = false
    }
    
    // MARK: - Private Methods
    
    /// 生成随机盐值
    private func generateSalt() -> Data? {
        var bytes = [UInt8](repeating: 0, count: saltByteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            Logger.shared.log(.encryption, .error, "生成密码盐值失败: \(status)")
            return nil
        }
        return Data(bytes)
    }
    
    /// 使用 PBKDF2-HMAC-SHA256 哈希密码
    private func makePBKDF2PasswordRecord(_ password: String) -> String? {
        guard let salt = generateSalt(),
              let derivedKey = derivePBKDF2Key(password: password, salt: salt, iterations: pbkdf2Iterations) else {
            return nil
        }
        return [
            pbkdf2Algorithm,
            String(pbkdf2Iterations),
            salt.base64EncodedString(),
            derivedKey.base64EncodedString()
        ].joined(separator: "$")
    }

    private func verifyPBKDF2Password(_ password: String, record: String) -> Bool {
        let components = record.split(separator: "$", omittingEmptySubsequences: false).map(String.init)
        guard components.count == 4,
              components[0] == pbkdf2Algorithm,
              let iterations = Int(components[1]),
              let salt = Data(base64Encoded: components[2]),
              let expectedKey = Data(base64Encoded: components[3]),
              let derivedKey = derivePBKDF2Key(password: password, salt: salt, iterations: iterations) else {
            return false
        }

        return constantTimeCompare(derivedKey, expectedKey)
    }

    private func derivePBKDF2Key(password: String, salt: Data, iterations: Int) -> Data? {
        guard iterations > 0 else { return nil }

        var derivedKey = [UInt8](repeating: 0, count: derivedKeyByteCount)
        let status = password.withCString { passwordPointer in
            salt.withUnsafeBytes { saltBuffer in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    passwordPointer,
                    strlen(passwordPointer),
                    saltBuffer.bindMemory(to: UInt8.self).baseAddress,
                    salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    UInt32(iterations),
                    &derivedKey,
                    derivedKey.count
                )
            }
        }

        guard status == kCCSuccess else {
            Logger.shared.log(.encryption, .error, "PBKDF2 派生失败: \(status)")
            return nil
        }

        return Data(derivedKey)
    }

    /// 旧版 SHA-256 + 盐值哈希，仅用于验证后迁移
    private func hashLegacyPassword(_ password: String, salt: String) -> String {
        let saltedPassword = password + salt
        let data = Data(saltedPassword.utf8)
        let hash = SHA256.hash(data: data)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    private func constantTimeCompare(_ lhs: String, _ rhs: String) -> Bool {
        constantTimeCompare(Data(lhs.utf8), Data(rhs.utf8))
    }

    private func constantTimeCompare(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }

        var difference: UInt8 = 0
        for (left, right) in zip(lhs, rhs) {
            difference |= left ^ right
        }
        return difference == 0
    }
    
    /// 从 Keychain 加载密码哈希
    private func loadPasswordHash() -> String? {
        return loadFromKeychain(key: passwordKey)
    }
    
    /// 从 Keychain 加载盐值
    private func loadSalt() -> String? {
        return loadFromKeychain(key: saltKey)
    }
    
    // MARK: - Keychain Operations
    
    private func saveToKeychain(_ value: String, key: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }

        do {
            try KeychainHelper.save(data, service: keychainService, account: key)
            return true
        } catch {
            Logger.shared.log(.encryption, .error, "保存密码配置到 Keychain 失败: \(error.localizedDescription)")
            return false
        }
    }
    
    private func loadFromKeychain(key: String) -> String? {
        KeychainHelper.loadString(service: keychainService, account: key)
    }
    
    private func deleteFromKeychain(key: String) -> Bool {
        do {
            try KeychainHelper.delete(service: keychainService, account: key)
            return true
        } catch {
            Logger.shared.log(.encryption, .error, "删除 Keychain 密码配置失败: \(error.localizedDescription)")
            return false
        }
    }
    
    // MARK: - Legacy Import

    /// 导入密码配置
    /// - Parameter config: 包含密码哈希和盐值的字典
    /// - Returns: 是否成功导入
    @discardableResult
    func importPasswordConfig(_ config: [String: String]) -> Bool {
        guard let hash = config["hash"] else {
            return false
        }
        
        // 保存到 Keychain
        let savedHash = saveToKeychain(hash, key: passwordKey)
        let savedSalt: Bool
        if let salt = config["salt"], !hash.hasPrefix("\(pbkdf2Algorithm)$") {
            savedSalt = saveToKeychain(salt, key: saltKey)
        } else {
            savedSalt = deleteFromKeychain(key: saltKey)
        }

        if savedHash && savedSalt {
            hasPassword = true
            return true
        }
        return false
    }
}
