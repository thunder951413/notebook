import SwiftUI
import AppKit
import WebKit

// MARK: - Markdown 渲染视图

final class NonScrollingWKWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        if let nextResponder {
            nextResponder.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
    }
}

struct MarkdownWebView: NSViewRepresentable {
    let markdown: String
    let attributedContent: NSAttributedString?
    let colorScheme: ColorScheme
    @Binding var height: CGFloat
    let noteID: UUID
    var renderAttributedContent: Bool = true
    var readingPosition: NoteReadingPosition? = nil
    var onReadingPositionChange: ((UUID, Int, Double) -> Void)? = nil

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "readingPosition")
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: """
                    (function() {
                        var notebookReadingPositionTimer = null;
                        window.addEventListener('scroll', function() {
                            clearTimeout(notebookReadingPositionTimer);
                            notebookReadingPositionTimer = setTimeout(function() {
                                var maxOffset = Math.max((document.body.scrollHeight || 0) - (window.innerHeight || 0), 0);
                                var progress = maxOffset > 0 ? Math.max(0, Math.min(1, (window.scrollY || window.pageYOffset || 0) / maxOffset)) : 0;
                                window.webkit.messageHandlers.readingPosition.postMessage(progress);
                            }, 450);
                        }, true);
                    })();
                """,
                injectionTime: .atDocumentEnd,
                forMainFrameOnly: true
            )
        )
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = context.coordinator

        // 监听滚动到标题的通知
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.scrollToHeading(_:)),
            name: .scrollToHeading,
            object: nil
        )

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        let html = MarkdownHTMLRenderer(
            markdown: markdown,
            attributedContent: attributedContent,
            colorScheme: colorScheme,
            noteID: noteID,
            renderAttributedContent: renderAttributedContent
        ).generateHTML()

        // 避免重复加载同一份 HTML，减少闪烁
        if context.coordinator.lastLoadedHTML == html {
            return
        }

        if context.coordinator.lastLoadedHTML != nil {
            context.coordinator.captureRelativeScrollProgress(from: webView)
        }

        // 调试：打印生成的 HTML 内容
        if markdown.contains("```mermaid") {
            DebugLog.editor("Generated HTML preview:", level: .debug)
            DebugLog.editor(String(html.prefix(2000)), level: .debug)
        }

        context.coordinator.reloadWorkItem?.cancel()
        let isFirstLoad = context.coordinator.lastLoadedHTML == nil
        let workItem = DispatchWorkItem {
            webView.loadHTMLString(html, baseURL: nil)
            context.coordinator.lastLoadedHTML = html
        }
        context.coordinator.reloadWorkItem = workItem

        if isFirstLoad {
            workItem.perform()
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: workItem)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        coordinator.flushReadingPosition()
        nsView.configuration.userContentController.removeScriptMessageHandler(forName: "readingPosition")
    }

    func generateHTML(
        from markdown: String,
        attributed: NSAttributedString?,
        colorScheme: ColorScheme,
        renderAttributedContent: Bool? = nil
    ) -> String {
        MarkdownHTMLRenderer(
            markdown: markdown,
            attributedContent: attributed,
            colorScheme: colorScheme,
            noteID: noteID,
            renderAttributedContent: renderAttributedContent ?? self.renderAttributedContent
        ).generateHTML()
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: MarkdownWebView
        var webView: WKWebView?
        var lastLoadedHTML: String?
        var reloadWorkItem: DispatchWorkItem?
        var navigationState = MarkdownPreviewNavigationState()
        private var didRestoreInitialReadingPosition = false
        private var isRestoringReadingPosition = false
        private var suppressReadingPositionUntil = Date.distantPast

        init(_ parent: MarkdownWebView) {
            self.parent = parent
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            self.webView = webView
            // 获取内容高度
            webView.evaluateJavaScript("document.body.scrollHeight") { [weak self] result, error in
                if let height = result as? CGFloat {
                    DispatchQueue.main.async {
                        self?.parent.height = height + 20 // 添加一些边距
                    }
                }
            }
            applyPendingNavigationIfNeeded()
            applyInitialReadingPositionIfNeeded()
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            let scheme = url.scheme?.lowercased() ?? ""
            let allowedSchemes: Set<String> = ["http", "https", "mailto"]
            if allowedSchemes.contains(scheme) {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        @objc func scrollToHeading(_ notification: Notification) {
            // 检查通知是否针对当前 noteID
            guard let notificationNoteID = notification.object as? UUID,
                  notificationNoteID == parent.noteID else {
                return
            }

            guard let userInfo = notification.userInfo,
                  let anchor = userInfo["anchor"] as? String else { return }

            DebugLog.editor("Received for noteID: \(parent.noteID), anchor: \(anchor)", level: .debug)
            navigationState.queueAnchor(anchor)
            applyPendingNavigationIfNeeded()
        }

        func captureRelativeScrollProgress(from webView: WKWebView) {
            let script = """
                (function() {
                    return {
                        offset: window.scrollY || window.pageYOffset || 0,
                        contentHeight: document.body.scrollHeight || 0,
                        viewportHeight: window.innerHeight || 0
                    };
                })();
            """

            webView.evaluateJavaScript(script) { [weak self] result, _ in
                guard let self,
                      let payload = result as? [String: Any],
                      let offset = payload["offset"] as? Double,
                      let contentHeight = payload["contentHeight"] as? Double,
                      let viewportHeight = payload["viewportHeight"] as? Double else {
                    return
                }
                self.navigationState.captureRelativeProgress(
                    offset: offset,
                    contentHeight: contentHeight,
                    viewportHeight: viewportHeight
                )
            }
        }

        func flushReadingPosition() {
            guard !isRestoringReadingPosition,
                  let webView,
                  let handler = parent.onReadingPositionChange else { return }
            let sourceLength = (parent.markdown as NSString).length
            let script = """
                (function() {
                    var maxOffset = Math.max((document.body.scrollHeight || 0) - (window.innerHeight || 0), 0);
                    if (maxOffset <= 0) return 0;
                    return Math.max(0, Math.min(1, (window.scrollY || window.pageYOffset || 0) / maxOffset));
                })();
            """
            webView.evaluateJavaScript(script) { [noteID = parent.noteID] result, _ in
                guard let progress = result as? Double else { return }
                let offset = Int((Double(sourceLength) * progress).rounded())
                DispatchQueue.main.async { handler(noteID, offset, 0) }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "readingPosition",
                  !isRestoringReadingPosition,
                  Date() >= suppressReadingPositionUntil,
                  let progress = (message.body as? NSNumber)?.doubleValue,
                  let handler = parent.onReadingPositionChange else { return }
            let sourceLength = (parent.markdown as NSString).length
            let offset = Int((Double(sourceLength) * min(max(progress, 0), 1)).rounded())
            handler(parent.noteID, offset, 0)
        }

        private func applyInitialReadingPositionIfNeeded() {
            guard !didRestoreInitialReadingPosition,
                  let position = parent.readingPosition,
                  position.noteID == parent.noteID,
                  let webView else { return }
            didRestoreInitialReadingPosition = true
            let sourceLength = max((parent.markdown as NSString).length, 1)
            let progress = min(max(Double(position.anchorUTF16Offset) / Double(sourceLength), 0), 1)
            isRestoringReadingPosition = true
            suppressReadingPositionUntil = Date().addingTimeInterval(1)
            let script = """
                (function() {
                    var maxOffset = Math.max((document.body.scrollHeight || 0) - (window.innerHeight || 0), 0);
                    window.scrollTo({ top: maxOffset * \(progress), behavior: 'auto' });
                })();
            """
            webView.evaluateJavaScript(script) { [weak self] _, _ in
                self?.isRestoringReadingPosition = false
            }
        }

        private func applyPendingNavigationIfNeeded() {
            guard let webView,
                  let command = navigationState.consumePostLoadCommand() else { return }

            let script: String
            switch command {
            case .anchor(let anchor):
                script = """
                    (function() {
                        var element = document.getElementById('\(anchor)');
                        if (element) {
                            var elementTop = element.offsetTop;
                            window.scrollTo({
                                top: elementTop - 20,
                                behavior: 'smooth'
                            });
                            return 'scrolled to \(anchor) at ' + elementTop;
                        }
                        return 'element not found: \(anchor)';
                    })();
                """
            case .relativeProgress(let progress):
                script = """
                    (function() {
                        var maxOffset = Math.max((document.body.scrollHeight || 0) - (window.innerHeight || 0), 0);
                        var progress = Math.max(0, Math.min(1, \(progress)));
                        window.scrollTo({
                            top: maxOffset * progress,
                            behavior: 'auto'
                        });
                        return 'restored progress ' + progress;
                    })();
                """
            }

            DispatchQueue.main.async {
                webView.evaluateJavaScript(script) { result, error in
                    if let error = error {
                        DebugLog.editor("Error: \(error)", level: .warn)
                    } else if let result = result {
                        DebugLog.editor("Result: \(result)", level: .debug)
                    }
                }
            }
        }

        deinit {
            reloadWorkItem?.cancel()
            NotificationCenter.default.removeObserver(self)
        }
    }
}

enum MarkdownPreviewNavigationCommand: Equatable {
    case anchor(String)
    case relativeProgress(Double)
}

struct MarkdownPreviewNavigationState {
    private var pendingAnchor: String?
    private var pendingRelativeProgress: Double?

    mutating func queueAnchor(_ anchor: String) {
        pendingAnchor = anchor
    }

    mutating func captureRelativeProgress(offset: Double, contentHeight: Double, viewportHeight: Double) {
        let maxOffset = max(contentHeight - viewportHeight, 0)
        guard maxOffset > 0 else {
            pendingRelativeProgress = nil
            return
        }

        let clampedOffset = min(max(offset, 0), maxOffset)
        pendingRelativeProgress = clampedOffset / maxOffset
    }

    mutating func consumePostLoadCommand() -> MarkdownPreviewNavigationCommand? {
        if let pendingAnchor {
            self.pendingAnchor = nil
            return .anchor(pendingAnchor)
        }

        if let pendingRelativeProgress {
            self.pendingRelativeProgress = nil
            return .relativeProgress(pendingRelativeProgress)
        }

        return nil
    }
}
