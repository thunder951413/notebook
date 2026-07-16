import SwiftUI
import AVFoundation

/// 音频播放器弹窗内容 - 支持单轨/混合播放
@available(macOS 12.0, *)
struct AudioPlayerPopoverContent: View {
    enum PlaybackRoute: String, CaseIterable {
        case mixed = "混合"
        case mic = "仅麦克风"
        case system = "仅系统"
        case realtimeMix = "实时混音"
    }

    private struct MixedTrackManifest: Codable {
        let micFileName: String?
        let systemFileName: String?
    }

    let fileURL: URL

    @State private var audioPlayer: AVAudioPlayer?
    @State private var isPlaying = false
    @State private var currentTime: TimeInterval = 0
    @State private var duration: TimeInterval = 0
    @State private var timer: Timer?

    @State private var selectedRoute: PlaybackRoute = .mixed
    @State private var micTrackURL: URL?
    @State private var systemTrackURL: URL?
    @State private var micGain: Double = 1.0
    @State private var systemGain: Double = 0.35

    @State private var audioEngine: AVAudioEngine?
    @State private var micNode: AVAudioPlayerNode?
    @State private var systemNode: AVAudioPlayerNode?
    @State private var playbackStartedAt: Date?

    var body: some View {
        VStack(spacing: 14) {
            Picker("播放源", selection: $selectedRoute) {
                ForEach(availableRoutes, id: \.self) { route in
                    Text(route.rawValue).tag(route)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)

            if selectedRoute == .realtimeMix {
                VStack(spacing: 8) {
                    HStack {
                        Text("麦克风")
                        Slider(value: $micGain, in: 0...2)
                            .onChange(of: micGain) { _, _ in updateRealtimeMixVolume() }
                    }
                    HStack {
                        Text("系统")
                        Slider(value: $systemGain, in: 0...2)
                            .onChange(of: systemGain) { _, _ in updateRealtimeMixVolume() }
                    }
                }
                .padding(.horizontal, 16)
            }

            HStack {
                Text(formatTime(currentTime))
                    .font(.system(size: 14, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(formatTime(duration))
                    .font(.system(size: 14, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 20)

            Slider(value: $currentTime, in: 0...max(duration, 1), onEditingChanged: { editing in
                guard selectedRoute != .realtimeMix else { return }
                if !editing {
                    audioPlayer?.currentTime = currentTime
                }
            })
            .disabled(selectedRoute == .realtimeMix)
            .padding(.horizontal, 20)

            HStack(spacing: 40) {
                Button(action: skipBackward) {
                    Image(systemName: "gobackward.15")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(selectedRoute == .realtimeMix)

                Button(action: togglePlayback) {
                    Image(systemName: isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 50))
                }
                .buttonStyle(.plain)

                Button(action: skipForward) {
                    Image(systemName: "goforward.15")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(selectedRoute == .realtimeMix)
            }
            .padding(.bottom, 12)
        }
        .frame(width: 360, height: selectedRoute == .realtimeMix ? 300 : 250)
        .onAppear {
            loadTrackManifest()
            setupPlayerForCurrentRoute()
        }
        .onChange(of: selectedRoute) { _, _ in
            stopPlayback()
            setupPlayerForCurrentRoute()
        }
        .onDisappear {
            stopPlayback()
        }
    }

    private var availableRoutes: [PlaybackRoute] {
        var routes: [PlaybackRoute] = [.mixed]
        if micTrackURL != nil { routes.append(.mic) }
        if systemTrackURL != nil { routes.append(.system) }
        if micTrackURL != nil && systemTrackURL != nil { routes.append(.realtimeMix) }
        return routes
    }

    private func loadTrackManifest() {
        let manifestURL = fileURL.deletingPathExtension().appendingPathExtension("tracks.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path),
              let data = try? Data(contentsOf: manifestURL),
              let manifest = try? JSONDecoder().decode(MixedTrackManifest.self, from: data) else {
            return
        }
        if let mic = manifest.micFileName {
            let u = fileURL.deletingLastPathComponent().appendingPathComponent(mic)
            if FileManager.default.fileExists(atPath: u.path) { micTrackURL = u }
        }
        if let sys = manifest.systemFileName {
            let u = fileURL.deletingLastPathComponent().appendingPathComponent(sys)
            if FileManager.default.fileExists(atPath: u.path) { systemTrackURL = u }
        }
    }

    private func setupPlayerForCurrentRoute() {
        switch selectedRoute {
        case .mixed:
            setupSimplePlayer(with: fileURL)
        case .mic:
            if let micTrackURL { setupSimplePlayer(with: micTrackURL) }
        case .system:
            if let systemTrackURL { setupSimplePlayer(with: systemTrackURL) }
        case .realtimeMix:
            Task {
                async let micDuration = trackDuration(micTrackURL)
                async let systemDuration = trackDuration(systemTrackURL)
                duration = min(await micDuration, await systemDuration)
            }
            currentTime = 0
        }
    }

    private func setupSimplePlayer(with url: URL) {
        do {
            audioPlayer = try AVAudioPlayer(contentsOf: url)
            audioPlayer?.prepareToPlay()
            duration = audioPlayer?.duration ?? 0
            currentTime = 0
        } catch {
            DebugLog.attachment("无法加载音频: \(error)", level: .warn)
        }
    }

    private func togglePlayback() {
        if isPlaying { pausePlayback() } else { startPlayback() }
    }

    private func startPlayback() {
        if selectedRoute == .realtimeMix {
            startRealtimeMixPlayback()
        } else {
            audioPlayer?.play()
        }
        isPlaying = true
        startTimer()
    }

    private func pausePlayback() {
        if selectedRoute == .realtimeMix {
            stopRealtimeMixPlayback()
        } else {
            audioPlayer?.pause()
        }
        isPlaying = false
        stopTimer()
    }

    private func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        stopRealtimeMixPlayback()
        isPlaying = false
        stopTimer()
    }

    private func startRealtimeMixPlayback() {
        guard let micURL = micTrackURL, let systemURL = systemTrackURL else { return }
        do {
            let engine = AVAudioEngine()
            let micNode = AVAudioPlayerNode()
            let systemNode = AVAudioPlayerNode()

            engine.attach(micNode)
            engine.attach(systemNode)

            let main = engine.mainMixerNode
            let micFile = try AVAudioFile(forReading: micURL)
            let systemFile = try AVAudioFile(forReading: systemURL)

            engine.connect(micNode, to: main, format: micFile.processingFormat)
            engine.connect(systemNode, to: main, format: systemFile.processingFormat)

            try engine.start()
            micNode.scheduleFile(micFile, at: nil)
            systemNode.scheduleFile(systemFile, at: nil)
            micNode.volume = Float(micGain)
            systemNode.volume = Float(systemGain)
            micNode.play()
            systemNode.play()

            self.audioEngine = engine
            self.micNode = micNode
            self.systemNode = systemNode
            self.playbackStartedAt = Date()
        } catch {
            DebugLog.attachment("实时混音播放失败: \(error)", level: .warn)
        }
    }

    private func stopRealtimeMixPlayback() {
        micNode?.stop()
        systemNode?.stop()
        audioEngine?.stop()
        micNode = nil
        systemNode = nil
        audioEngine = nil
        playbackStartedAt = nil
    }

    private func updateRealtimeMixVolume() {
        micNode?.volume = Float(micGain)
        systemNode?.volume = Float(systemGain)
    }

    private func skipForward() {
        guard let player = audioPlayer else { return }
        player.currentTime = min(player.currentTime + 15, player.duration)
        currentTime = player.currentTime
    }

    private func skipBackward() {
        guard let player = audioPlayer else { return }
        player.currentTime = max(player.currentTime - 15, 0)
        currentTime = player.currentTime
    }

    private func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            Task { @MainActor in
                updatePlaybackProgress()
            }
        }
    }

    private func updatePlaybackProgress() {
        if selectedRoute == .realtimeMix {
            if let start = playbackStartedAt {
                currentTime = min(Date().timeIntervalSince(start), duration)
            }
        } else {
            currentTime = audioPlayer?.currentTime ?? 0
        }

        if currentTime >= duration {
            isPlaying = false
            stopTimer()
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func trackDuration(_ url: URL?) async -> TimeInterval {
        guard let url else { return 0 }
        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            return CMTimeGetSeconds(duration)
        } catch {
            DebugLog.attachment("无法加载时长: \(error)", level: .warn)
            return 0
        }
    }

    private func formatTime(_ time: TimeInterval) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

/// 音频播放器弹窗（带标题栏）
@available(macOS 12.0, *)
struct AudioPlayerPopover: View {
    let fileURL: URL
    let onDismiss: () -> Void
    
    var body: some View {
        VStack(spacing: 0) {
            // 顶部标题栏
            HStack {
                Text("录音")
                    .font(.headline)
                Spacer()
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal)
            .padding(.top, 10)
            
            // 播放器内容
            AudioPlayerPopoverContent(fileURL: fileURL)
        }
        .frame(width: 320, height: 280)
    }
}
