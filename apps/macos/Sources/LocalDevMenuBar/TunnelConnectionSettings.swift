import Foundation

struct TunnelConnectionSettings: Sendable {
    let tunnelId: String
    let runtimeKey: String
    let clientPath: String?

    static func validate(tunnelId: String, runtimeKey: String, clientPath: String?) throws -> Self {
        let id = tunnelId.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = runtimeKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard id.range(of: #"^tunnel_[0-9a-f]{32}$"#, options: .regularExpression) != nil else {
            throw TunnelConnectionSettingsError.invalidTunnelID
        }
        guard !key.isEmpty else { throw TunnelConnectionSettingsError.missingRuntimeKey }
        if let path = clientPath {
            var isDirectory: ObjCBool = false
            guard path.hasPrefix("/"),
                  FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
                  !isDirectory.boolValue,
                  FileManager.default.isExecutableFile(atPath: path) else {
                throw TunnelConnectionSettingsError.invalidClientExecutable
            }
        }
        return Self(tunnelId: id, runtimeKey: key, clientPath: clientPath)
    }
}

struct StoredTunnelConnection: Codable, Sendable {
    let tunnelId: String
    let runtimeKey: String
}

enum TunnelConnectionSettingsError: LocalizedError, Equatable {
    case invalidTunnelID
    case missingRuntimeKey
    case invalidClientExecutable

    var errorDescription: String? {
        switch self {
        case .invalidTunnelID: "Enter a tunnel ID starting with tunnel_ followed by 32 lowercase letters a–f or digits."
        case .missingRuntimeKey: "Enter the runtime key for this connection."
        case .invalidClientExecutable: "Choose an executable tunnel-client file that exists on this Mac."
        }
    }
}
