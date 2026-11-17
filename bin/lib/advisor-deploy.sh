#!/usr/bin/env bash
# A single-file CA bind mount pins its inode. Host trust updates replace that
# inode, so recreating the existing advisor is required even with the same image.
advisor_deploy_refresh() {
  [[ "${advisor_was_running:-0}" -eq 1 ]] || return 0
  "${compose[@]}" --profile advisor up -d --no-deps --force-recreate advisor
}
