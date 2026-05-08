import AppKit

/// 调试开关
private let isDebugEnabled = false

/// 复选框附件 - 用于待办列表，仿照 macOS 备忘录样式
final class CheckboxTextAttachment: NSTextAttachment {
    private static let checkedKey = "checkbox_isChecked"

    var isChecked: Bool = false {
        didSet {
            updateImage()
        }
    }

    private let checkboxSize: CGFloat = 14
    private let strokeWidth: CGFloat = 1.2

    override init(data contentData: Data?, ofType uti: String?) {
        super.init(data: contentData, ofType: uti)
        updateImage()
    }

    required init?(coder: NSCoder) {
        self.isChecked = coder.decodeBool(forKey: Self.checkedKey)
        super.init(coder: coder)
        updateImage()
    }

    convenience init(checked: Bool = false) {
        self.init(data: nil, ofType: nil)
        self.isChecked = checked
        updateImage()
    }

    override func encode(with coder: NSCoder) {
        super.encode(with: coder)
        coder.encode(isChecked, forKey: Self.checkedKey)
    }

    func refreshPresentationIfNeeded() {
        updateImage()
    }

    private func updateImage() {
        self.image = createCheckboxImage()
        // 调整 bounds 使复选框垂直居中
        let offset: CGFloat = -2
        self.bounds = NSRect(x: 0, y: offset, width: checkboxSize, height: checkboxSize)
    }

