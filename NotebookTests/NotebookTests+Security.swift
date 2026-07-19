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

    func testSSHRemotePathPreservesTildeExpansionAndQuotesMetacharacters() {
        XCTAssertEqual(SSHRemotePath.shellQuoted("~"), "~")
        XCTAssertEqual(SSHRemotePath.shellQuoted("~/notebook backup"), "~/'notebook backup'")
        XCTAssertEqual(
            SSHRemotePath.shellQuoted("~/owner's notebook;$HOME"),
            "~/'owner'\"'\"'s notebook;$HOME'"
        )
        XCTAssertEqual(SSHRemotePath.shellQuoted("/srv/notebook backup"), "'/srv/notebook backup'")
    }

    func testSSHRemotePathNormalizesAndCreatesSiblingRebuildPath() throws {
        XCTAssertEqual(try SSHRemotePath.normalizedRepositoryPath("  ~/notebook_backup///  "), "~/notebook_backup")
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(
            try SSHRemotePath.timestampedRebuildPath(from: "~/notebook_backup/", date: date),
            "~/notebook_backup.rebuild-20231114-221320"
        )
        XCTAssertThrowsError(try SSHRemotePath.normalizedRepositoryPath("\n"))
        XCTAssertThrowsError(try SSHRemotePath.normalizedRepositoryPath("~/bad\npath"))
    }

    func testRemoteRepositoryWriteLockUsesOwnedCrossPlatformLease() {
        let lock = RemoteRepositoryWriteLock.make(
            repositoryPath: "~/owner's notebook;$HOME",
            ownerID: "device-token"
        )

        XCTAssertEqual(lock.path, "~/owner's notebook;$HOME/notes/.index-write.lock")
        XCTAssertEqual(RemoteRepositoryWriteLock.maximumAttempts, 30)
        XCTAssertEqual(RemoteRepositoryWriteLock.staleAfterSeconds, 1_800)
        XCTAssertTrue(lock.acquireCommand.contains(".stale-device-token"))
        XCTAssertTrue(lock.acquireCommand.contains("mmin +30"))
        XCTAssertTrue(lock.acquireCommand.contains("printf '%s\\n' 'device-token'"))
        XCTAssertTrue(lock.refreshCommand.contains("touch"))
        XCTAssertTrue(lock.releaseCommand.contains("cat"))
        XCTAssertTrue(lock.releaseCommand.contains("device-token"))
        XCTAssertFalse(lock.releaseCommand.contains("rm -rf"))
    }

    func testRemoteRepositoryWriteLockStaleTakeoverPreservesNewOwner() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("remote-lock-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("notes", isDirectory: true),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }

        let first = RemoteRepositoryWriteLock.make(repositoryPath: root.path, ownerID: "first-owner")
        let second = RemoteRepositoryWriteLock.make(repositoryPath: root.path, ownerID: "second-owner")
        try runShell(first.acquireCommand)
        XCTAssertEqual(try String(contentsOfFile: first.ownerPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), "first-owner")

        try runShell("touch -t 202001010000 \(SSHRemotePath.shellQuoted(first.path))")
        try runShell(second.acquireCommand)
        XCTAssertEqual(try String(contentsOfFile: second.ownerPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), "second-owner")

        // The old owner must not remove a lock that has already been replaced.
        try runShell(first.releaseCommand)
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path))
        try runShell(second.releaseCommand)
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
    }

    func testRemoteNotePublicationGuardRejectsOverwriteRisk() {
        let noteID = UUID()
        let local = RemoteNoteIndexEntry(
            noteID: noteID,
            version: 4,
            contentHash: "local",
            historyCount: 1
        )
        let newer = RemoteNoteIndexEntry(
            noteID: noteID,
            version: 5,
            contentHash: "remote",
            historyCount: 1
        )
        let divergent = RemoteNoteIndexEntry(
            noteID: noteID,
            version: 4,
            contentHash: "remote",
            historyCount: 1
        )
        let matching = RemoteNoteIndexEntry(
            noteID: noteID,
            version: 4,
            contentHash: "local",
            historyCount: 2
        )

        XCTAssertEqual(
            RemoteNotePublicationGuard.rejection(
                localEntry: local,
                remoteIndex: RemoteNoteIndex(generatedAt: .now, deviceID: "remote", entries: [newer])
            ),
            .remoteVersionIsNewer(5)
        )
        XCTAssertEqual(
            RemoteNotePublicationGuard.rejection(
                localEntry: local,
                remoteIndex: RemoteNoteIndex(generatedAt: .now, deviceID: "remote", entries: [divergent])
            ),
            .sameVersionHasDifferentContent
        )
        XCTAssertNil(RemoteNotePublicationGuard.rejection(
            localEntry: local,
            remoteIndex: RemoteNoteIndex(generatedAt: .now, deviceID: "remote", entries: [matching])
        ))

        let deletedAt = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(
            RemoteNotePublicationGuard.rejection(
                localEntry: local,
                remoteIndex: RemoteNoteIndex(
                    generatedAt: .now,
                    deviceID: "remote",
                    entries: [],
                    deletedEntries: [RemoteDeletedEntry(
                        noteID: noteID,
                        deletedAt: deletedAt,
                        deletedByDeviceID: "remote"
                    )]
                )
            ),
            .remotelyDeleted(deletedAt)
        )
    }

    private func runShell(_ command: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        let standardError = Pipe()
        process.standardError = standardError
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let message = String(
                data: standardError.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? "shell command failed"
            throw NSError(domain: "RemoteLockTest", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    func testSynchronizedAttachmentPathCannotEscapeManagedRoot() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("sync-path-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertEqual(
            try SyncRelativePath.resolvedURL("note-id/image.png", under: root).path,
            root.appendingPathComponent("note-id/image.png").path
        )
        XCTAssertThrowsError(try SyncRelativePath.resolvedURL("../outside", under: root))
        XCTAssertThrowsError(try SyncRelativePath.resolvedURL("/tmp/outside", under: root))
        XCTAssertThrowsError(try SyncRelativePath.resolvedURL("note-id//image.png", under: root))
    }

    func testUnchangedCachedRemoteIndexStillRepairsLocallyMissingNote() {
        XCTAssertTrue(RemoteNoteFetchPolicy.shouldFetch(
            isLocallyPresent: false,
            didRemoteIndexChange: false,
            remoteVersion: 4,
            lastRemoteVersion: 4,
            remoteContentHash: "same",
            lastRemoteFingerprint: "same"
        ))
        XCTAssertFalse(RemoteNoteFetchPolicy.shouldFetch(
            isLocallyPresent: true,
            didRemoteIndexChange: false,
            remoteVersion: 4,
            lastRemoteVersion: 4,
            remoteContentHash: "same",
            lastRemoteFingerprint: "same"
        ))
        XCTAssertTrue(RemoteNoteFetchPolicy.shouldFetch(
            isLocallyPresent: true,
            didRemoteIndexChange: true,
            remoteVersion: 5,
            lastRemoteVersion: 4,
            remoteContentHash: "new",
            lastRemoteFingerprint: "old"
        ))
    }

    @MainActor
    func testSSHTransportKeepsPasswordOutOfProcessArguments() {
        var config = SSHConfig.default
        config.host = "example.com"
        config.username = "user"
        config.password = "very-secret-password"

        let sshArguments = SSHProcessTransport.sshArguments(config: config, command: "true")
        let uploadArguments = SSHProcessTransport.scpUploadArguments(
            config: config,
            localPath: "/tmp/local",
            remotePath: "/tmp/remote"
        )
        let environment = SSHProcessTransport.environment(password: config.password)

        XCTAssertEqual(Array(sshArguments.prefix(2)), ["-e", "ssh"])
        XCTAssertEqual(Array(uploadArguments.prefix(2)), ["-e", "scp"])
        XCTAssertFalse(sshArguments.contains(config.password))
        XCTAssertFalse(uploadArguments.contains(config.password))
        XCTAssertEqual(environment["SSHPASS"], config.password)
    }

    func testCancellableProcessRunnerTerminatesChildProcess() async throws {
        let startedAt = Date()
        let processTask = Task {
            try await CancellableProcessRunner.run(
                executablePath: "/bin/sleep",
                arguments: ["10"],
                environment: ProcessInfo.processInfo.environment,
                timeout: 20,
                timeoutError: NSError(domain: "test", code: -1)
            )
        }

        try await Task.sleep(nanoseconds: 100_000_000)
        processTask.cancel()

        do {
            _ = try await processTask.value
            XCTFail("取消后不应返回成功结果")
        } catch is CancellationError {
            XCTAssertLessThan(Date().timeIntervalSince(startedAt), 2)
        }
    }

    func testCancellableProcessRunnerTimesOutAndTerminatesChildProcess() async throws {
        let startedAt = Date()
        let timeoutError = NSError(domain: "ProcessRunnerTimeoutTest", code: -1001)

        do {
            _ = try await CancellableProcessRunner.run(
                executablePath: "/bin/sleep",
                arguments: ["10"],
                environment: ProcessInfo.processInfo.environment,
                timeout: 0.05,
                timeoutError: timeoutError
            )
            XCTFail("超时后不应返回成功结果")
        } catch let error as NSError {
            XCTAssertEqual(error.domain, timeoutError.domain)
            XCTAssertEqual(error.code, timeoutError.code)
            XCTAssertLessThan(Date().timeIntervalSince(startedAt), 2)
        }
    }
}
