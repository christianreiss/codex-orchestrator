<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;

class TokenUsageTracker
{
    public function __construct(
        private readonly TokenUsageRepository $tokenUsages,
        private readonly TokenUsageIngestRepository $tokenUsageIngests,
        private readonly PricingService $pricingService,
        private readonly VersionRepository $versions,
        private readonly ?DashboardGraphStatsService $dashboardGraphStats = null
    ) {
    }

    public function recordTokenUsage(array $host, array $payload, ?string $clientIp = null): array
    {
        if (!isset($host['id'])) {
            throw new HttpException('Host not found', 404);
        }

        $usageRows = $this->normalizeUsagePayloads($payload);
        $hostId = (int) $host['id'];
        $records = [];
        $aggregates = [
            'total' => null,
            'input' => null,
            'output' => null,
            'cached' => null,
            'reasoning' => null,
            'cost' => 0.0,
        ];
        $pricingCache = [];
        $resolvePricing = function (?string $model) use (&$pricingCache): array {
            $resolvedModel = $model !== null && $model !== '' ? $model : $this->pricingService->defaultModel();
            if (!array_key_exists($resolvedModel, $pricingCache)) {
                $pricingCache[$resolvedModel] = $this->pricingService->latestPricing($resolvedModel, false);
            }
            return $pricingCache[$resolvedModel];
        };

        $recordedAt = gmdate(DATE_ATOM);

        foreach ($usageRows as $idx => $usage) {
            foreach (['total', 'input', 'output', 'cached', 'reasoning'] as $field) {
                if ($usage[$field] !== null) {
                    $aggregates[$field] = ($aggregates[$field] ?? 0) + (int) $usage[$field];
                }
            }

            $pricing = $resolvePricing($usage['model'] ?? null);
            $usageCost = $this->normalizeUsageCost($usage, $pricing);
            if ($usageCost !== null) {
                $aggregates['cost'] = ($aggregates['cost'] ?? 0.0) + $usageCost;
            }
            $usageRows[$idx]['cost'] = $usageCost;
        }

        $encodedPayload = null;
        $payloadWrapper = ['usages' => $usageRows];
        $encoded = json_encode($payloadWrapper, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encoded !== false) {
            $encodedPayload = $encoded;
        }

        $ingest = $this->tokenUsageIngests->record(
            $hostId,
            count($usageRows),
            $aggregates,
            $aggregates['cost'] ?? null,
            $encodedPayload,
            $clientIp !== null && $clientIp !== '' ? $clientIp : null
        );
        $ingestId = $ingest['id'] ?? null;

        foreach ($usageRows as $usage) {
            $details = array_filter([
                'line' => $usage['line'],
                'total' => $usage['total'],
                'input' => $usage['input'],
                'output' => $usage['output'],
                'cached' => $usage['cached'],
                'reasoning' => $usage['reasoning'],
                'cost' => $usage['cost'],
                'model' => $usage['model'],
                'ingest_id' => $ingestId,
            ], static fn ($value) => $value !== null && $value !== '');

            $this->tokenUsages->record(
                $hostId,
                $usage['total'],
                $usage['input'],
                $usage['output'],
                $usage['cached'],
                $usage['reasoning'],
                $usage['cost'],
                $usage['model'],
                $usage['line'],
                $ingestId
            );

            $records[] = [
                'recorded_at' => $recordedAt,
                'line' => $usage['line'],
                'total' => $usage['total'],
                'input' => $usage['input'],
                'output' => $usage['output'],
                'cached' => $usage['cached'],
                'reasoning' => $usage['reasoning'],
                'cost' => $usage['cost'],
                'model' => $usage['model'],
            ];
        }

        $this->dashboardGraphStats?->recordTokenUsage($aggregates, $recordedAt);

        $response = [
            'host_id' => $hostId,
            'recorded' => count($records),
            'usages' => $records,
            'ingest_id' => $ingestId,
            'cost' => $aggregates['cost'] ?? null,
        ];

        if (count($records) === 1) {
            $response = array_merge($response, $records[0]);
        }

        return $response;
    }

    public function normalizeUsagePayloads(array $payload): array
    {
        $entries = [];

        if (isset($payload['usages']) && is_array($payload['usages'])) {
            foreach ($payload['usages'] as $idx => $usage) {
                if (!is_array($usage)) {
                    continue;
                }
                $entries[] = $this->normalizeUsageEntry($usage, 'usages.' . $idx);
            }
        } else {
            $entries[] = $this->normalizeUsageEntry($payload, 'usage');
        }

        if (!$entries) {
            throw new ValidationException(['line' => ['line or numeric fields are required']]);
        }

        return $entries;
    }

