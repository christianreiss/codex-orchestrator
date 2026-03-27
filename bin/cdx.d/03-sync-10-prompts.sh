cleanup_legacy_prompt_state() {
  local removed=0
  local path=""

  for path in "$HOME/.agents/prompts" "$HOME/.codex/prompts"; do
    if [[ -e "$path" ]] && remove_path "$path" "legacy local prompts" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done

  for path in "$HOME/.agents/.prompt-baseline.json" "$HOME/.codex/.prompt-baseline.json"; do
    if [[ -e "$path" ]] && remove_path "$path" "legacy prompt baseline" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done

  return 0
}
