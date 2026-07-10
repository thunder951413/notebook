#!/usr/bin/env bash
#
# build-local.sh — 本地编译 Notebook 应用并把 .app 放到 output/ 目录
#
# 用法：
#   ./scripts/build-local.sh              # Release 构建，输出到 output/
#   ./scripts/build-local.sh release      # Release 构建（默认）
#   ./scripts/build-local.sh debug        # Debug 构建
#   ./scripts/build-local.sh clean        # 清理后 Release 构建
#   ./scripts/build-local.sh clean debug  # 清理后 Debug 构建
#
# 输出：
#   output/Notebook.app                   # 编译产物
#   output/Notebook.app.dSYM.zip          # 调试符号（Release 时附带）
#   output/build.log                      # 本次构建日志
#
# 前置条件：
#   - 已安装 Xcode（脚本会自动选择 /Applications/Xcode.app）

set -euo pipefail

# ──────────────────────────────────────────────
# 配置
# ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_NAME="Notebook"
SCHEME="Notebook"
OUTPUT_DIR="$PROJECT_DIR/output"
DERIVED_DATA_DIR="$PROJECT_DIR/build/DerivedData"

CONFIGURATION="Release"
SHOULD_CLEAN=false

# ──────────────────────────────────────────────
# 参数解析
# ──────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        release|Release)
            CONFIGURATION="Release"
            shift
            ;;
        debug|Debug)
            CONFIGURATION="Debug"
            shift
            ;;
        clean)
            SHOULD_CLEAN=true
            shift
            ;;
        -h|--help)
            cat <<EOF
用法：
  ./scripts/build-local.sh              # Release 构建，输出到 output/
  ./scripts/build-local.sh release      # Release 构建（默认）
  ./scripts/build-local.sh debug        # Debug 构建
  ./scripts/build-local.sh clean        # 清理后 Release 构建
  ./scripts/build-local.sh clean debug  # 清理后 Debug 构建

输出目录：$OUTPUT_DIR/
EOF
            exit 0
            ;;
        *)
            echo "未知参数: $1（使用 --help 查看用法）"
            exit 1
            ;;
    esac
done

# ──────────────────────────────────────────────
# 定位 Xcode
# ──────────────────────────────────────────────
XCODE_APP="/Applications/Xcode.app"
if [[ ! -d "$XCODE_APP" ]]; then
    echo "❌ 未找到 Xcode.app，请从 App Store 安装 Xcode"
    exit 1
fi

XCODE_DEVELOPER_DIR="$XCODE_APP/Contents/Developer"
export DEVELOPER_DIR="$XCODE_DEVELOPER_DIR"
XCODEBUILD="$XCODE_DEVELOPER_DIR/usr/bin/xcodebuild"

echo "▸ 使用 Xcode: $XCODE_APP"
echo "▸ 配置: $CONFIGURATION"
echo "▸ 项目目录: $PROJECT_DIR"
echo "▸ 输出目录: $OUTPUT_DIR"
echo ""

# ──────────────────────────────────────────────
# 清理
# ──────────────────────────────────────────────
if [[ "$SHOULD_CLEAN" == true ]]; then
    echo "▸ 清理构建产物..."
    "$XCODEBUILD" clean \
        -project "$PROJECT_DIR/$PROJECT_NAME.xcodeproj" \
        -scheme "$SCHEME" -quiet
    rm -rf "$DERIVED_DATA_DIR" "$OUTPUT_DIR"
    echo "  ✓ 已清理 DerivedData 和 output/"
    echo ""
fi

# 清理项目根 build/ 下的旧残留（避免 "Stale file outside allowed root paths" 警告）
LEGACY_BUILD="$PROJECT_DIR/build"
if [[ -d "$LEGACY_BUILD" ]]; then
    find "$LEGACY_BUILD" -maxdepth 1 \
        \( -name "*.swiftmodule" -o -name "*.swiftsourceinfo" -o -name "*.abi.json" -o -name "*.swiftdoc" \) \
        -print -delete >/dev/null 2>&1 || true
fi

# ──────────────────────────────────────────────
# 准备输出目录
# ──────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"

# 清掉旧的 .app（避免残留旧产物混入）
rm -rf "$OUTPUT_DIR/$PROJECT_NAME.app"

# ──────────────────────────────────────────────
# 编译
# ──────────────────────────────────────────────
echo "▸ 开始编译 ($CONFIGURATION)..."

BUILD_ARGS=(
    -project "$PROJECT_DIR/$PROJECT_NAME.xcodeproj"
    -scheme "$SCHEME"
    -configuration "$CONFIGURATION"
    -destination "generic/platform=macOS"
    -derivedDataPath "$DERIVED_DATA_DIR"
    CONFIGURATION_BUILD_DIR="$OUTPUT_DIR"
)

# 临时关闭 pipefail，避免 tee 管道干扰 xcodebuild 退出码判断
set +o pipefail
"$XCODEBUILD" "${BUILD_ARGS[@]}" build 2>&1 | tee "$OUTPUT_DIR/build.log"
BUILD_STATUS=${PIPESTATUS[0]}
set -o pipefail

if [[ "$BUILD_STATUS" -ne 0 ]]; then
    echo ""
    echo "❌ 编译失败，完整日志: $OUTPUT_DIR/build.log"
    echo ""
    echo "── 最后 30 行输出 ──"
    tail -30 "$OUTPUT_DIR/build.log"
    exit 1
fi

# ──────────────────────────────────────────────
# 验证产物
# ──────────────────────────────────────────────
APP_PATH="$OUTPUT_DIR/$PROJECT_NAME.app"

if [[ ! -d "$APP_PATH" ]]; then
    echo "❌ 编译完成但未找到 .app 产物: $APP_PATH"
    echo "  检查 $OUTPUT_DIR/build.log 了解详情"
    exit 1
fi

APP_SIZE=$(du -sh "$APP_PATH" | cut -f1)
APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")
APP_BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")
APP_ARCHS=$(lipo -archs "$APP_PATH/Contents/MacOS/$PROJECT_NAME" 2>/dev/null || echo "unknown")

echo ""
echo "──────────────────────────────────────────"
echo "✅ 编译成功！"
echo "──────────────────────────────────────────"
echo "  产物:   $APP_PATH"
echo "  大小:   $APP_SIZE"
echo "  版本:   $APP_VERSION (build $APP_BUILD)"
echo "  架构:   $APP_ARCHS"
echo "  配置:   $CONFIGURATION"
echo "  日志:   $OUTPUT_DIR/build.log"
echo ""

# ──────────────────────────────────────────────
# Release 模式：打包 dSYM
# ──────────────────────────────────────────────
if [[ "$CONFIGURATION" == "Release" ]]; then
    DSYM_PATH="$DERIVED_DATA_DIR/Build/Products/$CONFIGURATION/$PROJECT_NAME.app.dSYM"
    if [[ -d "$DSYM_PATH" ]]; then
        echo "▸ 打包调试符号..."
        ditto -c -k --keepParent "$DSYM_PATH" "$OUTPUT_DIR/$PROJECT_NAME.app.dSYM.zip"
        echo "  ✓ $OUTPUT_DIR/$PROJECT_NAME.app.dSYM.zip"
        echo ""
    fi
fi

# ──────────────────────────────────────────────
# 可选：直接打开应用
# ──────────────────────────────────────────────
echo "提示："
echo "  打开应用:        open \"$APP_PATH\""
echo "  在 Finder 中显示: open -R \"$APP_PATH\""
