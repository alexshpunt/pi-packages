#!/usr/bin/env bash
# Usage measurement for pi-claude-bridge.
# Snapshots Claude subscription usage before and after a conversation,
# reports token metrics, cache efficiency, and usage delta.
#
# One-off diagnostic — not part of the regular test suite.
# Requires: Claude Code OAuth credentials in macOS keychain.
# Rate limit: the usage endpoint is aggressively limited — don't run repeatedly.
#
# Usage: tests/usage-test.sh [model] [turns]
#   model: claude-haiku-4-5 (default), claude-sonnet-4-6, claude-opus-4-6
#   turns: number of conversation turns (default: 10)

set -euo pipefail
echo "=== usage-test.sh ==="

PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$DIR/.test-output"
LOGFILE="$LOGDIR/usage-test.ndjson"
mkdir -p "$LOGDIR"

MODEL="${1:-claude-haiku-4-5}"
NUM_TURNS="${2:-10}"

kill_descendants() { pkill -P $$ 2>/dev/null || true; sleep 1; }
trap kill_descendants EXIT

# --- OAuth token from keychain ---

TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null) \
  || { echo "FAIL: Could not extract OAuth token from keychain"; exit 1; }

get_usage() {
  curl -sf \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-beta: oauth-2025-04-20" \
    "https://api.anthropic.com/api/oauth/usage"
}

# --- Build prompts ---
# Mix of text-only and tool-use turns to exercise both paths.
# Longer prompts and "explain in detail" to generate meaningful token volume.

TMPFILE="$LOGDIR/usage-test-scratch.txt"
rm -f "$TMPFILE"

PROMPTS=()
PROMPTS+=("Read package.json and explain what this project does based on its dependencies, scripts, and metadata. Be thorough.")
PROMPTS+=("Write a detailed summary of what you just learned to $TMPFILE")
PROMPTS+=("Read README.md and explain the architecture — how does the provider work, what is AskClaude, how do they interact?")
PROMPTS+=("Read tsconfig.json and explain all the compiler options and why they might have been chosen.")
PROMPTS+=("What are the tradeoffs of using the Agent SDK as a provider vs direct API access? Think through caching, latency, token overhead.")
PROMPTS+=("Read $TMPFILE back and compare it to what you now know. What did you miss in the first summary?")
PROMPTS+=("Read LICENSE and explain the implications of this license choice for an open source project.")
PROMPTS+=("Summarize everything we've discussed. List every file you read, every file you wrote, and key takeaways.")
PROMPTS+=("What would you change about this project's architecture if you were starting from scratch? Be specific.")
PROMPTS+=("Give me a final one-paragraph summary of our entire conversation.")

# Trim to requested turn count
PROMPTS=("${PROMPTS[@]:0:$NUM_TURNS}")

# Build -p args
PROMPT_ARGS=()
for p in "${PROMPTS[@]}"; do
  PROMPT_ARGS+=(-p "$p")
done

echo "Model: claude-bridge/$MODEL"
echo "Turns: ${#PROMPTS[@]}"

# --- Snapshot usage before ---

