import Foundation

enum TunnelReconnectPolicy {
    static func shouldReconnect(enabled: Bool, state: String, retryAt: Date?, now: Date) -> Bool {
        guard enabled, state != "connected", state != "starting" else { return false }
        return retryAt.map { $0 <= now } ?? true
    }

    static func delay(afterFailure: Int) -> TimeInterval {
        min(60, Double(1 << min(max(afterFailure, 1), 6)))
    }
}