    private func createCheckboxImage() -> NSImage {
        let size = NSSize(width: checkboxSize, height: checkboxSize)
        let image = NSImage(size: size)

        image.lockFocus()

        let rect = NSRect(origin: .zero, size: size)

        if isChecked {
            let fillColor: NSColor = .systemYellow
            let checkColor: NSColor = .white

            // 绘制填充圆
            let circlePath = NSBezierPath(ovalIn: rect)
            fillColor.setFill()
            circlePath.fill()

            // 绘制白色对勾
            let checkPath = NSBezierPath()
            checkPath.lineWidth = 1.5
            checkPath.lineCapStyle = .round
            checkPath.lineJoinStyle = .round

            // 对勾路径点
            let startPoint = NSPoint(x: rect.minX + 4, y: rect.midY)
            let midPoint = NSPoint(x: rect.minX + 6, y: rect.minY + 4)
            let endPoint = NSPoint(x: rect.maxX - 3, y: rect.maxY - 4)

            checkPath.move(to: startPoint)
            checkPath.line(to: midPoint)
            checkPath.line(to: endPoint)

            checkColor.setStroke()
            checkPath.stroke()
        } else {
            let strokeColor = AttachmentAppearance.uncheckedStrokeColor

            let circlePath = NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5))
            circlePath.lineWidth = strokeWidth
            strokeColor.setStroke()
            circlePath.stroke()
        }

        image.unlockFocus()
        return image
    }

    /// 切换选中状态
    func toggle() {
        isChecked.toggle()
    }

    /// 判断普通附件是否“像”一个复选框（用于重启后反序列化恢复交互）
    static func looksLikeCheckbox(_ attachment: NSTextAttachment) -> Bool {
        let bounds = attachment.bounds
        let hasCheckboxSizedBounds = bounds.width >= 10 && bounds.width <= 20 && bounds.height >= 10 && bounds.height <= 20

        var imageSize: NSSize = .zero
        if let image = attachment.image {
            imageSize = image.size
        }else if let contents = attachment.contents, let image = NSImage(data: contents) {
            imageSize = image.size
        }

        let hasCheckboxSizedImage = imageSize.width >= 10 && imageSize.width <= 20 && imageSize.height >= 10 && imageSize.height <= 20

        // 只要 bounds 或 image 任意一个特征命中即可
        return hasCheckboxSizedBounds || hasCheckboxSizedImage
    }

    /// 从附件中推断是否已勾选（用于将普通附件恢复为 CheckboxTextAttachment）
    static func inferCheckedState(from attachment: NSTextAttachment) -> Bool {
        guard let image = attachment.image ?? (attachment.contents.flatMap { NSImage(data: $0) }) else {
            return false
        }
        return detectIfChecked(image)
    }

    /// 根据图像判断是否是“已选中”状态
    private static func detectIfChecked(_ image: NSImage) -> Bool {
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return false
        }

        let width = cgImage.width
        let height = cgImage.height
        guard width > 0 && height > 0 else { return false }

        let centerX = width / 2
        let centerY = height / 2

        let bytesPerPixel = 4
        let bytesPerRow = bytesPerPixel
        var pixel = [UInt8](repeating: 0, count: bytesPerPixel)

        guard let context = CGContext(
            data: &pixel,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return false
        }

        // 将中心像素映射到 1x1 画布
        context.translateBy(x: CGFloat(-centerX), y: CGFloat(centerY - height + 1))
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        let r = CGFloat(pixel[0]) / 255.0
        let g = CGFloat(pixel[1]) / 255.0
        let b = CGFloat(pixel[2]) / 255.0
        let a = CGFloat(pixel[3]) / 255.0

        // 中心透明或几乎白色 => 未选中
        if a < 0.5 { return false }
        let brightness = (r + g + b) / 3.0
        if brightness > 0.9 { return false }

        // 黄色或中低亮度填充 => 已选中
        let isYellow = r > 0.7 && g > 0.6 && b < 0.5
        return isYellow || brightness < 0.75
    }

    // MARK: - RTFD 序列化支持

    /// 保存时确保图像数据被正确序列化
    func prepareForSaving() {
        // 确保图像已生成
        if self.image == nil {
            updateImage()
        }

        // 将图像转换为 PNG 数据并设置到 contents
        // 这样 RTFD 保存时就能包含图像数据
        guard let image = self.image else {
            if isDebugEnabled { print("[CheckboxDebug] prepareForSaving: image is nil") }
            return
        }

        // 方法1: 尝试从 NSImage 的 representations 获取 bitmap
        if let bitmapRep = image.representations.first as? NSBitmapImageRep {
            if let pngData = bitmapRep.representation(using: .png, properties: [:]) {
                self.contents = pngData
                self.fileType = "public.png"
                if isDebugEnabled { print("[CheckboxDebug] prepareForSaving: saved via bitmapRep, size=", pngData.count) }
                return
            }
        }

        // 方法2: 尝试通过 CGImage 转换
        if let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            let rep = NSBitmapImageRep(cgImage: cgImage)
            rep.size = image.size
            if let pngData = rep.representation(using: .png, properties: [:]) {
                self.contents = pngData
                self.fileType = "public.png"
                if isDebugEnabled { print("[CheckboxDebug] prepareForSaving: saved via CGImage, size=", pngData.count) }
                return
            }
        }

        // 方法3: 创建新的 bitmap representation
        let size = image.size
        guard size.width > 0, size.height > 0 else {
            if isDebugEnabled { print("[CheckboxDebug] prepareForSaving: invalid image size") }
            return
        }

        let newImage = NSImage(size: size)
        newImage.lockFocus()
        image.draw(in: NSRect(origin: .zero, size: size))
        newImage.unlockFocus()

        if let bitmapRep = newImage.representations.first as? NSBitmapImageRep,
           let pngData = bitmapRep.representation(using: .png, properties: [:]) {
            self.contents = pngData
            self.fileType = "public.png"
            if isDebugEnabled { print("[CheckboxDebug] prepareForSaving: saved via new bitmap, size=", pngData.count) }
            return
        }

        if isDebugEnabled { print("[CheckboxDebug] prepareForSaving: failed to save image") }
    }
}

// MARK: - NSTextView 扩展

