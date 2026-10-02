import CryptoKit
import Darwin
import Foundation

struct LegacyTunnelCredentials: Sendable {
    let tunnelId: String
    let runtimeApiKey: String
    let clientPath: String?
    let legacyTunnelRunning: Bool
}

enum LegacyTunnelMigration {
    private static let runtimeSecretName = "OPENAI_TUNNEL_RUNTIME_KEY"

    static func loadExistingCredentials() throws -> LegacyTunnelCredentials? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let root = home.appendingPathComponent(".localant", isDirectory: true)
        let configURL = root.appendingPathComponent("config.json")
        let secretsURL = root.appendingPathComponent("secrets.json")
        let vaultKeyURL = root.appendingPathComponent("vault.key")

        guard
            FileManager.default.fileExists(atPath: configURL.path),
            FileManager.default.fileExists(atPath: secretsURL.path),
            FileManager.default.fileExists(atPath: vaultKeyURL.path)
        else {
            return nil
        }

        let configData = try Data(contentsOf: configURL)
        guard
            let config = try JSONSerialization.jsonObject(with: configData) as? [String: Any],
            let tunnelConfig = config["openaiTunnel"] as? [String: Any],
            let rawTunnelId = tunnelConfig["tunnelId"] as? String
        else {
            return nil
        }

        let tunnelId = rawTunnelId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard tunnelId.range(
            of: #"^tunnel_[0-9a-f]{32}$"#,
            options: .regularExpression
        ) != nil else {
            return nil
        }

        let secretsData = try Data(contentsOf: secretsURL)
        guard
            let secrets = try JSONSerialization.jsonObject(with: secretsData) as? [String: String],
            let encryptedRuntimeKey = secrets[runtimeSecretName]
        else {
            return nil
        }

        let vaultKeyBase64 = try String(contentsOf: vaultKeyURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let vaultKeyData = Data(base64Encoded: vaultKeyBase64) else {
            throw LegacyTunnelMigrationError.invalidVaultKey
        }

        let runtimeApiKey = try decrypt(
            encryptedRuntimeKey,
            keyData: vaultKeyData
        )
        guard !runtimeApiKey.isEmpty else {
            throw LegacyTunnelMigrationError.emptyRuntimeKey
        }

        let configuredPath = (tunnelConfig["clientPath"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceClientPath = resolveTunnelClient(configuredPath: configuredPath)
        let clientPath = try sourceClientPath.map(installTunnelClientForLocalDev)

        let pidURL = root.appendingPathComponent("openai-tunnel.pid")
        let legacyTunnelRunning = readPid(pidURL).map(processRunning) ?? false

        return LegacyTunnelCredentials(
            tunnelId: tunnelId,
            runtimeApiKey: runtimeApiKey,
            clientPath: clientPath,
            legacyTunnelRunning: legacyTunnelRunning
        )
    }

    private static func decrypt(
        _ blob: String,
        keyData: Data
    ) throws -> String {
        let parts = blob.split(separator: ".", omittingEmptySubsequences: false)
        guard
            parts.count == 3,
            let nonceData = Data(base64Encoded: String(parts[0])),
            let tagData = Data(base64Encoded: String(parts[1])),
            let ciphertext = Data(base64Encoded: String(parts[2]))
        else {
            throw LegacyTunnelMigrationError.invalidEncryptedSecret
        }

        let nonce = try AES.GCM.Nonce(data: nonceData)
        let sealedBox = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: ciphertext,
            tag: tagData
        )
        let plaintext = try AES.GCM.open(
            sealedBox,
            using: SymmetricKey(data: keyData)
        )

        guard let value = String(data: plaintext, encoding: .utf8) else {
            throw LegacyTunnelMigrationError.invalidSecretEncoding
        }
        return value
    }

    private static func resolveTunnelClient(configuredPath: String?) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            configuredPath,
            "/opt/homebrew/bin/tunnel-client",
            "/usr/local/bin/tunnel-client",
            "/Applications/Chat On Steroids.app/Contents/Resources/tunnel/tunnel-client",
            "\(home)/Applications/Chat On Steroids.app/Contents/Resources/tunnel/tunnel-client",
        ].compactMap { $0 }

        return candidates.first {
            FileManager.default.isExecutableFile(atPath: $0)
        }
    }

    private static func installTunnelClientForLocalDev(
        sourcePath: String
    ) throws -> String {
        let fileManager = FileManager.default
        let home = fileManager.homeDirectoryForCurrentUser
        let destinationDirectory = home
            .appendingPathComponent(".local-dev", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
        let destination = destinationDirectory
            .appendingPathComponent("tunnel-client")

        if sourcePath == destination.path {
            return destination.path
        }

        try fileManager.createDirectory(
            at: destinationDirectory,
            withIntermediateDirectories: true
        )

        if fileManager.fileExists(atPath: destination.path) {
            if fileManager.isExecutableFile(atPath: destination.path) {
                return destination.path
            }
            try fileManager.removeItem(at: destination)
        }

        try fileManager.copyItem(
            at: URL(fileURLWithPath: sourcePath),
            to: destination
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: destination.path
        )

        guard fileManager.isExecutableFile(atPath: destination.path) else {
            throw LegacyTunnelMigrationError.tunnelClientCopyFailed
        }
        return destination.path
    }

    private static func readPid(_ url: URL) -> pid_t? {
        guard
            let raw = try? String(contentsOf: url, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
            let value = Int32(raw),
            value > 1
        else {
            return nil
        }
        return value
    }

    private static func processRunning(_ pid: pid_t) -> Bool {
        Darwin.kill(pid, 0) == 0
    }
}

enum LegacyTunnelMigrationError: LocalizedError {
    case invalidVaultKey
    case invalidEncryptedSecret
    case emptyRuntimeKey
    case invalidSecretEncoding
    case tunnelClientCopyFailed

    var errorDescription: String? {
        switch self {
        case .invalidVaultKey:
            return "The existing Chat2Local tunnel vault key could not be read."
        case .invalidEncryptedSecret:
            return "The existing Chat2Local tunnel credential is malformed."
        case .emptyRuntimeKey:
            return "The existing Chat2Local tunnel runtime key is empty."
        case .invalidSecretEncoding:
            return "The existing Chat2Local tunnel runtime key could not be decoded."
        case .tunnelClientCopyFailed:
            return "The existing OpenAI tunnel client could not be copied into Chat2Local."
        }
    }
}
