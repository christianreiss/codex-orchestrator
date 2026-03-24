cleanup_legacy_skill_state() {
  local removed=0
  local path=""

  for path in "$HOME/.agents/skills" "$HOME/.codex/skills"; do
    if [[ -e "$path" ]] && remove_path "$path" "legacy local skills" 2>/dev/null; then
      removed=$((removed + 1))
    fi
  done

  for path in "$HOME/.agents/.skill-baseline.json" "$HOME/.codex/.skill-baseline.json"; do
    if [[ -e "$path" ]] && remove_path "$path" "legacy skill baseline" 2>/dev/null; then
      removed=$((removed + 1))
    fi
  done

  SKILL_REMOVED="$removed"
}

sync_skills_pull() {
  cleanup_legacy_skill_state
  SKILL_SYNC_STATUS="mcp"
  SKILL_SYNC_REASON=""
  return 0
}
