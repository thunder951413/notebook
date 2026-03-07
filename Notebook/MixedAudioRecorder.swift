import Foundation
import AVFoundation
import ScreenCaptureKit
import Combine

private struct MixedTrackManifest: Codable {
    let micFileName: String?
    let systemFileName: String?
}

/// 混合音频录制器 - 同时录制系统音频和麦克风
@available(macOS 12.3, *)
@MainActor
class MixedAudioRecorder: NSObject, ObservableObject {
    @Published var isRecording = false
    @Published var recordedURL: URL?
    @Published var errorMessage: String?
    @Published var statusMessage: String?
    
    private var systemRecorder: SystemAudioRecorder?
    private var microphoneRecorder: AVAudioRecorder?
    private var noteID: UUID?
    private var systemAudioURL: URL?
    private var microphoneURL: URL?

    // 连续系统音频失败保护：避免每次都触发 ScreenCaptureKit 异常路径
    private static var consecutiveSystemCaptureFailures = 0
    private static let maxConsecutiveSystemFailuresBeforeBypass = 2
    
    /// 开始录制混合音频
    func startRecording(noteID: UUID) async {
        self.noteID = noteID
        errorMessage = nil
        statusMessage = nil
        recordedURL = nil
        
        // 请求麦克风权限
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        guard granted else {
            errorMessage = "需要麦克风权限"
            return
        }
        
        do {
            // 创建文件路径
            let location = StorageLocationManager.shared
            guard let base = location.baseDirectoryURL else {
                throw NSError(domain: "MixedAudioRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "未配置保存目录"])
            }
            
            try location.withSecurityScopedAccess(base) {
                try location.ensureDirectoryStructureExists()
                let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                
                systemAudioURL = folder.appendingPathComponent("system_\(UUID().uuidString).m4a")
                microphoneURL = folder.appendingPathComponent("mic_\(UUID().uuidString).caf")
            }
            
            // 1. 先启动系统音频（可能触发音频路由重配）
            // 若已连续失败多次，则短路到麦克风模式，减少 SCStream 错误噪音
            if Self.consecutiveSystemCaptureFailures >= Self.maxConsecutiveSystemFailuresBeforeBypass {
                statusMessage = "系统音频当前不可用，已自动切换为麦克风录音"
                systemRecorder = nil
            } else {
                systemRecorder = SystemAudioRecorder()
                await systemRecorder?.startRecording(noteID: noteID)
                if systemRecorder?.isRecording != true {
                    statusMessage = "系统音频启动失败，将仅保存麦克风"
                    errorMessage = systemRecorder?.errorMessage
                    systemRecorder = nil
                    Self.consecutiveSystemCaptureFailures += 1
                }
            }

            // 2. 再启动麦克风，避免被系统捕获启动阶段的重配影响
            // 适当延迟一小段时间，让音频设备完成重配
            try await Task.sleep(nanoseconds: 250_000_000)
            try startMicrophoneRecording()
            
            isRecording = true
            print("[MixedAudioRecorder] 开始混合录制")
            
        } catch {
            errorMessage = "启动录制失败: \(error.localizedDescription)"
            print("[MixedAudioRecorder] 启动失败: \(error)")
        }
    }
    
    /// 停止录制
    func stopRecording() async {
        guard isRecording else { return }
        
        print("[MixedAudioRecorder] 停止录制")
        
        // 停止系统音频录制
        await systemRecorder?.stopRecording()
        
        // 停止麦克风录制
        microphoneRecorder?.stop()
        
        isRecording = false
        
        // 混合音频文件
        await mixAudioFiles()
    }
    
    /// 启动麦克风录制
    private func startMicrophoneRecording() throws {
        guard let url = microphoneURL else {
            throw NSError(domain: "MixedAudioRecorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "麦克风输出路径无效"])
        }
        
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 44100.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]

        microphoneRecorder = try AVAudioRecorder(url: url, settings: settings)
        microphoneRecorder?.isMeteringEnabled = true
        microphoneRecorder?.prepareToRecord()
        let success = microphoneRecorder?.record() ?? false
        
        print("[MixedAudioRecorder] 麦克风录制启动: \(success ? "成功" : "失败")")
        if !success {
            throw NSError(domain: "MixedAudioRecorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "麦克风录制启动失败"])
        }
    }
    
    /// 混合系统音频和麦克风音频
    private func mixAudioFiles() async {
        guard let micURL = microphoneURL else {
            print("[MixedAudioRecorder] 缺少麦克风音频文件")
            errorMessage = "录制失败：麦克风音轨缺失"
            return
        }

        let micAvailable = await isValidAudioFile(at: micURL)
        let systemURL = systemRecorder?.recordedURL
        let systemAvailable = await isValidOptionalAudioFile(systemURL)

        guard micAvailable || systemAvailable else {
            print("[MixedAudioRecorder] 麦克风与系统音轨都无效")
            recordedURL = nil
            errorMessage = "录制失败：未捕获到有效音频"
            return
        }

        // 仅有单轨可用时直接回退，确保不丢录音
        if micAvailable && !systemAvailable {
            recordedURL = micURL
            statusMessage = "系统音频不可用，已保存麦克风录音"
            print("[MixedAudioRecorder] 仅麦克风轨有效，直接回退")
            Self.consecutiveSystemCaptureFailures += 1
            return
        }
        if systemAvailable && !micAvailable, let systemURL {
            recordedURL = systemURL
            statusMessage = "麦克风不可用，已保存系统音频"
            print("[MixedAudioRecorder] 仅系统轨有效，直接回退")
            return
        }

        guard let systemURL else {
            recordedURL = micURL
            statusMessage = "系统音频不可用，已保存麦克风录音"
            return
        }

        do {
            // 创建输出文件
            let location = StorageLocationManager.shared
            guard let base = location.baseDirectoryURL,
                  let noteID = noteID else { return }

            let mixedURL = try location.withSecurityScopedAccess(base) {
                let folder = try location.attachmentsDirectoryURL().appendingPathComponent(noteID.uuidString, isDirectory: true)
                return folder.appendingPathComponent("mixed_\(UUID().uuidString).m4a")
            }

            // 使用 AVAssetExportSession 混合音频
            let composition = AVMutableComposition()

            let systemAsset = AVURLAsset(url: systemURL)
            let micAsset = AVURLAsset(url: micURL)

            guard let systemTrack = composition.addMutableTrack(
                withMediaType: .audio,
                preferredTrackID: kCMPersistentTrackID_Invalid
            ),
            let micTrack = composition.addMutableTrack(
                withMediaType: .audio,
                preferredTrackID: kCMPersistentTrackID_Invalid
            ) else {
                print("[MixedAudioRecorder] 无法创建音频轨道")
                recordedURL = micURL
                statusMessage = "混音失败，已回退到麦克风录音"
                return
            }

            guard let systemSourceTrack = try? await systemAsset.loadTracks(withMediaType: .audio).first,
                  let micSourceTrack = try? await micAsset.loadTracks(withMediaType: .audio).first else {
                print("[MixedAudioRecorder] 无法加载音频轨道")
                recordedURL = micURL
                statusMessage = "系统音轨异常，已回退到麦克风录音"
                return
            }

            let systemDuration = try? await systemAsset.load(.duration)
            let micDuration = try? await micAsset.load(.duration)
            let duration = min(systemDuration ?? .zero, micDuration ?? .zero)

            guard duration > .zero else {
                print("[MixedAudioRecorder] 音频时长无效")
                recordedURL = micURL
                statusMessage = "系统音轨无效，已回退到麦克风录音"
                return
            }

            try systemTrack.insertTimeRange(
                CMTimeRange(start: .zero, duration: duration),
                of: systemSourceTrack,
                at: .zero
            )

            try micTrack.insertTimeRange(
                CMTimeRange(start: .zero, duration: duration),
                of: micSourceTrack,
                at: .zero
            )

            guard let exportSession = AVAssetExportSession(
                asset: composition,
                presetName: AVAssetExportPresetAppleM4A
            ) else {
                print("[MixedAudioRecorder] 无法创建导出会话")
                recordedURL = micURL
                statusMessage = "混音失败，已回退到麦克风录音"
                return
            }

            // 调整混音电平：降低系统音量，抬高麦克风可感知度
            let audioMix = AVMutableAudioMix()
            let systemParams = AVMutableAudioMixInputParameters(track: systemTrack)
            systemParams.setVolume(0.35, at: .zero)
            let micParams = AVMutableAudioMixInputParameters(track: micTrack)
            micParams.setVolume(1.0, at: .zero)
            audioMix.inputParameters = [systemParams, micParams]
            exportSession.audioMix = audioMix

            exportSession.outputURL = mixedURL
            exportSession.outputFileType = .m4a

            if #available(macOS 15.0, *) {
                try await exportSession.export(to: mixedURL, as: .m4a)
                let attrs = try? FileManager.default.attributesOfItem(atPath: mixedURL.path)
                let fileSize = attrs?[.size] as? Int64 ?? 0
                if fileSize < 10 * 1024 {
                    print("[MixedAudioRecorder] 混合文件体积过小(\(fileSize) bytes)，优先回退到有效轨")
                    try? FileManager.default.removeItem(at: mixedURL)

                    if micAvailable {
                        recordedURL = micURL
                        statusMessage = "系统音频未捕获成功，已回退为麦克风录音"
                        Self.consecutiveSystemCaptureFailures += 1
                    } else if systemAvailable {
                        recordedURL = systemURL
                        statusMessage = "麦克风未捕获成功，已回退为系统音频"
                    } else {
                        errorMessage = "混合导出后无可用音轨"
                    }
                } else {
                    if FileManager.default.fileExists(atPath: mixedURL.path) {
                        recordedURL = mixedURL
                        Self.consecutiveSystemCaptureFailures = 0
                        print("[MixedAudioRecorder] 混合音频导出成功: \(mixedURL.path), 大小: \(fileSize) bytes")
                        writeTrackManifest(for: mixedURL, micURL: micURL, systemURL: systemURL)
                    } else {
                        print("[MixedAudioRecorder] 混合导出标记成功但文件不存在，回退到有效轨")
                        if micAvailable {
                            recordedURL = micURL
                            statusMessage = "混合文件缺失，已回退为麦克风录音"
                        } else if systemAvailable {
                            recordedURL = systemURL
                            statusMessage = "混合文件缺失，已回退为系统音频"
                        } else {
                            errorMessage = "混合文件缺失且无可用音轨"
                        }
                    }
                }
            } else {
                await exportSession.export()
                if exportSession.status == .completed {
                    let attrs = try? FileManager.default.attributesOfItem(atPath: mixedURL.path)
                    let fileSize = attrs?[.size] as? Int64 ?? 0
                    if fileSize < 10 * 1024 {
                        print("[MixedAudioRecorder] 混合文件体积过小(\(fileSize) bytes)，优先回退到有效轨")
                        try? FileManager.default.removeItem(at: mixedURL)

                        if micAvailable {
                            recordedURL = micURL
                            statusMessage = "系统音频未捕获成功，已回退为麦克风录音"
                            Self.consecutiveSystemCaptureFailures += 1
                        } else if systemAvailable {
                            recordedURL = systemURL
                            statusMessage = "麦克风未捕获成功，已回退为系统音频"
                        } else {
                            errorMessage = "混合导出后无可用音轨"
                        }
                    } else {
                        recordedURL = mixedURL
                        Self.consecutiveSystemCaptureFailures = 0
                        print("[MixedAudioRecorder] 混合音频导出成功: \(mixedURL.path), 大小: \(fileSize) bytes")
                        writeTrackManifest(for: mixedURL, micURL: micURL, systemURL: systemURL)
                    }
                } else {
                    print("[MixedAudioRecorder] 混合音频导出失败: \(exportSession.error?.localizedDescription ?? "未知错误")")
                    if micAvailable {
                        recordedURL = micURL
                        statusMessage = "混合导出失败，已回退为麦克风录音"
                        Self.consecutiveSystemCaptureFailures += 1
                    } else if systemAvailable {
                        recordedURL = systemURL
                        statusMessage = "混合导出失败，已回退为系统音频"
                    } else {
                        errorMessage = "混合导出失败且无可用音轨"
                    }
                }
            }

        } catch {
            print("[MixedAudioRecorder] 混合音频失败: \(error)")
            if micAvailable {
                recordedURL = micURL
                statusMessage = "混音失败，已回退为麦克风录音"
            } else if systemAvailable {
                recordedURL = systemURL
                statusMessage = "混音失败，已回退为系统音频"
            } else {
                errorMessage = "混音失败且无可用音轨"
            }
        }
    }

    private func isValidOptionalAudioFile(_ url: URL?) async -> Bool {
        guard let url else { return false }
        return await isValidAudioFile(at: url)
    }

    private func writeTrackManifest(for mixedURL: URL, micURL: URL, systemURL: URL) {
        let manifest = MixedTrackManifest(
            micFileName: micURL.lastPathComponent,
            systemFileName: systemURL.lastPathComponent
        )
        let manifestURL = mixedURL.deletingPathExtension().appendingPathExtension("tracks.json")
        do {
            let data = try JSONEncoder().encode(manifest)
            try data.write(to: manifestURL, options: .atomic)
            print("[MixedAudioRecorder] 轨道清单已写入: \(manifestURL.lastPathComponent)")
        } catch {
            print("[MixedAudioRecorder] 轨道清单写入失败: \(error)")
        }
    }

    private func isValidAudioFile(at url: URL) async -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = attrs?[.size] as? Int64 ?? 0
        guard fileSize >= 2 * 1024 else { return false }

        let asset = AVURLAsset(url: url)
        let duration = (try? await asset.load(.duration)) ?? .zero
        let durationSeconds = CMTimeGetSeconds(duration)
        if durationSeconds.isFinite, durationSeconds > 0 {
            let bytesPerSecond = Double(fileSize) / durationSeconds
            if bytesPerSecond < 2_000 {
                print("[MixedAudioRecorder] 音频文件疑似无效: \(url.lastPathComponent), bps=\(Int(bytesPerSecond))")
                return false
            }
        }

        return true
    }
}
