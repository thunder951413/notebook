import SwiftUI
import WebKit
import AppKit

enum MarkdownEditingMode: String, CaseIterable {
    case wysiwyg
    case source

    var label: String {
        switch self {
        case .wysiwyg: return "所见即所得"
        case .source: return "源码"
        }
    }
}

@MainActor
enum MarkdownEditorPreferenceStore {
    private static let prefix = "markdownEditor.mode."

    static func mode(noteID: UUID, contentLength: Int) -> MarkdownEditingMode {
        if let raw = UserDefaults.standard.string(forKey: prefix + noteID.uuidString),
           let mode = MarkdownEditingMode(rawValue: raw) {
            return mode
        }
        return contentLength >= 250_000 ? .source : .wysiwyg
    }

    static func setMode(_ mode: MarkdownEditingMode, noteID: UUID) {
        UserDefaults.standard.set(mode.rawValue, forKey: prefix + noteID.uuidString)
    }
}

struct MuyaMarkdownEditorView: NSViewRepresentable {
    @Binding var attributedText: NSAttributedString
    @Binding var editingMode: MarkdownEditingMode
    let noteID: UUID
    var readingPosition: NoteReadingPosition?
    var onReadingPositionChange: ((UUID, Int, Double) -> Void)?
    var onExplicitSave: (() -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        for name in Coordinator.messageNames {
            configuration.userContentController.add(context.coordinator, name: name)
        }

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = context.coordinator
        webView.allowsMagnification = true
        context.coordinator.webView = webView

        guard let editorBundleURL = Bundle.main.url(
            forResource: "MarkdownEditor",
            withExtension: "bundle"
        ), let editorBundle = Bundle(url: editorBundleURL),
              let indexURL = editorBundle.url(forResource: "index", withExtension: "html"),
              let resourceURL = editorBundle.resourceURL else {
            context.coordinator.reportLoadFailure("离线 Markdown 编辑器资源缺失")
            return webView
        }
        webView.loadFileURL(indexURL, allowingReadAccessTo: resourceURL)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.pushContentIfNeeded()
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        coordinator.flushPosition()
        for name in Coordinator.messageNames {
            nsView.configuration.userContentController.removeScriptMessageHandler(forName: name)
        }
        nsView.navigationDelegate = nil
        nsView.stopLoading()
        coordinator.webView = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        static let messageNames = [
            "editorReady", "editorChange", "editorPatch", "editorPosition",
            "editorMode", "editorSave", "openLink"
        ]

        var parent: MuyaMarkdownEditorView
        weak var webView: WKWebView?
        private var isReady = false
        private var lastPushedMarkdown: String?
        private var lastReceivedMarkdown: String?
        private var lastPushedMode: MarkdownEditingMode?
        private var pendingPosition: (anchor: Int, fraction: Double)?

        init(_ parent: MuyaMarkdownEditorView) {
            self.parent = parent
        }

        func pushContentIfNeeded() {
            guard isReady, let webView else { return }
            let markdown = parent.attributedText.string
            if markdown == lastPushedMarkdown || markdown == lastReceivedMarkdown {
                guard lastPushedMode != parent.editingMode else { return }
                lastPushedMode = parent.editingMode
                setMode(parent.editingMode)
                return
            }
            lastPushedMarkdown = markdown
            lastPushedMode = parent.editingMode
            let position: [String: Any] = [
                "anchor": parent.readingPosition?.anchorUTF16Offset ?? 0,
                "fraction": parent.readingPosition?.viewportOffsetFraction ?? 0,
            ]
            webView.callAsyncJavaScript(
                "window.notebookEditor.setContent(markdown, mode, position)",
                arguments: [
                    "markdown": markdown,
                    "mode": parent.editingMode.rawValue,
                    "position": position,
                ],
                in: nil,
                in: .page
            ) { result in
                if case .failure(let error) = result {
                    Logger.shared.log(.app, .error, "Markdown editor content load failed: \(error.localizedDescription)")
                }
            }
        }

        func setMode(_ mode: MarkdownEditingMode) {
            guard isReady, let webView else { return }
            webView.callAsyncJavaScript(
                "window.notebookEditor.setMode(mode, true)",
                arguments: ["mode": mode.rawValue],
                in: nil,
                in: .page
            ) { _ in }
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            switch message.name {
            case "editorReady":
                isReady = true
                pushContentIfNeeded()
            case "editorChange":
                guard let markdown = message.body as? String else { return }
                lastReceivedMarkdown = markdown
                lastPushedMarkdown = markdown
                if parent.attributedText.string != markdown {
                    parent.attributedText = NSAttributedString(string: markdown)
                }
            case "editorPatch":
                applySourcePatches(message.body)
            case "editorPosition":
                guard let payload = message.body as? [String: Any] else { return }
                let anchor = (payload["anchor"] as? NSNumber)?.intValue ?? 0
                let fraction = (payload["fraction"] as? NSNumber)?.doubleValue ?? 0
                pendingPosition = (anchor, fraction)
                flushPosition()
            case "editorMode":
                guard let raw = message.body as? String,
                      let mode = MarkdownEditingMode(rawValue: raw),
                      mode != parent.editingMode else { return }
                parent.editingMode = mode
                lastPushedMode = mode
                MarkdownEditorPreferenceStore.setMode(mode, noteID: parent.noteID)
            case "editorSave":
                if let markdown = message.body as? String,
                   parent.attributedText.string != markdown {
                    lastReceivedMarkdown = markdown
                    lastPushedMarkdown = markdown
                    parent.attributedText = NSAttributedString(string: markdown)
                }
                parent.onExplicitSave?()
            case "openLink":
                guard let href = message.body as? String,
                      let url = URL(string: href),
                      url.scheme == "https" || url.scheme == "http" else { return }
                NSWorkspace.shared.open(url)
            default:
                break
            }
        }

        private func applySourcePatches(_ body: Any) {
            guard let payloads = body as? [[String: Any]], !payloads.isEmpty else { return }
            let mutable = NSMutableString(string: parent.attributedText.string)
            var patches: [(from: Int, to: Int, text: String)] = []
            patches.reserveCapacity(payloads.count)

            for payload in payloads {
                guard let from = (payload["from"] as? NSNumber)?.intValue,
                      let to = (payload["to"] as? NSNumber)?.intValue,
                      let text = payload["text"] as? String,
                      from >= 0, to >= from, to <= mutable.length,
                      text.utf16.count <= 1_000_000 else {
                    Logger.shared.log(.save, .error, "Rejected invalid Markdown editor patch")
                    return
                }
                patches.append((from, to, text))
            }

            for patch in patches.sorted(by: { $0.from > $1.from }) {
                mutable.replaceCharacters(
                    in: NSRange(location: patch.from, length: patch.to - patch.from),
                    with: patch.text
                )
            }
            let updated = mutable as String
            lastReceivedMarkdown = updated
            lastPushedMarkdown = updated
            if parent.attributedText.string != updated {
                parent.attributedText = NSAttributedString(string: updated)
            }
        }

        func flushPosition() {
            guard let pendingPosition else { return }
            parent.onReadingPositionChange?(
                parent.noteID,
                pendingPosition.anchor,
                pendingPosition.fraction
            )
            self.pendingPosition = nil
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.isFileURL || url.scheme == "about" {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            reportLoadFailure(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            reportLoadFailure(error.localizedDescription)
        }

        func reportLoadFailure(_ message: String) {
            Logger.shared.log(.app, .error, "Markdown editor unavailable: \(message)")
        }
    }
}
