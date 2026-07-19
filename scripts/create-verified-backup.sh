#!/bin/zsh

set -euo pipefail
umask 077

source_base="${NOTEBOOK_SOURCE_BASE:-$HOME/Documents/NotebookData}"
destination_root="${NOTEBOOK_RECOVERY_ROOT:-$HOME/Library/Application Support/NotebookRecovery}"
app_path="${NOTEBOOK_APP_PATH:-/Applications/Notebook.app}"
timestamp="$(date +%Y%m%d-%H%M%S)"
snapshot="$destination_root/baseline-$timestamp"
data_directory="$source_base/NotebookData"
database="$data_directory/Database/notebook.store"
was_running=0
finished=0
restore_drill_status=skipped

relaunch_if_needed() {
    if [[ "$was_running" == "1" && "$finished" == "1" && -d "$app_path" ]]; then
        open -a "$app_path"
    fi
}
trap relaunch_if_needed EXIT

for command in sqlite3 ditto shasum lsof; do
    command -v "$command" >/dev/null || {
        print -u2 "缺少备份依赖：$command"
        exit 1
    }
done

[[ -f "$database" ]] || {
    print -u2 "找不到 Notebook 数据库：$database"
    exit 1
}
[[ "$snapshot" != *"'"* ]] || {
    print -u2 "备份路径不能包含单引号"
    exit 1
}

mkdir -p "$snapshot"
chmod 700 "$destination_root" "$snapshot"

if pgrep -f '/Notebook.app/Contents/MacOS/Notebook' >/dev/null; then
    was_running=1
    osascript -e 'tell application "Notebook" to quit'
    for _ in {1..30}; do
        pgrep -f '/Notebook.app/Contents/MacOS/Notebook' >/dev/null || break
        sleep 1
    done
    if pgrep -f '/Notebook.app/Contents/MacOS/Notebook' >/dev/null; then
        print -u2 "Notebook 未能正常退出，备份已中止"
        exit 1
    fi
fi

sqlite3 "$database" 'pragma wal_checkpoint(TRUNCATE);' >/dev/null
[[ "$(sqlite3 "$database" 'pragma integrity_check;')" == "ok" ]] || {
    print -u2 "源数据库完整性检查失败，备份已中止"
    exit 1
}

sqlite3 "$database" ".backup '$snapshot/notebook-consistent.store'"
ditto "$data_directory" "$snapshot/NotebookData"

application_support="$HOME/Library/Application Support/Notebook"
[[ ! -d "$application_support" ]] || ditto "$application_support" "$snapshot/ApplicationSupport-Notebook"
preferences="$HOME/Library/Preferences/yy.Notebook.plist"
[[ ! -f "$preferences" ]] || cp -p "$preferences" "$snapshot/yy.Notebook.plist"
[[ ! -d "$app_path" ]] || ditto "$app_path" "$snapshot/Notebook-installed.app"

consistent_database="$snapshot/notebook-consistent.store"
copied_database="$snapshot/NotebookData/Database/notebook.store"
for candidate in "$consistent_database" "$copied_database"; do
    [[ "$(sqlite3 "$candidate" 'pragma integrity_check;')" == "ok" ]] || {
        print -u2 "备份数据库完整性检查失败：$candidate"
        exit 1
    }
done

source_dump_hash="$(sqlite3 "$database" '.dump' | shasum -a 256 | awk '{print $1}')"
backup_dump_hash="$(sqlite3 "$consistent_database" '.dump' | shasum -a 256 | awk '{print $1}')"
copy_dump_hash="$(sqlite3 "$copied_database" '.dump' | shasum -a 256 | awk '{print $1}')"
[[ "$source_dump_hash" == "$backup_dump_hash" && "$source_dump_hash" == "$copy_dump_hash" ]] || {
    print -u2 "数据库逻辑内容哈希不一致，备份已中止"
    exit 1
}
cat > "$snapshot/database-semantic-hashes.txt" <<EOF
source_dump_sha256=$source_dump_hash
consistent_backup_dump_sha256=$backup_dump_hash
full_copy_dump_sha256=$copy_dump_hash
EOF

