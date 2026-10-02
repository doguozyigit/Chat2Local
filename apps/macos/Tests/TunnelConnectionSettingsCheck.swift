import Foundation

@main
struct TunnelConnectionSettingsCheck {
    static func main() throws {
        let tunnelID = "tunnel_" + String(repeating: "a", count: 32)
        let valid = try TunnelConnectionSettings.validate(tunnelId: " \(tunnelID)\n", runtimeKey: " example-key ", clientPath: nil)
        precondition(valid.tunnelId == tunnelID)
        precondition(valid.runtimeKey == "example-key")
        precondition(valid.clientPath == nil)

        for invalidID in ["", "tunnel_abc", "tunnel_" + String(repeating: "A", count: 32), "other_" + String(repeating: "a", count: 32)] {
            expectError(.invalidTunnelID) {
                _ = try TunnelConnectionSettings.validate(tunnelId: invalidID, runtimeKey: "example-key", clientPath: nil)
            }
        }
        expectError(.missingRuntimeKey) {
            _ = try TunnelConnectionSettings.validate(tunnelId: tunnelID, runtimeKey: " \n", clientPath: nil)
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("local-dev-tunnel-settings-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let executable = directory.appendingPathComponent("tunnel-client")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let withClient = try TunnelConnectionSettings.validate(tunnelId: tunnelID, runtimeKey: "example-key", clientPath: executable.path)
        precondition(withClient.clientPath == executable.path)
        expectError(.invalidClientExecutable) {
            _ = try TunnelConnectionSettings.validate(tunnelId: tunnelID, runtimeKey: "example-key", clientPath: directory.appendingPathComponent("missing").path)
        }
        expectError(.invalidClientExecutable) {
            _ = try TunnelConnectionSettings.validate(tunnelId: tunnelID, runtimeKey: "example-key", clientPath: directory.path)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: executable.path)
        expectError(.invalidClientExecutable) {
            _ = try TunnelConnectionSettings.validate(tunnelId: tunnelID, runtimeKey: "example-key", clientPath: executable.path)
        }
        print("Tunnel connection settings checks passed")
    }

    static func expectError(_ expected: TunnelConnectionSettingsError, action: () throws -> Void) {
        do {
            try action()
            preconditionFailure("Expected settings validation to reject invalid input")
        } catch let error as TunnelConnectionSettingsError {
            precondition(error == expected)
            precondition(!(error.errorDescription ?? "").contains("example-key"))
        } catch {
            preconditionFailure("Unexpected settings validation error")
        }
    }
}
