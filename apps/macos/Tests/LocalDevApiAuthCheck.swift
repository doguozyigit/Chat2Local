import Foundation

@main
struct LocalDevApiAuthCheck {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("local-dev-swift-api-auth-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let token = String(repeating: "a", count: 64)
        let tokenURL = directory.appendingPathComponent("api-token")
        try (token + "\n").write(to: tokenURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)

        var local = URLRequest(url: URL(string: "http://127.0.0.1:43127/v1/status")!)
        precondition(LocalDevApiAuth.authorize(&local, dataDirectory: directory))
        precondition(local.value(forHTTPHeaderField: "x-local-dev-token") == token)

        var remote = URLRequest(url: URL(string: "https://example.com/v1/status")!)
        precondition(!LocalDevApiAuth.authorize(&remote, dataDirectory: directory))
        precondition(remote.value(forHTTPHeaderField: "x-local-dev-token") == nil)

        var alternate = URLRequest(url: URL(string: "http://127.0.0.1:43128/v1/status")!)
        precondition(!LocalDevApiAuth.authorize(&alternate, dataDirectory: directory, expectedPort: 43127))
        precondition(alternate.value(forHTTPHeaderField: "x-local-dev-token") == nil)
        precondition(LocalDevApiAuth.authorize(&alternate, dataDirectory: directory, expectedPort: 43128))
        var wrongHost = URLRequest(url: URL(string: "http://localhost:43128/v1/status")!)
        precondition(!LocalDevApiAuth.authorize(&wrongHost, dataDirectory: directory, expectedPort: 43128))
        var invalidPort = URLRequest(url: URL(string: "http://127.0.0.1:43128/v1/status")!)
        precondition(!LocalDevApiAuth.authorize(&invalidPort, dataDirectory: directory, expectedPort: 0))

        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: tokenURL.path)
        var unsafe = URLRequest(url: URL(string: "http://127.0.0.1:43127/v1/status")!)
        precondition(!LocalDevApiAuth.authorize(&unsafe, dataDirectory: directory))
        precondition(unsafe.value(forHTTPHeaderField: "x-local-dev-token") == nil)
    }
}