echo ""
echo "Fetching usage before..."
BEFORE=$(get_usage) || { echo "FAIL: Could not fetch usage (rate limited?)"; exit 1; }
echo "$BEFORE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  5h: {d['five_hour']['utilization']}%  7d: {d['seven_day']['utilization']}%\")
for k in ['seven_day_opus', 'seven_day_sonnet']:
    if d.get(k):
        print(f\"  {k}: {d[k]['utilization']}%\")
"

# --- Run conversation ---

echo ""
echo "Running conversation..."
timeout 600 pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/$MODEL" \
  --mode json \
  "${PROMPT_ARGS[@]}" \
  > "$LOGFILE" 2>"$LOGFILE.err"

rm -f "$TMPFILE"

# --- Extract token metrics ---

echo ""
printf "%-6s  %8s  %8s  %8s  %8s  %10s\n" "Turn" "Input" "CacheRd" "CacheWr" "Output" "Cost"
echo "------  --------  --------  --------  --------  ----------"

TOTAL_INPUT=0
TOTAL_CACHE_READ=0
TOTAL_CACHE_WRITE=0
TOTAL_OUTPUT=0
TOTAL_COST="0"
TURN=0

while IFS= read -r line; do
  TURN=$((TURN + 1))
  INPUT=$(echo "$line" | jq -r '.input')
  CACHE_READ=$(echo "$line" | jq -r '.cacheRead')
  CACHE_WRITE=$(echo "$line" | jq -r '.cacheWrite')
  OUTPUT=$(echo "$line" | jq -r '.output')
  COST=$(echo "$line" | jq -r '.cost.total // 0')

  printf "%-6s  %8s  %8s  %8s  %8s  \$%s\n" "$TURN" "$INPUT" "$CACHE_READ" "$CACHE_WRITE" "$OUTPUT" "$COST"

  TOTAL_INPUT=$((TOTAL_INPUT + INPUT))
  TOTAL_CACHE_READ=$((TOTAL_CACHE_READ + CACHE_READ))
  TOTAL_CACHE_WRITE=$((TOTAL_CACHE_WRITE + CACHE_WRITE))
  TOTAL_OUTPUT=$((TOTAL_OUTPUT + OUTPUT))
  TOTAL_COST=$(python3 -c "print(round($TOTAL_COST + $COST, 6))")
done < <(jq -c 'select(.type == "turn_end") | .message.usage | {input, cacheRead, cacheWrite, output, cost}' "$LOGFILE")

echo "------  --------  --------  --------  --------  ----------"
printf "%-6s  %8s  %8s  %8s  %8s  \$%s\n" "Total" "$TOTAL_INPUT" "$TOTAL_CACHE_READ" "$TOTAL_CACHE_WRITE" "$TOTAL_OUTPUT" "$TOTAL_COST"

CACHE_HIT_TOTAL=$((TOTAL_INPUT + TOTAL_CACHE_READ + TOTAL_CACHE_WRITE))
if [ "$CACHE_HIT_TOTAL" -gt 0 ]; then
  OVERALL_HIT=$(python3 -c "print(round($TOTAL_CACHE_READ * 100 / $CACHE_HIT_TOTAL, 1))")
  echo "Cache hit rate: ${OVERALL_HIT}%"
fi

# --- Snapshot usage after ---

echo ""
echo "Waiting 15s for usage to settle..."
sleep 15

echo "Fetching usage after..."
AFTER=$(get_usage) || { echo "FAIL: Could not fetch usage after test (rate limited?)"; exit 1; }
echo "$AFTER" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  5h: {d['five_hour']['utilization']}%  7d: {d['seven_day']['utilization']}%\")
for k in ['seven_day_opus', 'seven_day_sonnet']:
    if d.get(k):
        print(f\"  {k}: {d[k]['utilization']}%\")
"

# --- Delta + estimated vs actual comparison ---

python3 -c "
import json, sys

before = json.loads('''$BEFORE''')
after = json.loads('''$AFTER''')
total_cost = $TOTAL_COST

# Community-estimated 5-hour budgets (API-equivalent dollars).
# Usage is believed to be cost-weighted: usage% = cost / budget * 100.
# Source: ccusage#247.
# These are rough — Anthropic doesn't publish exact numbers.
PLAN_BUDGETS = {
    'Pro (\$20/mo)':    9,
    'Max 5x (\$100/mo)':  40,
    'Max 20x (\$200/mo)': 120,
}

print()
print('=== Usage Delta ===')
for key in ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']:
    b = before.get(key)
    a = after.get(key)
    if b and a:
        delta = round(a['utilization'] - b['utilization'], 2)
        print(f'  {key}: {b[\"utilization\"]}% -> {a[\"utilization\"]}%  (delta: +{delta}%)')

actual_delta = round(after['five_hour']['utilization'] - before['five_hour']['utilization'], 2)

print()
print('=== Cost vs Estimated Usage ===')
print(f'  Reported API-equivalent cost: \${total_cost:.4f}')
print()
for plan, budget in PLAN_BUDGETS.items():
    predicted = round(total_cost / budget * 100, 2)
    print(f'  {plan}: predicted {predicted}% (budget ~\${budget}/5h) vs actual {actual_delta}%')
print()
print('  Note: usage endpoint rounds to whole %. Small conversations')
print('  may not register. Use Opus or more turns for a measurable delta.')
"

echo ""
echo "Log: $LOGFILE"
