<?php

namespace App\Services;

use App\Repositories\HostRepository;

class HostStatusExporter
{
    public function __construct(
        private readonly HostRepository $hosts,
        private readonly string $outputPath
    ) {
    }

    public function generate(): string
    {
        $hosts = $this->hosts->all();
        $generatedAt = gmdate(DATE_ATOM);
        $this->ensureDirectory();

        $lines = [];
        $lines[] = 'Codex Auth Sync - Host Status';
        $lines[] = 'Generated: ' . $generatedAt;
        $lines[] = str_repeat('=', 120);
        $lines[] = sprintf(
            '%-3s  %-30s %-10s %-24s %-24s %-12s %-8s %-12s',
            '#',
            'Host',
            'Status',
            'Last Contact',
            'Auth Version',
            'Client Ver',
            'Entries',
            'Digest'
        );
        $lines[] = str_repeat('-', 120);

        if (!$hosts) {
            $lines[] = 'No hosts registered.';
        } else {
            foreach ($hosts as $index => $host) {
                $authPayload = $host['auth_json'] ? json_decode($host['auth_json'], true) : null;
                $lastContact = $host['updated_at'] ?? 'n/a';
                $authVersion = $authPayload['last_refresh'] ?? ($host['last_refresh'] ?? 'n/a');
                $entryCount = 0;
                $clientVersion = $host['client_version'] ?? 'n/a';
                if (isset($authPayload['auths']) && is_array($authPayload['auths'])) {
                    $entryCount = count($authPayload['auths']);
                }

                $digest = $host['auth_json']
                    ? substr(hash('sha256', $host['auth_json']), 0, 12)
                    : 'n/a';

                $lines[] = sprintf(
                    '%-3d  %-30s %-10s %-24s %-24s %-12s %-8s %-12s',
                    $index + 1,
                    $host['fqdn'],
                    $host['status'],
                    $lastContact,
                    $authVersion,
                    $clientVersion,
                    $entryCount ?: '-',
                    $digest
                );
            }

            $lines[] = '';
            $lines[] = 'Details';
            $lines[] = str_repeat('-', 120);

            foreach ($hosts as $index => $host) {
                $authPayload = $host['auth_json'] ? json_decode($host['auth_json'], true) : null;
                $authVersion = $authPayload['last_refresh'] ?? ($host['last_refresh'] ?? 'n/a');
                $lastContact = $host['updated_at'] ?? 'n/a';
                $lastRefresh = $host['last_refresh'] ?? 'n/a';
                $entryCount = 0;
                $authTargets = [];
                if (isset($authPayload['auths']) && is_array($authPayload['auths'])) {
                    $entryCount = count($authPayload['auths']);
                    $authTargets = array_keys($authPayload['auths']);
                }

                $digest = $host['auth_json']
                    ? substr(hash('sha256', $host['auth_json']), 0, 20)
                    : 'n/a';

                $lines[] = sprintf('%d. %s', $index + 1, $host['fqdn']);
                $lines[] = '    Status        : ' . $host['status'];
                $lines[] = '    Last contact  : ' . $lastContact;
                $lines[] = '    Last refresh  : ' . $lastRefresh;
                $lines[] = '    Auth version  : ' . $authVersion;
                $lines[] = '    Client version: ' . ($host['client_version'] ?? 'n/a');
                $lines[] = '    Auth entries  : ' . ($entryCount ?: 'none');
                $targets = $authTargets ? implode(', ', $authTargets) : 'none recorded';
                $lines[] = '    Auth targets  : ' . $targets;
                $lines[] = '    Auth digest   : ' . $digest;
                $lines[] = '';
            }
        }

        file_put_contents($this->outputPath, implode(PHP_EOL, $lines) . PHP_EOL);

        return $this->outputPath;
    }

    private function ensureDirectory(): void
    {
        $directory = dirname($this->outputPath);
        if (!is_dir($directory)) {
            mkdir($directory, 0775, true);
        }
    }
}
