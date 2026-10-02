import Foundation
import Security

enum KeychainStore {
    private static let service = "dev.localdev.localdev"
    private static let tunnelRuntimeKeyAccount = "openai-tunnel-runtime-key"
    private static let tunnelIdAccount = "openai-tunnel-id"
    private static let manualTunnelConnectionAccount = "openai-tunnel-connection-v1"

    static func loadManualTunnelConnection() throws -> StoredTunnelConnection? {
        guard let value = try load(account: manualTunnelConnectionAccount) else { return nil }
        return try JSONDecoder().decode(StoredTunnelConnection.self, from: Data(value.utf8))
    }

    static func saveManualTunnelConnection(_ connection: StoredTunnelConnection) throws {
        let data = try JSONEncoder().encode(connection)
        // Store the pair as one item so a failed save cannot mix two connections.
        try save(String(decoding: data, as: UTF8.self), account: manualTunnelConnectionAccount)
    }

    static func loadTunnelRuntimeKey() throws -> String? {
        try load(account: tunnelRuntimeKeyAccount)
    }

    static func saveTunnelRuntimeKey(_ value: String) throws {
        try save(value, account: tunnelRuntimeKeyAccount)
    }

    static func loadTunnelId() throws -> String? {
        try load(account: tunnelIdAccount)
    }

    static func saveTunnelId(_ value: String) throws {
        try save(value, account: tunnelIdAccount)
    }

    private static func load(account: String) throws -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError(status)
        }
        guard
            let data = item as? Data,
            let value = String(data: data, encoding: .utf8),
            !value.isEmpty
        else {
            return nil
        }
        return value
    }

    private static func save(_ value: String, account: String) throws {
        let data = Data(value.utf8)
        let lookup: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]

        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(
            lookup as CFDictionary,
            attributes as CFDictionary
        )

        if updateStatus == errSecItemNotFound {
            var add = lookup
            add[kSecValueData] = data
            add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError(addStatus)
            }
            return
        }

        guard updateStatus == errSecSuccess else {
            throw KeychainError(updateStatus)
        }
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus

    init(_ status: OSStatus) {
        self.status = status
    }

    var errorDescription: String? {
        if let message = SecCopyErrorMessageString(status, nil) as String? {
            return "Keychain error: \(message)"
        }
        return "Keychain error (\(status))"
    }
}
