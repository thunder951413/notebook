import Foundation

/// Cross-platform lease used by macOS and Android while publishing mutable
/// repository metadata. The directory name and timing values are part of the
/// remote synchronization contract and must stay aligned on both clients.
struct RemoteRepositoryWriteLock: Sendable, Equatable {
    static let directoryName = ".index-write.lock"
    static let ownerFileName = "owner"
    static let maximumAttempts = 30
    static let retryDelaySeconds = 1
    static let staleAfterSeconds = 1_800

    let path: String
    let ownerID: String

    var ownerPath: String { "\(path)/\(Self.ownerFileName)" }

    static func make(repositoryPath: String, ownerID: String = UUID().uuidString) -> Self {
        Self(
            path: "\(repositoryPath)/notes/\(directoryName)",
            ownerID: ownerID
        )
    }

    var acquireCommand: String {
        let lock = SSHRemotePath.shellQuoted(path)
        let ownerFile = SSHRemotePath.shellQuoted(ownerPath)
        let owner = SSHRemotePath.shellQuoted(ownerID)
        let quarantine = SSHRemotePath.shellQuoted("\(path).stale-\(ownerID)")
        let staleMinutes = max(1, Self.staleAfterSeconds / 60)

        return """
        i=0; while ! mkdir \(lock) 2>/dev/null; do i=$((i+1)); [ $i -ge \(Self.maximumAttempts) ] && exit 75; if find \(lock) -maxdepth 0 -mmin +\(staleMinutes) -print -quit 2>/dev/null | grep -q .; then if mv \(lock) \(quarantine) 2>/dev/null; then rm -f \(quarantine)/\(Self.ownerFileName); rmdir \(quarantine) 2>/dev/null || true; fi; fi; sleep \(Self.retryDelaySeconds); done; if ! printf '%s\\n' \(owner) > \(ownerFile); then rmdir \(lock) 2>/dev/null || true; exit 76; fi
        """
    }

    var refreshCommand: String {
        let lock = SSHRemotePath.shellQuoted(path)
        let ownerFile = SSHRemotePath.shellQuoted(ownerPath)
        let owner = SSHRemotePath.shellQuoted(ownerID)
        return "test \"$(cat \(ownerFile) 2>/dev/null)\" = \(owner) || exit 77; touch \(lock)"
    }

    var releaseCommand: String {
        let lock = SSHRemotePath.shellQuoted(path)
        let ownerFile = SSHRemotePath.shellQuoted(ownerPath)
        let owner = SSHRemotePath.shellQuoted(ownerID)
        return "if [ \"$(cat \(ownerFile) 2>/dev/null)\" = \(owner) ]; then rm -f \(ownerFile); rmdir \(lock); fi"
    }
}

enum RemoteNotePublicationGuard {
    enum Rejection: Equatable {
        case remoteVersionIsNewer(Int64)
        case sameVersionHasDifferentContent
        case remotelyDeleted(Date)
    }

    static func rejection(
        localEntry: RemoteNoteIndexEntry,
        remoteIndex: RemoteNoteIndex?
    ) -> Rejection? {
        guard let remoteIndex else { return nil }
        if let deletion = remoteIndex.deletedEntries.first(where: { $0.noteID == localEntry.noteID }) {
            return .remotelyDeleted(deletion.deletedAt)
        }
        guard let remoteEntry = remoteIndex.entries.first(where: { $0.noteID == localEntry.noteID }) else {
            return nil
        }
        if remoteEntry.version > localEntry.version {
            return .remoteVersionIsNewer(remoteEntry.version)
        }
        if remoteEntry.version == localEntry.version,
           remoteEntry.contentHash != localEntry.contentHash {
            return .sameVersionHasDifferentContent
        }
        return nil
    }
}
