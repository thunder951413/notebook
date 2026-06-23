import Foundation
import AVFoundation
import Combine

@MainActor
class AudioRecorderManager: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published var isRecording = false
    @Published var recordedURL: URL?

    private var audioRecorder: AVAudioRecorder?

    func startRecording(noteID: UUID) async {
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else {
            DebugLog.attachment("麦克风权限被拒绝", level: .debug)
            return
        }

        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else { return }

        location.withSecurityScopedAccess(base) {
            do {
                try location.ensureDirectoryStructureExists()
                let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

                let fileURL = folder.appendingPathComponent(UUID().uuidString + ".m4a")

                let settings: [String: Any] = [
                    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                    AVSampleRateKey: 44100.0,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
                ]

                audioRecorder = try AVAudioRecorder(url: fileURL, settings: settings)
                audioRecorder?.delegate = self
                audioRecorder?.prepareToRecord()
                audioRecorder?.record()

                isRecording = true
                recordedURL = fileURL
            } catch {
                DebugLog.attachment("开始录音失败: \(error)", level: .warn)
            }
        }
    }

    func stopRecording() {
        audioRecorder?.stop()
        isRecording = false
    }
}