    public function normalizeUsageEntry(array $usage, string $path): array
    {
        $line = '';
        if (array_key_exists('line', $usage) && is_string($usage['line'])) {
            $line = $this->sanitizeUsageLine($usage['line']);
        }

        $total = $this->normalizeUsageInt($usage['total'] ?? null, $path . '.total');
        $input = $this->normalizeUsageInt($usage['input'] ?? null, $path . '.input');
        $output = $this->normalizeUsageInt($usage['output'] ?? null, $path . '.output');
        $cached = $this->normalizeUsageInt($usage['cached'] ?? null, $path . '.cached', true);
        $reasoning = $this->normalizeUsageInt($usage['reasoning'] ?? null, $path . '.reasoning', true);

        $model = null;
        if (isset($usage['model']) && is_string($usage['model'])) {
            $model = trim($usage['model']);
        }

        if ($line === '' && $total === null && $input === null && $output === null && $cached === null && $reasoning === null) {
            throw new ValidationException([
                $path => ['line or at least one numeric field is required'],
            ]);
        }

        return [
            'line' => $line !== '' ? $line : null,
            'total' => $total,
            'input' => $input,
            'output' => $output,
            'cached' => $cached,
            'reasoning' => $reasoning,
            'model' => $model !== '' ? $model : null,
        ];
    }

    public function normalizeUsageCost(array $usage, array $pricing): ?float
    {
        $hasBillableBreakdown = false;
        foreach (['input', 'output', 'cached'] as $field) {
            if (array_key_exists($field, $usage) && $usage[$field] !== null) {
                $hasBillableBreakdown = true;
                break;
            }
        }

        if (!$hasBillableBreakdown) {
            return null;
        }

        $cost = $this->pricingService->calculateCost($pricing, [
            'input' => $usage['input'] ?? 0,
            'output' => $usage['output'] ?? 0,
            'cached' => $usage['cached'] ?? 0,
        ]);

        $value = (float) $cost;
        if (is_nan($value) || is_infinite($value) || $value < 0) {
            return null;
        }

        return round($value, 6);
    }

    public function sanitizeUsageLine(string $line): string
    {
        // Strip ANSI escape sequences (CSI + OSC) and control chars, then collapse whitespace.
        $clean = preg_replace('/\x1B\[[0-9;?]*[ -\\/]*[@-~]/', '', $line);
        $clean = preg_replace('/\x1B\][^\x07\x1B]*(\x07|\x1B\\\\)/', '', (string) $clean);
        $clean = preg_replace('/[\x00-\x1F\x7F]/', ' ', (string) $clean);
        $clean = preg_replace('/\\\\{2,}/', '\\\\', (string) $clean);
        $clean = preg_replace('/\\[<\\d+\\w?/', '', (string) $clean);
        $clean = preg_replace('/\s+/', ' ', (string) $clean);
        $clean = trim((string) $clean);
        if ($clean === '') {
            return '';
        }

        $usagePos = stripos($clean, 'token usage:');
        if ($usagePos !== false) {
            $clean = trim(substr($clean, $usagePos));
        }

        // Limit to printable ASCII to avoid stray control glyphs.
        $clean = preg_replace('/[^\x20-\x7E]/', '', $clean);

        // Hard cap to avoid oversized payloads in DB/UI.
        if (strlen($clean) > 1000) {
            $clean = substr($clean, 0, 1000) . '…';
        }

        return $clean;
    }

    public function normalizeCommand(mixed $command): string
    {
        if (!is_string($command) || trim($command) === '') {
            return 'retrieve';
        }

        $normalized = strtolower(trim($command));
        if (!in_array($normalized, ['retrieve', 'store'], true)) {
            throw new ValidationException(['command' => ['command must be "retrieve" or "store"']]);
        }

        return $normalized;
    }

    private function normalizeUsageInt(mixed $value, string $field, bool $optional = false): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (is_string($value)) {
            $normalized = preg_replace('/[,_\\s]/', '', $value);
            if ($normalized === '') {
                return null;
            }
            if (ctype_digit($normalized)) {
                $value = (int) $normalized;
            } else {
                throw new ValidationException([$field => [$field . ' must be a number (digits, optional commas)']]);
            }
        }

        if (is_int($value)) {
            if ($value < 0) {
                throw new ValidationException([$field => [$field . ' must be non-negative']]);
            }

            return $value;
        }

        if (is_numeric($value)) {
            $intVal = (int) $value;
            if ($intVal < 0) {
                throw new ValidationException([$field => [$field . ' must be non-negative']]);
            }

            return $intVal;
        }

        if ($optional) {
            return null;
        }

        throw new ValidationException([$field => [$field . ' must be an integer']]);
    }
}
