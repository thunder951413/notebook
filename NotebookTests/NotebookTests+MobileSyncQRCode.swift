import Foundation
import XCTest
@testable import Notebook

extension NotebookTests {
    func testMobileSyncConfigurationJSONUsesRequiredFieldNamesAndVersion() throws {
        let config = SSHConfig(
            host: "192.168.1.8",
            port: 22,
            username: "用户名",
            password: "unused",
            repositoryPath: "~/NotebookSync"
        )
        let data = try MobileSyncConfigurationEncoder.encode(
            config: config,
            password: "密码",
            fingerprint: "SHA256:abc"
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(Set(json.keys), ["type", "version", "host", "port", "username", "password", "path", "fingerprint"])
        XCTAssertEqual(json["type"] as? String, "notebook-sync")
        XCTAssertEqual(json["version"] as? Int, 1)
        XCTAssertEqual(json["host"] as? String, "192.168.1.8")
        XCTAssertEqual(json["port"] as? Int, 22)
        XCTAssertEqual(json["username"] as? String, "用户名")
        XCTAssertEqual(json["password"] as? String, "密码")
        XCTAssertEqual(json["path"] as? String, "~/NotebookSync")
        XCTAssertEqual(json["fingerprint"] as? String, "SHA256:abc")
    }

    func testMobileSyncConfigurationJSONOmitsUnavailableFingerprint() throws {
        let config = SSHConfig(host: "nas.local", port: 2222, username: "user", repositoryPath: "/sync")
        let data = try MobileSyncConfigurationEncoder.encode(config: config, password: "secret")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertNil(json["fingerprint"])
        XCTAssertEqual(Set(json.keys), ["type", "version", "host", "port", "username", "password", "path"])
    }

    func testMobileSyncConfigurationJSONPreservesUTF8AndSpecialCharacters() throws {
        let config = SSHConfig(
            host: "服务器.local",
            port: 2200,
            username: "用\"户\\名",
            repositoryPath: "~/同步/含 空格/\n目录"
        )
        let password = "密\"码\\第一行\n第二行🔐"
        let data = try MobileSyncConfigurationEncoder.encode(config: config, password: password)
        let decoded = try JSONDecoder().decode(MobileSyncConfigurationPayload.self, from: data)

        XCTAssertNotNil(String(data: data, encoding: .utf8))
        XCTAssertEqual(decoded.host, config.host)
        XCTAssertEqual(decoded.username, config.username)
        XCTAssertEqual(decoded.password, password)
        XCTAssertEqual(decoded.path, config.repositoryPath)
    }
}
