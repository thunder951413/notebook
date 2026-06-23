import Foundation

enum UUIDListCoding {
    static func decode(_ rawValue: String?) -> [UUID] {
        guard let rawValue else {
            return []
        }

        var seen = Set<UUID>()
        var values: [UUID] = []

        for component in rawValue.split(separator: ",") {
            let candidate = String(component).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let uuid = UUID(uuidString: candidate), !seen.contains(uuid) else {
                continue
            }
            seen.insert(uuid)
            values.append(uuid)
        }

        return values
    }

    static func encode(_ values: [UUID]) -> String {
        var seen = Set<UUID>()
        return values.compactMap { value in
            guard !seen.contains(value) else {
                return nil
            }
            seen.insert(value)
            return value.uuidString
        }.joined(separator: ",")
    }
}
