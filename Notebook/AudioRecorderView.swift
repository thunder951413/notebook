import SwiftUI
import AVFoundation
import ScreenCaptureKit
import Combine

/// 录音模式
enum AudioRecordingMode: String, CaseIterable {
    case microphone = "麦克风"
    case systemAudio = "系统音频"
    case mixed = "混合"
}

/// 苹果风格录音界面
@available(macOS 12.3, *)
struct AudioRecorderView: View {
    @Environment(\.dismiss) private var dismiss
    
    let noteID: UUID
    let onRecordingComplete: (URL) -> Void
    var onRequestClose: (() -> Void)? = nil
    
    @StateObject private var recorder = AppleStyleAudioRecorder()
    @State private var recordingMode: AudioRecordingMode = .microphone
    
    var body: some View {
        VStack(spacing: 8) {
            // 第一行：波形 + 输入源下拉 + 录制按钮
            HStack(spacing: 8) {
                WaveformView(audioLevels: recorder.audioLevels, isRecording: recorder.isRecording)
                    .frame(width: 180, height: 44)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                Menu {
                    ForEach(AudioRecordingMode.allCases, id: \.self) { mode in
                        Button {
                            guard !recorder.isRecording else { return }
                            recordingMode = mode
                            recorder.statusMessage = nil
                        } label: {
                            Label(modeName(for: mode), systemImage: modeIcon(for: mode))
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: modeIcon(for: recordingMode))
                            .font(.caption)
                        Text(modeName(for: recordingMode))
                            .font(.caption)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(Color.secondary.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .menuStyle(.borderlessButton)

                Button {
                    toggleRecording()
                } label: {
                    Image(systemName: recorder.isRecording ? "stop.fill" : "record.circle.fill")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(recorder.isRecording ? Color.red : Color.accentColor)
                        .frame(width: 32, height: 32)
                        .background(Color.secondary.opacity(0.1))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }

            // 第二行：时间 + 取消/保存
            HStack(alignment: .center) {
                Text(formatTime(recorder.currentTime))
                    .font(.system(size: 22, weight: .regular, design: .monospaced))
                    .foregroundStyle(.primary)

                Spacer()

                HStack(spacing: 12) {
                    Button("取消") {
                        Task {
                            await recorder.cancelRecording()
                            if let onRequestClose {
                                onRequestClose()
                            } else {
                                dismiss()
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .font(.caption)

                    Button("保存") {
                        if let url = recorder.recordedURL {
                            onRecordingComplete(url)
                        }
                        if let onRequestClose {
                            onRequestClose()
                        } else {
                            dismiss()
                        }
                    }
                    .buttonStyle(.plain)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.accentColor)
                    .font(.caption)
                    .disabled(!recorder.isFinished || recorder.recordedURL == nil)
                }
            }

            if let status = recorder.statusMessage, !status.isEmpty {
                Text(status)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.orange.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if recorder.isFinished && recorder.recordedURL != nil {
                playbackControls
            }
        }
        .padding(12)
        .frame(minWidth: 360, idealWidth: 400, minHeight: 140, idealHeight: 160)
        .onAppear {
            recorder.noteID = noteID
        }
        .onDisappear {
            recorder.cleanup()
        }
    }
    
    // MARK: - 模式选择器
    private var modeSelector: some View {
        HStack(spacing: 8) {
            modeChip(.microphone)
            modeChip(.systemAudio)
            modeChip(.mixed)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.08))
        .clipShape(Capsule())
    }

    private func modeChip(_ mode: AudioRecordingMode) -> some View {
        Button {
            guard !recorder.isRecording else { return }
            recordingMode = mode
            recorder.statusMessage = nil
        } label: {
            HStack(spacing: 4) {
                Image(systemName: modeIcon(for: mode))
                    .font(.caption)
                Text(modeName(for: mode))
                    .font(.caption)
                    .lineLimit(1)
            }
            .foregroundStyle(recordingMode == mode ? .white : .secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(recordingMode == mode ? Color.accentColor : Color.clear)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
    
    private func modeIcon(for mode: AudioRecordingMode) -> String {
        switch mode {
        case .microphone: return "microphone"
        case .systemAudio: return "speaker.wave.2"
        case .mixed: return "mic.badge.plus"
        }
    }
    
    private func modeName(for mode: AudioRecordingMode) -> String {
        switch mode {
        case .microphone: return "麦克风"
        case .systemAudio: return "系统音频"
        case .mixed: return "混合（系统声较低）"
        }
    }

    private var microphoneDiagnosticPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("权限")
                    .foregroundStyle(.secondary)
                Spacer()
                Text(recorder.micPermissionStatus)
                    .foregroundStyle(recorder.micPermissionStatus == "已授权" ? .green : .orange)
            }

            HStack {
                Text("输入设备")
                    .foregroundStyle(.secondary)
                Spacer()
                Text(recorder.micInputDeviceName)
                    .lineLimit(1)
            }

            HStack {
                Text("输入格式")
                    .foregroundStyle(.secondary)
                Spacer()
                Text(recorder.micInputFormatDescription)
                    .lineLimit(1)
            }

            HStack {
                Text("自检峰值")
                    .foregroundStyle(.secondary)
                Spacer()
                Text(String(format: "%.4f", recorder.micSelfTestPeak))
                    .monospacedDigit()
                    .foregroundStyle(recorder.micSelfTestPeak > 0.005 ? .green : .orange)
            }
        }
        .font(.system(size: 11))
        .padding(10)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
    
    // MARK: - 波形可视化
    struct WaveformView: View {
        let audioLevels: [Float]
        let isRecording: Bool
        
        var body: some View {
            GeometryReader { geometry in
                ZStack {
                    // 背景网格线
                    HStack(spacing: 0) {
                        ForEach(0..<50) { i in
                            Rectangle()
                                .fill(Color.secondary.opacity(0.1))
                                .frame(width: 1)
                                .frame(maxHeight: .infinity)
                            Spacer()
                        }
                    }
                    
                    // 波形
                    HStack(spacing: 4) {
                        ForEach(0..<min(audioLevels.count, 40), id: \.self) { index in
                            let level = audioLevels.count > index ? audioLevels[index] : 0
                            WaveformBar(level: level, isRecording: isRecording)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }
    
    struct WaveformBar: View {
        let level: Float
        let isRecording: Bool
        
        var body: some View {
            GeometryReader { geometry in
                let height = CGFloat(level) * geometry.size.height
                RoundedRectangle(cornerRadius: 2)
                    .fill(isRecording ? Color.red.gradient : Color.accentColor.gradient)
                    .frame(width: 6, height: max(height, 4))
                    .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
            }
        }
    }
    
    // MARK: - 播放控制
    private var playbackControls: some View {
        HStack(spacing: 20) {
            // 后退 15 秒
            Button {
                recorder.skipBackward()
            } label: {
                Image(systemName: "gobackward.15")
                    .font(.system(size: 18))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .disabled(!recorder.isFinished || recorder.recordedURL == nil)

            // 播放/暂停
            Button {
                recorder.togglePlayback()
            } label: {
                Image(systemName: recorder.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 32))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            .disabled(!recorder.isFinished || recorder.recordedURL == nil)

            // 前进 15 秒
            Button {
                recorder.skipForward()
            } label: {
                Image(systemName: "goforward.15")
                    .font(.system(size: 18))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .disabled(!recorder.isFinished || recorder.recordedURL == nil)
        }
    }
    
    // MARK: - 录制按钮
    private var recordButton: some View {
        Button {
            toggleRecording()
        } label: {
            ZStack {
                Circle()
                    .fill(recorder.isRecording ? Color.white : Color.red)
                    .frame(width: 80, height: 80)

                if recorder.isRecording {
                    // 录制中显示停止图标，避免“暂停”误导
                    Image(systemName: "stop.fill")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(.red)
                } else {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 32, height: 32)
                }
            }
            .shadow(radius: 4, y: 2)
        }
        .buttonStyle(.plain)
    }
    
    private func toggleRecording() {
        Task {
            if recorder.isRecording {
                await recorder.stopRecording()
            } else {
                await recorder.startRecording(mode: recordingMode)
            }
        }
    }
    
    // MARK: - 底部按钮
    private var bottomButtons: some View {
        HStack {
            // 取消按钮
            Button("取消") {
                Task {
                    await recorder.cancelRecording()
                    if let onRequestClose {
                        onRequestClose()
                    } else {
                        dismiss()
                    }
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            
            Spacer()
            
            // 完成按钮
            Button("完成") {
                guard recorder.isFinished,
                      let url = recorder.recordedURL,
                      FileManager.default.fileExists(atPath: url.path) else {
                    recorder.statusMessage = "录音文件不可用，请重新录制"
                    return
                }

                // 若播放中，先停止播放再提交，避免状态残留
                if recorder.isPlaying {
                    recorder.pausePlayback()
                }

                onRecordingComplete(url)
                if let onRequestClose {
                    onRequestClose()
                } else {
                    dismiss()
                }
            }
            .buttonStyle(.plain)
            .fontWeight(.semibold)
            .foregroundStyle(Color.accentColor)
            .disabled(!recorder.isFinished || recorder.recordedURL == nil)
        }
        .padding(.horizontal, 30)
    }
    
    // MARK: - 时间格式化
    private func formatTime(_ time: TimeInterval) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        let milliseconds = Int((time.truncatingRemainder(dividingBy: 1)) * 100)
        return String(format: "%02d:%02d.%02d", minutes, seconds, milliseconds)
    }
}

// MARK: - 苹果风格录音器
@available(macOS 12.3, *)
@MainActor
class AppleStyleAudioRecorder: NSObject, ObservableObject {
    @Published var isRecording = false
    @Published var isFinished = false
    @Published var isPlaying = false
    @Published var currentTime: TimeInterval = 0
    @Published var audioLevels: [Float] = Array(repeating: 0.1, count: 40)
    @Published var recordedURL: URL?
    @Published var statusMessage: String?
    @Published var micPermissionStatus: String = "未检测"
    @Published var micInputDeviceName: String = "-"
    @Published var micInputFormatDescription: String = "-"
    @Published var micSelfTestPeak: Float = 0
    
    var noteID: UUID?
    
    private var audioRecorder: AVAudioRecorder?
    private var liveMicrophoneLevel: Float = 0
    private var audioPlayer: AVAudioPlayer?
    private var timer: Timer?
    private var recordingStartTime: Date?
    
    // 系统音频录制
    private var systemRecorder: SystemAudioRecorder?
    // 混合音频录制
    private var mixedRecorder: MixedAudioRecorder?
    private var currentMode: AudioRecordingMode = .microphone
    
    /// 麦克风自检：权限 + 输入设备 + 1秒电平检测
    func runMicrophoneSelfTest() async {
        statusMessage = nil

        let permission = AVCaptureDevice.authorizationStatus(for: .audio)
        switch permission {
        case .authorized:
            micPermissionStatus = "已授权"
        case .denied, .restricted:
            micPermissionStatus = "未授权"
            statusMessage = "麦克风权限未授权，请到 系统设置 > 隐私与安全性 > 麦克风 开启"
            return
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            micPermissionStatus = granted ? "已授权" : "未授权"
            if !granted {
                statusMessage = "麦克风权限被拒绝"
                return
            }
        @unknown default:
            micPermissionStatus = "未知"
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let inputName = AVCaptureDevice.default(for: .audio)?.localizedName ?? "unknown"

        micInputDeviceName = inputName
        micInputFormatDescription = "\(Int(format.channelCount))ch @ \(Int(format.sampleRate))Hz"

        var peak: Float = 0
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            guard let channelData = buffer.floatChannelData else { return }
            let frameCount = Int(buffer.frameLength)
            let channels = Int(buffer.format.channelCount)
            guard frameCount > 0, channels > 0 else { return }

            var localPeak: Float = 0
            for c in 0..<channels {
                let ch = channelData[c]
                for i in 0..<frameCount {
                    localPeak = max(localPeak, abs(ch[i]))
                }
            }
            peak = max(peak, localPeak)
        }

        do {
            try engine.start()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            input.removeTap(onBus: 0)
            engine.stop()

            micSelfTestPeak = peak
            let levelText = String(format: "%.4f", peak)
            if peak < 0.005 {
                statusMessage = "自检失败：检测到麦克风输入接近静音（peak=\(levelText)），请检查系统输入设备/静音状态"
            } else {
                statusMessage = "自检通过：input=\(inputName), peak=\(levelText)"
            }
            print("[MicSelfTest] input=\(inputName), format=\(format), peak=\(levelText)")
        } catch {
            input.removeTap(onBus: 0)
            engine.stop()
            micSelfTestPeak = 0
            statusMessage = "自检失败：\(error.localizedDescription)"
            print("[MicSelfTest] failed: \(error)")
        }
    }

    /// 开始录制
    func startRecording(mode: AudioRecordingMode) async {
        guard let noteID = noteID else { return }

        // 启动前先清理可能残留的录音/播放链路，避免状态串扰
        await systemRecorder?.stopRecording()
        await mixedRecorder?.stopRecording()
        audioRecorder?.stop()
        audioPlayer?.stop()
        isPlaying = false
        systemRecorder = nil
        mixedRecorder = nil
        audioRecorder = nil

        currentMode = mode
        isFinished = false
        statusMessage = nil
        
        // 请求权限
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else { return }
        
        do {
            let preparedFileURL: URL?
            if mode != .mixed {
                let fileURL = try createRecordingFile(noteID: noteID, mode: mode)
                recordedURL = fileURL
                preparedFileURL = fileURL
            } else {
                recordedURL = nil
                preparedFileURL = nil
            }
            
            switch mode {
            case .microphone:
                guard let fileURL = preparedFileURL else {
                    throw NSError(domain: "AppleStyleAudioRecorder", code: 1001, userInfo: [NSLocalizedDescriptionKey: "麦克风录制文件路径无效"])
                }
                try startMicrophoneRecording(fileURL: fileURL)
            case .systemAudio:
                // 系统音频录制
                systemRecorder = SystemAudioRecorder()
                await systemRecorder?.startRecording(noteID: noteID)
                isRecording = systemRecorder?.isRecording ?? false
            case .mixed:
                // 混合录制（系统音频 + 麦克风）
                mixedRecorder = MixedAudioRecorder()
                await mixedRecorder?.startRecording(noteID: noteID)
                isRecording = mixedRecorder?.isRecording ?? false
                if let mixedStatus = mixedRecorder?.statusMessage {
                    statusMessage = mixedStatus
                }
                if let mixedError = mixedRecorder?.errorMessage {
                    statusMessage = mixedError
                }
                if !isRecording {
                    recordedURL = nil
                }
            }
            
            if isRecording {
                recordingStartTime = Date()
                startTimer()
            }
            
        } catch {
            print("[AppleStyleAudioRecorder] 启动失败: \(error)")
        }
    }
    
    
    /// 停止录制
    func stopRecording() async {
        guard isRecording else { return }
        
        print("[AppleStyleAudioRecorder] 停止录制, 模式: \(currentMode)")
        
        isRecording = false
        
        switch currentMode {
        case .microphone:
            audioRecorder?.stop()
            audioRecorder = nil
            print("[AppleStyleAudioRecorder] 麦克风录制已停止, 文件: \(recordedURL?.path ?? "nil")")
            // 检查文件是否存在
            if let url = recordedURL {
                let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
                let fileSize = attrs?[.size] as? Int64 ?? 0
                print("[AppleStyleAudioRecorder] 文件大小: \(fileSize) bytes")
            }
        case .systemAudio:
            await systemRecorder?.stopRecording()
            if systemRecorder?.recordedURL != nil {
                recordedURL = systemRecorder?.recordedURL
            }
            print("[AppleStyleAudioRecorder] 系统音频录制已停止, 文件: \(recordedURL?.path ?? "nil")")
        case .mixed:
            await mixedRecorder?.stopRecording()
            if let mixedURL = mixedRecorder?.recordedURL,
               FileManager.default.fileExists(atPath: mixedURL.path) {
                recordedURL = mixedURL
            } else {
                recordedURL = nil
            }
            if let mixedStatus = mixedRecorder?.statusMessage {
                statusMessage = mixedStatus
                print("[AppleStyleAudioRecorder] 混合录制状态: \(mixedStatus)")
            }
            if let mixedError = mixedRecorder?.errorMessage {
                statusMessage = mixedError
                print("[AppleStyleAudioRecorder] 混合录制提示: \(mixedError)")
            }
            print("[AppleStyleAudioRecorder] 混合录制已停止, 文件: \(recordedURL?.path ?? "nil")")
        }
        
        stopTimer()
        isFinished = true
    }
    
    /// 取消录制
    func cancelRecording() async {
        await stopRecording()
        
        // 删除录制的文件
        if let url = recordedURL {
            try? FileManager.default.removeItem(at: url)
        }
        
        cleanup()
    }
    
    /// 清理
    func cleanup() {
        stopTimer()
        audioRecorder?.stop()
        audioRecorder = nil
        audioPlayer = nil
        systemRecorder = nil
        mixedRecorder = nil
    }
    
    // MARK: - 播放控制
    
    func togglePlayback() {
        if isPlaying {
            pausePlayback()
        } else {
            startPlayback()
        }
    }
    
    func startPlayback() {
        // 播放前确保录音链路完全关闭，避免输入重配影响输出
        audioRecorder?.stop()
        audioRecorder = nil

        guard let url = recordedURL else {
            print("[AppleStyleAudioRecorder] 播放失败: 没有录制文件")
            return
        }
        
        // 检查文件是否存在
        guard FileManager.default.fileExists(atPath: url.path) else {
            print("[AppleStyleAudioRecorder] 播放失败: 文件不存在 \(url.path)")
            return
        }
        
        // 检查文件大小
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = attrs?[.size] as? Int64 ?? 0
        print("[AppleStyleAudioRecorder] 播放文件: \(url.path), 大小: \(fileSize) bytes")
        
        do {
            audioPlayer = try AVAudioPlayer(contentsOf: url)
            audioPlayer?.delegate = self
            audioPlayer?.volume = 1.0
            audioPlayer?.prepareToPlay()
            let duration = audioPlayer?.duration ?? 0
            print("[AppleStyleAudioRecorder] 音频时长: \(duration) 秒, volume=\(audioPlayer?.volume ?? -1)")
            let played = audioPlayer?.play() ?? false
            print("[AppleStyleAudioRecorder] play() -> \(played)")
            isPlaying = played

            // 二次验证：若 AVAudioPlayer 播放失败，尝试 NSSound 回放定位问题
            if !played {
                let fallbackSound = NSSound(contentsOf: url, byReference: false)
                let fallbackPlayed = fallbackSound?.play() ?? false
                print("[AppleStyleAudioRecorder] NSSound fallback play() -> \(fallbackPlayed)")
            }
            
            // 启动播放进度定时器
            startPlaybackTimer()
        } catch {
            print("[AppleStyleAudioRecorder] 播放失败: \(error)")
        }
    }
    
    func pausePlayback() {
        audioPlayer?.pause()
        isPlaying = false
        stopTimer()
    }
    
    func skipForward() {
        guard let player = audioPlayer else { return }
        player.currentTime = min(player.currentTime + 15, player.duration)
        currentTime = player.currentTime
    }
    
    func skipBackward() {
        guard let player = audioPlayer else { return }
        player.currentTime = max(player.currentTime - 15, 0)
        currentTime = player.currentTime
    }
    
    // MARK: - 私有方法
    
    private func startMicrophoneRecording(fileURL: URL) throws {
        print("[AppleStyleAudioRecorder] 开始麦克风录制: \(fileURL.path)")

        // 使用 CAF + PCM，绕开当前设备上的 AAC 实时链路异常（reconfig pending）
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 44100.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]

        audioRecorder = try AVAudioRecorder(url: fileURL, settings: settings)
        audioRecorder?.isMeteringEnabled = true
        audioRecorder?.prepareToRecord()
        let success = audioRecorder?.record()

        if success == true {
            let inputName = AVCaptureDevice.default(for: .audio)?.localizedName ?? "unknown"
            print("[AppleStyleAudioRecorder] 麦克风录制启动: 成功, input=\(inputName)")
            isRecording = true
            liveMicrophoneLevel = 0.05
        } else {
            throw NSError(domain: "AppleStyleAudioRecorder", code: 1004, userInfo: [NSLocalizedDescriptionKey: "麦克风录制启动失败"])
        }
    }
    
    private func createRecordingFile(noteID: UUID, mode: AudioRecordingMode) throws -> URL {
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else {
            throw NSError(domain: "AppleStyleAudioRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "未配置保存目录"])
        }
        
        return try location.withSecurityScopedAccess(base) {
            try location.ensureDirectoryStructureExists()
            let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            
            let prefix = mode == .microphone ? "mic" : (mode == .systemAudio ? "system" : "mixed")
            let ext = mode == .microphone ? "caf" : "m4a"
            let fileURL = folder.appendingPathComponent("\(prefix)_\(UUID().uuidString).\(ext)")
            return fileURL
        }
    }
    
    private func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
            Task { @MainActor in
                self.updateAudioLevels()
            }
        }
    }
    
    private func startPlaybackTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
            Task { @MainActor in
                self.currentTime = self.audioPlayer?.currentTime ?? 0
            }
        }
    }
    
    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    
    private func updateAudioLevels() {
        // 更新录音时间
        if let startTime = recordingStartTime {
            let elapsed = Date().timeIntervalSince(startTime)
            currentTime = elapsed
        }
        
        // 更新音频电平
        switch currentMode {
        case .microphone:
            audioRecorder?.updateMeters()
            let level = audioRecorder?.averagePower(forChannel: 0) ?? -160
            let normalizedLevel = max(0, (level + 60) / 60)
            liveMicrophoneLevel = Float(normalizedLevel)
            updateWaveform(with: liveMicrophoneLevel)
        case .systemAudio, .mixed:
            // 系统音频使用模拟波形 - 只在有录音数据时显示
            if isRecording {
                // 使用更真实的模拟，基于时间变化
                let time = Date().timeIntervalSince1970
                let simulatedLevel = (sin(time * 10) + 1) / 2 * 0.3 + 0.1
                updateWaveform(with: Float(simulatedLevel))
            } else {
                updateWaveform(with: 0.05) // 静止时显示低电平
            }
        }
    }
    
    private func updateWaveform(with level: Float) {
        // 移除最旧的电平，添加最新的
        audioLevels.removeFirst()
        // 添加一些随机变化使波形更自然
        let variation = Float.random(in: -0.05...0.05)
        let finalLevel = max(0.02, min(1.0, level + variation))
        audioLevels.append(finalLevel)
    }
}

// MARK: - AVAudioPlayerDelegate
@available(macOS 12.3, *)
extension AppleStyleAudioRecorder: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            isPlaying = false
            currentTime = 0
            stopTimer()
        }
    }
}

// MARK: - 旧版录音界面（macOS 12.3 以下）

struct LegacyAudioRecorderView: View {
    @Environment(\.dismiss) private var dismiss
    
    let noteID: UUID
    let onRecordingComplete: (URL) -> Void
    var onRequestClose: (() -> Void)? = nil
    
    @StateObject private var recorder = LegacyAudioRecorder()
    @State private var isRecording = false
    @State private var recordedURL: URL?
    
    var body: some View {
        VStack(spacing: 20) {
            Text("录音")
                .font(.headline)
            
            Spacer()
            
            // 录制按钮
            Button {
                toggleRecording()
            } label: {
                ZStack {
                    Circle()
                        .fill(isRecording ? Color.white : Color.red)
                        .frame(width: 80, height: 80)
                        .shadow(radius: 4)
                    
                    if isRecording {
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.red)
                            .frame(width: 24, height: 24)
                    } else {
                        Circle()
                            .fill(Color.red)
                            .frame(width: 32, height: 32)
                    }
                }
            }
            .buttonStyle(.plain)
            
            Spacer()
            
            // 底部按钮
            HStack {
                Button("取消") {
                    recorder.stopRecording()
                    if let onRequestClose {
                        onRequestClose()
                    } else {
                        dismiss()
                    }
                }
                .buttonStyle(.plain)
                
                Spacer()
                
                Button("完成") {
                    if let url = recordedURL {
                        onRecordingComplete(url)
                    }
                    if let onRequestClose {
                        onRequestClose()
                    } else {
                        dismiss()
                    }
                }
                .buttonStyle(.plain)
                .disabled(recordedURL == nil)
            }
            .padding(.horizontal)
        }
        .frame(width: 300, height: 300)
        .onAppear {
            recorder.noteID = noteID
        }
    }
    
    private func toggleRecording() {
        if isRecording {
            recorder.stopRecording()
            recordedURL = recorder.recordedURL
            isRecording = false
        } else {
            recorder.startRecording()
            isRecording = true
        }
    }
}

@MainActor
class LegacyAudioRecorder: ObservableObject {
    @Published var recordedURL: URL?
    
    var noteID: UUID?
    private var audioRecorder: AVAudioRecorder?
    
    func startRecording() {
        guard let noteID = noteID else { return }
        
        let location = StorageLocationManager.shared
        guard let base = location.baseDirectoryURL else { return }
        
        location.withSecurityScopedAccess(base) {
            do {
                try location.ensureDirectoryStructureExists()
                let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                
                let fileURL = folder.appendingPathComponent("recording_\(UUID().uuidString).m4a")
                
                let settings: [String: Any] = [
                    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                    AVSampleRateKey: 44100.0,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
                ]
                
                audioRecorder = try AVAudioRecorder(url: fileURL, settings: settings)
                audioRecorder?.prepareToRecord()
                audioRecorder?.record()
                
                recordedURL = fileURL
                
            } catch {
                print("[LegacyAudioRecorder] 启动失败: \(error)")
            }
        }
    }
    
    func stopRecording() {
        audioRecorder?.stop()
        audioRecorder = nil
    }
}