if [[ -d "$data_directory/Attachments" ]]; then
    (
        cd "$data_directory"
        find Attachments -type f -print0 | sort -z | xargs -0 shasum -a 256
    ) > "$snapshot/source-attachments.sha256"
    (
        cd "$snapshot/NotebookData"
        find Attachments -type f -print0 | sort -z | xargs -0 shasum -a 256
    ) > "$snapshot/copied-attachments.sha256"
    cmp "$snapshot/source-attachments.sha256" "$snapshot/copied-attachments.sha256"
fi

sqlite3 -separator '|' "$consistent_database" \
    "select 'notes',count(*) from ZBLOCKDOCUMENTNOTEENTITY
     union all select 'blocks',count(*) from ZBLOCKDOCUMENTBLOCKENTITY
     union all select 'assets',count(*) from ZBLOCKDOCUMENTASSETENTITY
     union all select 'versions',count(*) from ZBLOCKDOCUMENTNOTEVERSIONENTITY
     union all select 'reading_positions',count(*) from ZBLOCKDOCUMENTREADINGPOSITIONENTITY
     union all select 'deleted_tombstones',count(*) from ZBLOCKDOCUMENTDELETEDNOTETOMBSTONEENTITY;" \
    > "$snapshot/entity-counts.txt"

if [[ -x "$app_path/Contents/MacOS/Notebook" ]]; then
    drill="$snapshot/RestoreDrill"
    mkdir -p "$drill"
    cp -cR "$snapshot/NotebookData" "$drill/NotebookData" 2>/dev/null \
        || ditto "$snapshot/NotebookData" "$drill/NotebookData"
    drill_database="$drill/NotebookData/Database/notebook.store"
    before_open_hash="$(sqlite3 "$drill_database" '.dump' | shasum -a 256 | awk '{print $1}')"
    env NOTEBOOK_UI_TEST_DATA_DIR="$drill" \
        NOTEBOOK_TEST_DEFAULTS_SUITE="NotebookRecoveryDrill-$timestamp" \
        "$app_path/Contents/MacOS/Notebook" > "$snapshot/restore-drill.log" 2>&1 &
    drill_pid=$!
    opened=0
    for _ in {1..30}; do
        if lsof -p "$drill_pid" 2>/dev/null | grep -Fq "$drill_database"; then
            opened=1
            break
        fi
        kill -0 "$drill_pid" 2>/dev/null || break
        sleep 1
    done
    if [[ "$opened" != "1" ]]; then
        kill -TERM "$drill_pid" 2>/dev/null || true
        wait "$drill_pid" 2>/dev/null || true
        print -u2 "正式应用未能打开隔离恢复副本"
        exit 1
    fi
    kill -TERM "$drill_pid"
    wait "$drill_pid" 2>/dev/null || true
    sqlite3 "$drill_database" 'pragma wal_checkpoint(TRUNCATE);' >/dev/null
    [[ "$(sqlite3 "$drill_database" 'pragma integrity_check;')" == "ok" ]] || {
        print -u2 "隔离恢复副本打开后完整性检查失败"
        exit 1
    }
    after_open_hash="$(sqlite3 "$drill_database" '.dump' | shasum -a 256 | awk '{print $1}')"
    [[ "$before_open_hash" == "$after_open_hash" ]] || {
        print -u2 "应用打开隔离恢复副本后数据发生变化"
        exit 1
    }
    cat > "$snapshot/restore-drill-hashes.txt" <<EOF
before_open_dump_sha256=$before_open_hash
after_open_dump_sha256=$after_open_hash
EOF
    restore_drill_status=passed
fi

cat > "$snapshot/manifest.txt" <<EOF
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_base=$source_base
database_integrity=ok
attachment_copy_verified=yes
isolated_restore_drill=$restore_drill_status
EOF

chmod -R go-rwx "$snapshot"
find "$snapshot" -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > "$snapshot/SHA256SUMS"
chmod 600 "$snapshot/SHA256SUMS"

finished=1
print "备份与恢复演练通过：$snapshot"
print "实体统计："
cat "$snapshot/entity-counts.txt"