extension NSTextView {
    /// 将当前位置的附件标准化为 CheckboxTextAttachment（必要时从普通附件恢复）
    @discardableResult
    func normalizedCheckboxAttachment(at location: Int, effectiveRange: inout NSRange) -> CheckboxTextAttachment? {
        let attr = self.attributedString()
        guard location >= 0 && location < attr.length else { return nil }

        guard let rawAttachment = attr.attribute(.attachment, at: location, effectiveRange: &effectiveRange) as? NSTextAttachment else {
            return nil
        }

        if let checkbox = rawAttachment as? CheckboxTextAttachment {
            return checkbox
        }

        guard CheckboxTextAttachment.looksLikeCheckbox(rawAttachment) else {
            return nil
        }

        let recovered = CheckboxTextAttachment(checked: CheckboxTextAttachment.inferCheckedState(from: rawAttachment))
        // 就地写回，后续交互直接走强类型附件
        self.textStorage?.addAttribute(.attachment, value: recovered, range: effectiveRange)
        return recovered
    }

    /// 在当前行切换复选框（有则删除，无则添加）
    func toggleCheckboxForCurrentLine() {
        let nsString = self.string as NSString
        let selectedRange = self.selectedRange()
        let currentLineRange = nsString.lineRange(for: selectedRange)
        let insertionLocation = leadingWhitespaceBoundary(in: currentLineRange)

        // 检查行首是否已有复选框
        if let checkboxRange = findCheckboxAtLineStart(lineRange: currentLineRange) {
            // 删除复选框和后面的空格
            var deleteRange = checkboxRange
            // 如果有空格也一起删除
            if checkboxRange.upperBound < currentLineRange.upperBound {
                let nextCharRange = NSRange(location: checkboxRange.upperBound, length: 1)
                if nextCharRange.upperBound <= nsString.length {
                    let nextChar = nsString.substring(with: nextCharRange)
                    if nextChar == " " {
                        deleteRange.length += 1
                    }
                }
            }

            self.textStorage?.deleteCharacters(in: deleteRange)
            self.didChangeText()

            // 调整光标位置
            let newLocation = selectedRange.location - deleteRange.length
            self.setSelectedRange(NSRange(location: max(currentLineRange.location, newLocation), length: 0))
        } else {
            let attachment = CheckboxTextAttachment(checked: false)
            let attrString = NSAttributedString(attachment: attachment)
            let mutableAttr = NSMutableAttributedString(attributedString: attrString)
            mutableAttr.append(NSAttributedString(string: " "))

            self.textStorage?.insert(mutableAttr, at: insertionLocation)
            self.didChangeText()

            // 调整光标位置
            let newLocation = selectedRange.location + mutableAttr.length
            self.setSelectedRange(NSRange(location: newLocation, length: 0))
        }
    }

    /// 查找行首的复选框（支持重启后从普通 NSTextAttachment 自动恢复）
    private func findCheckboxAtLineStart(lineRange: NSRange) -> NSRange? {
        let attr = self.attributedString()
        let checkboxLocation = leadingWhitespaceBoundary(in: lineRange)

        if checkboxLocation >= attr.length { return nil }

        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        if let checkbox = normalizedCheckboxAttachment(at: checkboxLocation, effectiveRange: &effectiveRange) {
            self.textStorage?.addAttribute(.attachment, value: checkbox, range: effectiveRange)
            return effectiveRange
        }

        return nil
    }

    /// 检查指定位置是否在复选框行
    func isCheckboxLine(at location: Int) -> Bool {
        let nsString = self.string as NSString
        let lineRange = nsString.lineRange(for: NSRange(location: location, length: 0))

        if lineRange.location >= self.attributedString().length { return false }

        return findCheckboxAtLineStart(lineRange: lineRange) != nil
    }

    private func leadingWhitespaceBoundary(in lineRange: NSRange) -> Int {
        let nsString = self.string as NSString
        let end = NSMaxRange(lineRange)
        var location = lineRange.location

        while location < end {
            let scalar = nsString.character(at: location)
            if scalar == 32 || scalar == 9 {
                location += 1
                continue
            }
            break
        }

        return location
    }

