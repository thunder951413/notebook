import Foundation
import AVFoundation
import ScreenCaptureKit
import Combine

/// 系统音频录制器 - 使用 ScreenCaptureKit 录制电脑音频输出
@available(macOS 12.3, *)
class SystemAudioRecorder: NSObject, ObservableObject, SCStreamOutput {
    @Published var isRecording = false
    @Published var recordedURL: URL?
    @Published var errorMessage: String?
    
    private var stream: SCStream?
    private var assetWriter: AVAssetWriter?
    private var audioInput: AVAssetWriterInput?
    private var currentFileURL: URL?
    private var noteID: UUID?
    private var hasStartedSession = false
    
    /// 开始录制系统音频
    func startRecording(noteID: UUID) async {
        self.noteID = noteID
        
        // 请求屏幕录制权限（系统音频需要此权限）
        do {
            let content = try await SCShareableContent.current
            
            // 获取主显示器
            guard let display = content.displays.first else {
                errorMessage = "无法获取显示器"
                return
            }
            
            // 创建过滤器（捕获整个屏幕的音频）
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            
            // 配置流
            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = true  // 排除本应用的声音
            configuration.sampleRate = 48000
            configuration.channelCount = 2
            
            // 创建输出文件
            let fileURL = try createRecordingFile(noteID: noteID)
            currentFileURL = fileURL
            
            // 创建 Asset Writer
            assetWriter = try AVAssetWriter(url: fileURL, fileType: .m4a)
            
            // 配置音频设置
            let audioSettings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
            ]
            
            audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            audioInput?.expectsMediaDataInRealTime = true
            
            guard let audioInput = audioInput else {
                errorMessage = "无法创建音频输入"
                return
            }
            
            if assetWriter?.canAdd(audioInput) == true {
                assetWriter?.add(audioInput)
            }
            
            // 创建流
            stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
            try stream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "com.notebook.audio"))
            
            // 开始录制
            try await stream?.startCapture()
            assetWriter?.startWriting()
            hasStartedSession = false
            
            isRecording = true
            recordedURL = fileURL
            
            print("[SystemAudioRecorder] 开始录制系统音频: \(fileURL.path)")
            
        } catch {
            errorMessage = "启动录制失败: \(error.localizedDescription)"
            print("[SystemAudioRecorder] 启动失败: \(error)")
        }
    }
    
    /// 停止录制
    func stopRecording() async {
        guard isRecording else { return }
        
        do {
            // 停止捕获
            try await stream?.stopCapture()
            stream = nil
            
            // 完成写入
            audioInput?.markAsFinished()
            
            await assetWriter?.finishWriting()
            
            isRecording = false
            hasStartedSession = false
            
            print("[SystemAudioRecorder] 录制完成: \(currentFileURL?.path ?? "unknown")")
            
        } catch {
            errorMessage = "停止录制失败: \(error.localizedDescription)"
            print("[SystemAudioRecorder] 停止失败: \(error)")
        }
    }
    
    /// 处理捕获的音频样本
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        
        // 回调已在 sampleHandlerQueue 上，直接处理，避免跨并发域捕获 CMSampleBuffer
        guard self.isRecording else { return }
        guard let writer = self.assetWriter,
              let audioInput = self.audioInput,
              audioInput.isReadyForMoreMediaData else { return }
        
        if !self.hasStartedSession {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            let startTime = pts.isValid ? pts : .zero
            writer.startSession(atSourceTime: startTime)
            self.hasStartedSession = true
        }
        
        _ = audioInput.append(sampleBuffer)
    }
    
    /// 创建录制文件
    private func createRecordingFile(noteID: UUID) throws -> URL {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else {
            throw NSError(domain: "SystemAudioRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "未配置保存目录"])
        }
        
        return try location.withSecurityScopedAccess(base) {
            try location.ensureDirectoryStructureExists()
            let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            
            let fileURL = folder.appendingPathComponent("system_\(UUID().uuidString).m4a")
            return fileURL
        }
    }
}
