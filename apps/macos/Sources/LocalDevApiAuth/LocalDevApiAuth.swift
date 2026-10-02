import Darwin
import Foundation

public enum LocalDevApiAuth {
    /// Adds the private local API token only to the bundled loopback daemon.
    @discardableResult
    public static func authorize(
        _ request: inout URLRequest,
        dataDirectory: URL? = nil,
        expectedPort: Int = configuredPort
    ) -> Bool {
        guard
            let url = request.url,
            url.scheme == "http",
            url.host == "127.0.0.1",
            (1...65535).contains(expectedPort),
            url.port == expectedPort,
            url.path == "/mcp" || url.path.hasPrefix("/v1/")
        else {
            return false
        }

        let directory = dataDirectory ?? defaultDataDirectory()
        let tokenURL = directory.appendingPathComponent("api-token")
        guard
            let attributes = try? FileManager.default.attributesOfItem(
                atPath: tokenURL.path
            ),
            attributes[.type] as? FileAttributeType == .typeRegular,
            let permissions = attributes[.posixPermissions] as? NSNumber,
            permissions.intValue & 0o077 == 0,
            let owner = attributes[.ownerAccountID] as? NSNumber,
            owner.uint32Value == getuid(),
            let rawToken = try? String(contentsOf: tokenURL, encoding: .utf8)
        else {
            return false
        }

        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.utf8.count == 64,
            token.utf8.allSatisfy({
                (48...57).contains($0) || (97...102).contains($0)
            })
        else {
            return false
        }

        request.setValue(token, forHTTPHeaderField: "x-local-dev-token")
        return true
    }

    public static var configuredPort: Int {
        let requested = ProcessInfo.processInfo.environment["LOCAL_DEV_PORT"].flatMap(Int.init)
        return requested.flatMap { (1...65535).contains($0) ? $0 : nil } ?? 43127
    }

    private static func defaultDataDirectory() -> URL {
        if
            let path = ProcessInfo.processInfo.environment["LOCAL_DEV_DATA_DIR"],
            path.hasPrefix("/")
        {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local-dev", isDirectory: true)
    }
}
