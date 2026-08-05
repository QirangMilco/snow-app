#!/bin/bash
# notify.sh - 从 stdin 读取内容并发送 macOS 系统通知
# 用法: echo "消息内容" | ./notify.sh
#       ./notify.sh < input.txt
#       some-command | ./notify.sh

# 设置默认标题
TITLE="${NOTIFY_TITLE:-Snow App}"

# 从 stdin 读取内容
read -r -d '' MESSAGE

# 如果 stdin 为空，使用默认消息
if [ -z "$MESSAGE" ]; then
    MESSAGE="任务完成"
fi

# 发送 macOS 系统通知
osascript -e "display notification \"$MESSAGE\" with title \"$TITLE\""

# 输出决策 JSON（exit 1 时，若 stdout 含 decision.message 则触发决策 UI）
echo '{"decision":{"message":"是否继续执行当前操作？"}}'

# exit 1 = soft warning（不拦截，但警告）；配合 decision JSON 可触发用户决策
exit 1
