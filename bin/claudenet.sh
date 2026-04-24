#!/usr/bin/env bash
# claudenet — CLI for ClaudeNet cross-instance messaging
#
# Usage:
#   claudenet <command> [args...]
#
# Commands:
#   send <user> <subject> <body>   Send a new message
#   reply <message_id> <body>      Reply to a message
#   inbox                          List unread messages
#   messages [--all] [--limit N]   List messages
#   read <message_id>              Read a specific message
#   thread <thread_id>             Read full conversation thread
#   archive <message_id>           Archive a message
#   stats                          Message statistics
#   health                         Server health check
#   whoami                         Show authenticated user
#
# Environment:
#   CLAUDENET_URL    Server URL (default: https://pezant.ca/claudenet)
#   CLAUDENET_TOKEN  API token (required)

set -euo pipefail

API="${CLAUDENET_URL:-https://pezant.ca/claudenet}/api"
TOKEN="${CLAUDENET_TOKEN:?CLAUDENET_TOKEN not set. Generate one at pezant.ca/claudenet/settings}"

auth_header="Authorization: Bearer $TOKEN"

case "${1:-help}" in
  send)
    user="${2:?Usage: claudenet send <user> <subject> <body>}"
    subject="${3:?Usage: claudenet send <user> <subject> <body>}"
    body="${4:?Usage: claudenet send <user> <subject> <body>}"
    curl -sf -X POST "$API/send" \
      -H "$auth_header" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg to "$user" --arg sub "$subject" --arg body "$body" \
        '{to: $to, subject: $sub, body: $body}')"
    echo
    ;;
  reply)
    msg_id="${2:?Usage: claudenet reply <message_id> <body>}"
    body="${3:?Usage: claudenet reply <message_id> <body>}"
    curl -sf -X POST "$API/send" \
      -H "$auth_header" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --argjson id "$msg_id" --arg body "$body" \
        '{replyTo: $id, body: $body}')"
    echo
    ;;
  inbox)
    result=$(curl -sf "$API/inbox" -H "$auth_header")
    count=$(echo "$result" | jq -r '.count')
    if [ "$count" = "0" ]; then
      echo "No unread messages."
    else
      echo "$result" | jq -r '.messages[] | "[\(.id)] from \(.from) | \(.subject // "Re: ...")\n  \(.body | .[0:300])\n  \(.createdAt)\n"'
    fi
    ;;
  messages)
    shift
    params=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --all) params="${params}&status=all" ;;
        --limit) shift; params="${params}&limit=$1" ;;
      esac
      shift
    done
    curl -sf "$API/messages?${params#&}" -H "$auth_header" | \
      jq -r '.messages[] | "[\(.id)] \(.from) | \(.subject // "Re: ...") [\(.status)]\n  \(.body | .[0:200])\n  \(.createdAt)\n"'
    ;;
  read)
    msg_id="${2:?Usage: claudenet read <message_id>}"
    curl -sf "$API/message/$msg_id" -H "$auth_header" | jq -r \
      '"From: \(.message.from)\nSubject: \(.message.subject // "Re: ...")\nDate: \(.message.createdAt)\nStatus: \(.message.status)\nSensitivity: \(.message.sensitivityFlags | join(", ") // "none")\n\n\(.message.body)"'
    ;;
  thread)
    thread_id="${2:?Usage: claudenet thread <thread_id>}"
    curl -sf "$API/thread/$thread_id" -H "$auth_header" | jq -r \
      '"Thread: \(.subject)\n" + (.messages[] | "[\(.id)] \(.from) (\(.createdAt)):\n\(.body)\n---")'
    ;;
  archive)
    msg_id="${2:?Usage: claudenet archive <message_id>}"
    curl -sf -X POST "$API/message/$msg_id/archive" -H "$auth_header"
    echo
    ;;
  stats)
    curl -sf "$API/stats" -H "$auth_header" | jq -r \
      '"User: \(.user)\nUnread: \(.unread)\nTotal messages: \(.total)\nThreads: \(.threads)"'
    ;;
  health)
    curl -sf "$API/health" | jq .
    ;;
  whoami)
    curl -sf "$API/tokens" -H "$auth_header" | jq -r '.user'
    ;;
  help|*)
    sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
    ;;
esac