    /// 在当前位置插入复选框
    func insertCheckbox(checked: Bool = false) {
        let attachment = CheckboxTextAttachment(checked: checked)
        let attrString = NSAttributedString(attachment: attachment)

        // 插入复选框和一个空格
        let mutableAttr = NSMutableAttributedString(attributedString: attrString)
        mutableAttr.append(NSAttributedString(string: " "))

        self.insertText(mutableAttr, replacementRange: self.selectedRange())
        self.didChangeText()
    }

    /// 切换指定位置的复选框状态
    func toggleCheckbox(at location: Int) -> Bool {
        guard location < self.attributedString().length else { return false }

        var effectiveRange = NSRange(location: NSNotFound, length: 0)

        if let attachment = normalizedCheckboxAttachment(at: location, effectiveRange: &effectiveRange) {
            attachment.toggle()

            // 更新文本存储以触发重绘
            self.textStorage?.beginEditing()
            self.textStorage?.setAttributes([.attachment: attachment], range: effectiveRange)
            self.textStorage?.endEditing()

            self.didChangeText()
            return true
        }

        return false
    }

    /// 查找并返回所有复选框的位置
    func findAllCheckboxes() -> [(location: Int, attachment: CheckboxTextAttachment)] {
        var checkboxes: [(Int, CheckboxTextAttachment)] = []
        let attr = self.attributedString()
        let range = NSRange(location: 0, length: attr.length)

        attr.enumerateAttribute(.attachment, in: range, options: []) { value, attrRange, _ in
            guard let rawAttachment = value as? NSTextAttachment else { return }

            if let checkbox = rawAttachment as? CheckboxTextAttachment {
                checkboxes.append((attrRange.location, checkbox))
                return
            }

            if CheckboxTextAttachment.looksLikeCheckbox(rawAttachment) {
                let isChecked = CheckboxTextAttachment.inferCheckedState(from: rawAttachment)
                let recovered = CheckboxTextAttachment(checked: isChecked)
                checkboxes.append((attrRange.location, recovered))
            }
        }

        return checkboxes
    }

    /// 获取当前行的范围
    func currentLineRange() -> NSRange {
        let nsString = self.string as NSString
        return nsString.lineRange(for: self.selectedRange())
    }

    // MARK: - 复选框排序

