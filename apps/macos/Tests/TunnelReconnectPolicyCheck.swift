import Foundation

@main
struct TunnelReconnectPolicyCheck {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_000)
        precondition(TunnelReconnectPolicy.shouldReconnect(enabled: true, state: "off", retryAt: nil, now: now))
        precondition(TunnelReconnectPolicy.shouldReconnect(enabled: true, state: "error", retryAt: now, now: now))
        precondition(!TunnelReconnectPolicy.shouldReconnect(enabled: false, state: "off", retryAt: nil, now: now))
        precondition(!TunnelReconnectPolicy.shouldReconnect(enabled: true, state: "connected", retryAt: nil, now: now))
        precondition(!TunnelReconnectPolicy.shouldReconnect(enabled: true, state: "starting", retryAt: nil, now: now))
        precondition(!TunnelReconnectPolicy.shouldReconnect(enabled: true, state: "off", retryAt: now.addingTimeInterval(1), now: now))
        precondition(TunnelReconnectPolicy.delay(afterFailure: 1) == 2)
        precondition(TunnelReconnectPolicy.delay(afterFailure: 2) == 4)
        precondition(TunnelReconnectPolicy.delay(afterFailure: 10) == 60)
        print("Tunnel reconnect policy checks passed")
    }
}
