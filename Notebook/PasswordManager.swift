import Foundation
import Security
import CryptoKit
import Combine

/// 密码管理器 - 用于设置、修改和验证应用密码
class PasswordManager: ObservableObject {
    static let shared = PasswordManager()
    
    private let passwordKey = "app_password_hash"
    private let saltKey = "app_password_salt"
    
    @Published var hasPassword: Bool = false
    
    private init() {
        hasPassword = loadPasswordHash() != nil
    }
    
    /// 设置新密码
    /// - Parameter password: 要设置的密码
    /// - Returns: 是否成功设置
    @discardableResult
    func setPassword(_ password: String) -> Bool {
        guard !password.isEmpty else { return false }
        
        // 生成随机盐值
        let salt = generateSalt()
        
        // 使用盐值哈希密码
        let hash = hashPassword(password, salt: salt)
        
        // 保存到 Keychain
        if saveToKeychain(hash, key: passwordKey) && saveToKeychain(salt, key: saltKey) {
            DispatchQueue.main.async {
                self.hasPassword = true
            }
            return true
        }
        return false
    }
    
    /// 验证密码
    /// - Parameter password: 要验证的密码
    /// - Returns: 密码是否正确
    func verifyPassword(_ password: String) -> Bool {
        guard let storedHash = loadPasswordHash(),
              let salt = loadSalt() else {
            return false
        }
        
        let inputHash = hashPassword(password, salt: salt)
        return inputHash == storedHash
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
            DispatchQueue.main.async {
                self.hasPassword = false
            }
        }
        return success
    }
    
    /// 强制清除密码（不需要验证，用于重置）
    func forceClearPassword() {
        _ = deleteFromKeychain(key: passwordKey)
        _ = deleteFromKeychain(key: saltKey)
        DispatchQueue.main.async {
            self.hasPassword = false
        }
    }
    
    // MARK: - Private Methods
    
    /// 生成随机盐值
    private func generateSalt() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
    }
    
    /// 使用 SHA-256 和盐值哈希密码
    private func hashPassword(_ password: String, salt: String) -> String {
        let saltedPassword = password + salt
        let data = Data(saltedPassword.utf8)
        let hash = SHA256.hash(data: data)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
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
        
        // 先删除已存在的
        _ = deleteFromKeychain(key: key)
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrService as String: "com.notebook.app",
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        
        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }
    
    private func loadFromKeychain(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.notebook.app",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        
        return value
    }
    
    private func deleteFromKeychain(key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.notebook.app"
        ]
        
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
    
    // MARK: - Export/Import
    
    /// 导出密码配置（哈希和盐值）
    /// - Returns: 包含密码哈希和盐值的字典，如果没有设置密码则返回 nil
    func exportPasswordConfig() -> [String: String]? {
        guard let hash = loadPasswordHash(),
              let salt = loadSalt() else {
            return nil
        }
        return [
            "hash": hash,
            "salt": salt
        ]
    }
    
    /// 导入密码配置
    /// - Parameter config: 包含密码哈希和盐值的字典
    /// - Returns: 是否成功导入
    @discardableResult
    func importPasswordConfig(_ config: [String: String]) -> Bool {
        guard let hash = config["hash"],
              let salt = config["salt"] else {
            return false
        }
        
        // 保存到 Keychain
        if saveToKeychain(hash, key: passwordKey) && saveToKeychain(salt, key: saltKey) {
            DispatchQueue.main.async {
                self.hasPassword = true
            }
            return true
        }
        return false
    }
}