    /// 排序复选框：未完成的在前，已完成的在后
    /// 注意：只排序连续的复选框区域，不影响其他内容，保留原始空行
    func sortCheckboxes() {
        // 先保存当前选中的位置
        let originalSelectedRange = self.selectedRange()
        let originalString = self.string as NSString

        // 收集所有复选框行（包括非复选框行作为分隔）
        var allLines: [(lineRange: NSRange, isCheckbox: Bool, isChecked: Bool, content: String, originalText: NSAttributedString, trailingNewlines: Int)] = []
        var currentLocation = 0

        while currentLocation < originalString.length {
            let lineRange = originalString.lineRange(for: NSRange(location: currentLocation, length: 0))

            // 检查是否是复选框行
            if let checkboxInfo = getCheckboxInfo(at: lineRange.location) {
                let contentLength = lineRange.upperBound - checkboxInfo.checkboxEnd
                guard contentLength >= 0 else {
                    // 如果 checkboxEnd 超出 lineRange，使用空内容
                    allLines.append((
                        lineRange: lineRange,
                        isCheckbox: true,
                        isChecked: checkboxInfo.isChecked,
                        content: "",
                        originalText: NSAttributedString(),
                        trailingNewlines: 1
                    ))
                    currentLocation = lineRange.upperBound
                    continue
                }
                let contentRange = NSRange(location: checkboxInfo.checkboxEnd, length: contentLength)
                let content = originalString.substring(with: contentRange).trimmingCharacters(in: .whitespacesAndNewlines)
                // 保留复选框后的原始富文本（用于重建时保持格式）
                let originalText = self.attributedString().attributedSubstring(from: contentRange)
                // 计算行尾换行符数量
                let trailingNewlines = countTrailingNewlines(in: originalText.string)

                allLines.append((
                    lineRange: lineRange,
                    isCheckbox: true,
                    isChecked: checkboxInfo.isChecked,
                    content: content,
                    originalText: originalText,
                    trailingNewlines: trailingNewlines
                ))
            } else {
                // 非复选框行 - 保留完整的原始富文本
                let originalText = self.attributedString().attributedSubstring(from: lineRange)
                allLines.append((
                    lineRange: lineRange,
                    isCheckbox: false,
                    isChecked: false,
                    content: "",
                    originalText: originalText,
                    trailingNewlines: 0
                ))
            }

            currentLocation = lineRange.upperBound
        }

        // 找到需要排序的复选框区域（连续的复选框行）
        var regions: [(startIndex: Int, endIndex: Int, lines: [(isChecked: Bool, content: String, originalText: NSAttributedString, trailingNewlines: Int)])] = []
        var currentRegionStart: Int?
        var currentRegionLines: [(isChecked: Bool, content: String, originalText: NSAttributedString, trailingNewlines: Int)] = []

        for (index, line) in allLines.enumerated() {
            if line.isCheckbox {
                if currentRegionStart == nil {
                    currentRegionStart = index
                }
                currentRegionLines.append((line.isChecked, line.content, line.originalText, line.trailingNewlines))
            } else {
                // 遇到非复选框行，结束当前区域
                if let start = currentRegionStart, currentRegionLines.count > 1 {
                    regions.append((start, index - 1, currentRegionLines))
                }
                currentRegionStart = nil
                currentRegionLines = []
            }
        }

        // 处理最后一个区域
        if let start = currentRegionStart, currentRegionLines.count > 1 {
            regions.append((start, allLines.count - 1, currentRegionLines))
        }

        // 如果没有需要排序的区域，直接返回
        guard !regions.isEmpty else { return }

        // 对每个区域进行排序
        for region in regions.reversed() { // 从后往前处理，避免索引变化
            sortRegion(allLines: allLines, region: region, originalString: originalString)
        }

        // 尝试恢复光标位置（大致位置）
        let newLength = self.string.count
        let newLocation = min(originalSelectedRange.location, newLength)
        self.setSelectedRange(NSRange(location: newLocation, length: 0))
    }

    /// 计算字符串末尾换行符数量
    private func countTrailingNewlines(in string: String) -> Int {
        var count = 0
        for char in string.reversed() {
            if char == "\n" || char == "\r" {
                count += 1
            } else {
                break
            }
        }
        return max(count, 1) // 至少保留一个换行符
    }

    /// 排序单个区域内的复选框
    private func sortRegion(allLines: [(lineRange: NSRange, isCheckbox: Bool, isChecked: Bool, content: String, originalText: NSAttributedString, trailingNewlines: Int)], region: (startIndex: Int, endIndex: Int, lines: [(isChecked: Bool, content: String, originalText: NSAttributedString, trailingNewlines: Int)]), originalString: NSString) {
        let uncheckedLines = region.lines.filter { !$0.isChecked }
        let checkedLines = region.lines.filter { $0.isChecked }

        // 如果全部完成或全部未完成，不需要排序
        guard !uncheckedLines.isEmpty && !checkedLines.isEmpty else { return }

        // 构建新的富文本
        let newAttributedText = buildSortedCheckboxAttributedText(uncheckedLines: uncheckedLines, checkedLines: checkedLines)

        // 计算替换范围
        let firstLine = allLines[region.startIndex]
        let lastLine = allLines[region.endIndex]
        let replaceRange = NSRange(location: firstLine.lineRange.location, length: lastLine.lineRange.upperBound - firstLine.lineRange.location)

        // 验证范围
        guard replaceRange.location >= 0 && replaceRange.upperBound <= originalString.length else {
            print("[CheckboxTextAttachment] Invalid range for sorting")
            return
        }

        // 禁用撤销跟踪，避免 UndoManager 问题
        let undoManager = self.undoManager
        undoManager?.disableUndoRegistration()

        // 替换内容
        self.textStorage?.beginEditing()
        self.textStorage?.replaceCharacters(in: replaceRange, with: newAttributedText)
        self.textStorage?.endEditing()

        // 恢复撤销跟踪并清除撤销栈
        // 先清除操作再恢复注册，避免 didChangeText 触发内部 undo 时残留指向旧状态的 target
        undoManager?.removeAllActions()
        undoManager?.enableUndoRegistration()

        self.didChangeText()
    }

