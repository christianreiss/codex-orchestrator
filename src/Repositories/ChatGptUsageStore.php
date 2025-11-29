<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

interface ChatGptUsageStore
{
    public function record(array $snapshot): array;

    public function latest(): ?array;

    /**
     * @return array<int, array<string, mixed>>
     */
    public function history(?string $since = null): array;
}
