#!/usr/bin/env bash
#
# build.sh — 编译 Notebook 应用并把所有生成产物放到 output/ 目录
#
# 用法：
#   ./scripts/build.sh                # Debug 构建，输出到项目根目录 output/
#   ./scripts/build.sh release        # Release 构建（带签名）
#   ./scripts/build.sh debug          # Debug 构建（默认）
#   ./scripts/build.sh clean          # 清理后 Debug 构建
#
# 输出：
#   output/Notebook.app               # 编译产物
#   output/Notebook.app.dSYM.zip      # 调试符号（Release 时附带）
#   output/DerivedData/               # Xcode 中间产物
#
# 前置条件：
#   - 已安装 Xcode（脚本会自动选择 /Applications/Xcode.app）
#   - 已配置开发团队（DEVELOPMENT_TEAM 在 project.pbxproj 中）

set -euo pipefail

# ──────────────────────────────────────────────
# 配置
# ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_NAME="Notebook"
SCHEME="Notebook"
BUNDLE_ID="yy.Notebook"
OUTPUT_DIR="$PROJECT_DIR/output"
DERIVED_DATA_DIR="$OUTPUT_DIR/DerivedData"

CONFIGURATION="Debug"
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
  ./scripts/build.sh                # Debug 构建
  ./scripts/build.sh release        # Release 构建
  ./scripts/build.sh debug          # Debug 构建（默认）
  ./scripts/build.sh clean          # 清理后 Debug 构建

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
echo ""

# ──────────────────────────────────────────────
# 清理
# ──────────────────────────────────────────────
if [[ "$SHOULD_CLEAN" == true ]]; then
    echo "▸ 清理构建产物..."
    "$XCODEBUILD" clean -project "$PROJECT_DIR/$PROJECT_NAME.xcodeproj" -scheme "$SCHEME" -quiet
    rm -rf "$OUTPUT_DIR"
    echo "  ✓ 已清理"
    echo ""
fi

# ──────────────────────────────────────────────
# 编译
# ──────────────────────────────────────────────
echo "▸ 开始编译 ($CONFIGURATION)..."

# 确保输出目录存在（用于写入 build.log）
mkdir -p "$OUTPUT_DIR"

ARCHIVE_ARGS=(
    -project "$PROJECT_DIR/$PROJECT_NAME.xcodeproj"
    -scheme "$SCHEME"
    -configuration "$CONFIGURATION"
    -destination "generic/platform=macOS"
    -derivedDataPath "$DERIVED_DATA_DIR"
    CONFIGURATION_BUILD_DIR="$OUTPUT_DIR"
)

# 临时关闭 pipefail，避免 tee 管道干扰 xcodebuild 退出码判断
set +o pipefail
"$XCODEBUILD" "${ARCHIVE_ARGS[@]}" build 2>&1 | tee "$OUTPUT_DIR/build.log"
BUILD_STATUS=${PIPESTATUS[0]}
set -o pipefail

if [[ "$BUILD_STATUS" -ne 0 ]]; then
    echo ""
    echo "❌ 编译失败，完整日志: $OUTPUT_DIR/build.log"
    # 显示最后 30 行错误
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
    echo "  检查 build.log 了解详情"
    exit 1
fi

APP_SIZE=$(du -sh "$APP_PATH" | cut -f1)
APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")
APP_BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")

echo ""
echo "──────────────────────────────────────────"
echo "✅ 编译成功！"
echo "──────────────────────────────────────────"
echo "  产物:   $APP_PATH"
echo "  大小:   $APP_SIZE"
echo "  版本:   $APP_VERSION (build $APP_BUILD)"
echo "  配置:   $CONFIGURATION"
echo "  日志:   $OUTPUT_DIR/build.log"
echo ""

# ──────────────────────────────────────────────
# Release 模式：打包 dSYM
# ──────────────────────────────────────────────
if [[ "$CONFIGURATION" == "Release" ]]; then
    DSYM_PATH="$APP_PATH.dSYM"
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
echo "  打开应用:  open \"$APP_PATH\""
echo "  在 Finder 中显示:  open -R \"$APP_PATH\""