    /// 获取复选框信息
    private func getCheckboxInfo(at location: Int) -> (isChecked: Bool, checkboxEnd: Int)? {
        guard location < self.attributedString().length else { return nil }

        var effectiveRange = NSRange(location: NSNotFound, length: 0)
        if let attachment = normalizedCheckboxAttachment(at: location, effectiveRange: &effectiveRange) {
            let checkboxEnd = effectiveRange.upperBound
            // 跳过后面的空格
            let nextLocation = checkboxEnd
            if nextLocation < self.string.count {
                let nsString = self.string as NSString
                let nextCharRange = NSRange(location: nextLocation, length: 1)
                if nextCharRange.upperBound <= nsString.length {
                    let nextChar = nsString.substring(with: nextCharRange)
                    if nextChar == " " {
                        return (attachment.isChecked, nextLocation + 1)
                    }
                }
            }
            return (attachment.isChecked, checkboxEnd)
        }

        return nil
    }

    /// 构建排序后的复选框富文本
    private func buildSortedCheckboxAttributedText(uncheckedLines: [(isChecked: Bool, content: String, originalText: NSAttributedString, trailingNewlines: Int)], checkedLines: [(isChecked: Bool, content: String, originalText: NSAttributedString, trailingNewlines: Int)]) -> NSAttributedString {
        let result = NSMutableAttributedString()

        // 辅助函数：清理文本（移除开头空格，保留原始换行符数量信息）
        func cleanText(_ attrString: NSAttributedString, keepNewlines: Bool = false) -> NSAttributedString {
            let mutable = NSMutableAttributedString(attributedString: attrString)
            // 移除开头的空格
            if mutable.string.hasPrefix(" ") {
                mutable.deleteCharacters(in: NSRange(location: 0, length: 1))
            }
            // 如果不保留换行符，则移除结尾的换行符
            if !keepNewlines {
                while mutable.string.hasSuffix("\n") || mutable.string.hasSuffix("\r") {
                    let length = mutable.string.hasSuffix("\r\n") ? 2 : 1
                    mutable.deleteCharacters(in: NSRange(location: mutable.length - length, length: length))
                }
            }
            return mutable
        }

        // 添加未完成的行
        for (_, line) in uncheckedLines.enumerated() {
            let attachment = CheckboxTextAttachment(checked: false)
            let attrString = NSAttributedString(attachment: attachment)
            result.append(attrString)
            // 保留原始富文本格式
            if line.originalText.length > 0 {
                let cleanedText = cleanText(line.originalText)
                result.append(NSAttributedString(string: " "))
                result.append(cleanedText)
            } else {
                result.append(NSAttributedString(string: " \(line.content)"))
            }
            // 添加原始数量的换行符（保留空行）
            let newlineCount = line.trailingNewlines
            let newlines = String(repeating: "\n", count: newlineCount)
            result.append(NSAttributedString(string: newlines))
        }

        // 添加已完成的行
        for (_, line) in checkedLines.enumerated() {
            let attachment = CheckboxTextAttachment(checked: true)
            let attrString = NSAttributedString(attachment: attachment)
            result.append(attrString)
            // 保留原始富文本格式
            if line.originalText.length > 0 {
                let cleanedText = cleanText(line.originalText)
                result.append(NSAttributedString(string: " "))
                result.append(cleanedText)
            } else {
                result.append(NSAttributedString(string: " \(line.content)"))
            }
            // 添加原始数量的换行符（保留空行）
            let newlineCount = line.trailingNewlines
            let newlines = String(repeating: "\n", count: newlineCount)
            result.append(NSAttributedString(string: newlines))
        }

        return result
    }
}
