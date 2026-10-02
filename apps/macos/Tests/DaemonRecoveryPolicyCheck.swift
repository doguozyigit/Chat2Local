import Foundation

@main
struct DaemonRecoveryPolicyCheck {
    static func main() {
        precondition(DaemonRecoveryPolicy.shouldLaunch(serviceHealthy: false, ownedProcessRunning: false, launchInFlight: false))
        precondition(!DaemonRecoveryPolicy.shouldLaunch(serviceHealthy: true, ownedProcessRunning: false, launchInFlight: false), "A healthy external service must be preserved")
        precondition(!DaemonRecoveryPolicy.shouldLaunch(serviceHealthy: false, ownedProcessRunning: true, launchInFlight: false), "An owned running service must not be duplicated")
        precondition(!DaemonRecoveryPolicy.shouldLaunch(serviceHealthy: false, ownedProcessRunning: false, launchInFlight: true), "Repeated restart clicks must not race")
        precondition(!DaemonRecoveryPolicy.shouldReportTermination(isCurrentProcess: false, stopping: false))
        precondition(!DaemonRecoveryPolicy.shouldReportTermination(isCurrentProcess: true, stopping: true))
        precondition(DaemonRecoveryPolicy.shouldReportTermination(isCurrentProcess: true, stopping: false))
        print("Daemon recovery policy checks passed")
    }
}
