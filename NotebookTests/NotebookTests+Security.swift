import XCTest
@testable import Notebook

extension NotebookTests {
    func testNotebookDefaultsUsesIsolatedSuiteDuringTests() {
        let key = "NotebookTests.defaults-isolation.\(UUID().uuidString)"
        NotebookDefaults.shared.set("isolated", forKey: key)
        defer { NotebookDefaults.shared.removeObject(forKey: key) }

        XCTAssertEqual(NotebookDefaults.shared.string(forKey: key), "isolated")
        XCTAssertNil(UserDefaults.standard.object(forKey: key))
    }

    func testAIConfigEncodingNeverExportsAPIKey() throws {
        let config = AIServiceConfig(
            name: "Private",
            baseURL: "https://example.com/v1",
            apiKey: "secret-that-must-not-be-exported",
            model: "test"
        )

        let data = try JSONEncoder().encode(config)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertFalse(json.contains("secret-that-must-not-be-exported"))
        XCTAssertFalse(json.contains("apiKey"))
    }

    func testAIConfigDecodesLegacyAPIKeyForSafeMigration() throws {
        let id = UUID()
        let json = """
        {
          "id": "\(id.uuidString)",
          "name": "Legacy",
          "baseURL": "https://example.com/v1",
          "apiKey": "legacy-secret",
          "model": "test",
          "temperature": 0.7,
          "maxTokens": 2000,
          "isDefault": false
        }
        """

        let config = try JSONDecoder().decode(AIServiceConfig.self, from: Data(json.utf8))
        XCTAssertEqual(config.apiKey, "legacy-secret")
    }

    func testAIKeychainRoundTrip() throws {
        let id = UUID()
        defer { try? AIConfigKeychainStore.delete(configID: id) }

        try AIConfigKeychainStore.save("key-value", configID: id)
        XCTAssertEqual(AIConfigKeychainStore.load(configID: id), "key-value")
        try AIConfigKeychainStore.delete(configID: id)
        XCTAssertNil(AIConfigKeychainStore.load(configID: id))
    }

    @MainActor
    func testAIEndpointRejectsInvalidAndRemoteHTTPURLs() throws {
        XCTAssertThrowsError(try AIService.endpointURL(baseURL: "not a url"))
        XCTAssertThrowsError(try AIService.endpointURL(baseURL: "http://example.com/v1"))
        XCTAssertEqual(
            try AIService.endpointURL(baseURL: "http://localhost:11434/v1/").absoluteString,
            "http://localhost:11434/v1/chat/completions"
        )
        XCTAssertEqual(
            try AIService.endpointURL(baseURL: "https://example.com/v1").absoluteString,
            "https://example.com/v1/chat/completions"
        )
    }

    @MainActor
    func testAIResponseDiagnosticContainsMetadataOnly() {
        let diagnostic = AIService.responseDiagnostic(statusCode: 401, dataCount: 123)
        XCTAssertEqual(diagnostic, "AI response: HTTP 401, bytes=123")
        XCTAssertFalse(diagnostic.contains("response body"))
        XCTAssertFalse(diagnostic.contains("secret"))
    }

    func testSSHHostKeyPolicyUsesTrustOnFirstUseAndKnownHosts() {
        XCTAssertTrue(SSHHostKeyPolicy.options.contains("StrictHostKeyChecking=accept-new"))
        XCTAssertTrue(SSHHostKeyPolicy.options.contains("HashKnownHosts=yes"))
        XCTAssertFalse(SSHHostKeyPolicy.options.contains("StrictHostKeyChecking=no"))
        XCTAssertFalse(SSHHostKeyPolicy.options.contains("UserKnownHostsFile=/dev/null"))
        XCTAssertFalse(SSHHostKeyPolicy.options.contains("GlobalKnownHostsFile=/dev/null"))
    }
}
