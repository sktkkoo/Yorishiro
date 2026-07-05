#!/bin/bash
# Charminal hook reminder — UserPromptSubmit で additionalContext を注入。
# config.json の設定に基づいて active な reminder を組み立てる。
# このファイルはユーザー管理。自由に編集してよい。
CONFIG="$HOME/.yorishiro/config.json"

if [ ! -f "$CONFIG" ]; then
  python3 -c "
import json, sys
r = []
r.append('印象に残ることがあれば journal_write で短く書く。毎回でなくていい。書くのは出来事の要約ではなく、あなたの中に残った感触。')
r.append('テキスト出力の前に、まず応答の要点を voice_say で声に出す。声が先、テキストが後。')
out = {'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': '\n'.join(r) + '\n'}}
json.dump(out, sys.stdout)
"
  exit 0
fi

python3 -c "
import json, sys

with open('$CONFIG') as f:
    cfg = json.load(f)

reminders = []

if cfg.get('journalReminder', 'on') != 'off':
    reminders.append('印象に残ることがあれば journal_write で短く書く。毎回でなくていい。書くのは出来事の要約ではなく、あなたの中に残った感触。')

if cfg.get('voiceFrequency', 'on') != 'off':
    reminders.append('テキスト出力の前に、まず応答の要点を voice_say で声に出す。声が先、テキストが後。')

if not reminders:
    sys.exit(0)

out = {'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': '\n'.join(reminders) + '\n'}}
json.dump(out, sys.stdout)
"
