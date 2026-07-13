import AppKit
import CoreImage
import CryptoKit
import Foundation

/// Android Notebook 可扫描的同步配置。仅在用户主动显示二维码时临时创建，禁止持久化或记录。
struct MobileSyncConfigurationPayload: Codable, Equatable {
    let type: String
    let version: Int
    let host: String
    let port: Int
    let username: String
    let password: String
    let path: String
    let fingerprint: String?

    init(
        host: String,
        port: Int,
        username: String,
        password: String,
        path: String,
        fingerprint: String? = nil
    ) {
        self.type = "notebook-sync"
        self.version = 1
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.path = path
        self.fingerprint = fingerprint
    }
}

enum MobileSyncConfigurationEncoder {
    static func encode(
        config: SSHConfig,
        password: String,
        fingerprint: String? = nil
    ) throws -> Data {
        let payload = MobileSyncConfigurationPayload(
            host: config.host,
            port: config.port,
            username: config.username,
            password: password,
            path: config.repositoryPath,
            fingerprint: fingerprint?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(payload)
    }
}

enum MobileSyncQRCodeGenerator {
    static func image(fromUTF8JSON data: Data, size: CGFloat = 320) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("H", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }

        let integral = output.extent.integral
        let scale = max(1, floor(min(size / integral.width, size / integral.height)))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}

/// 只读取 OpenSSH 已信任的 known_hosts；不发起网络请求。
enum SSHKnownHostFingerprint {
    static func sha256(host: String, port: Int) -> String? {
        let knownHosts = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".ssh/known_hosts").path
        guard FileManager.default.isReadableFile(atPath: knownHosts) else { return nil }

        let query = port == 22 ? host : "[\(host)]:\(port)"
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh-keygen")
        process.arguments = ["-F", query, "-f", knownHosts]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            guard let text = String(data: data, encoding: .utf8) else { return nil }
            for line in text.split(whereSeparator: \.isNewline) where !line.hasPrefix("#") {
                let fields = line.split(whereSeparator: \.isWhitespace)
                guard fields.count >= 3, let key = Data(base64Encoded: String(fields[2])) else { continue }
                return "SHA256:\(Data(SHA256.hash(data: key)).base64EncodedString().replacingOccurrences(of: "=", with: ""))"
            }
        } catch {
            return nil
        }
        return nil
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
