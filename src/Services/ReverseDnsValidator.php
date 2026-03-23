<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\HttpException;
use App\Repositories\VersionRepository;

class ReverseDnsValidator
{
    public function __construct(
        private readonly VersionRepository $versions
    ) {
    }

    public function isReverseDnsRequired(array $host): bool
    {
        $mode = $this->normalizeReverseDnsModeValue($host['reverse_dns_mode'] ?? null);
        if ($mode === null) {
            return $this->versions->getFlag('reverse_dns_enabled', false);
        }

        return $mode;
    }

    public function assertReverseDnsMatch(array $host, string $normalizedIp): void
    {
        $fqdn = $this->normalizeHostname($host['fqdn'] ?? null);
        if ($fqdn === null) {
            throw new HttpException('Reverse DNS check failed', 403, [
                'code' => 'reverse_dns_mismatch',
            ]);
        }

        $forwardIps = $this->resolveForwardIps($fqdn);
        $forwardMatch = $this->ipListContains($forwardIps, $normalizedIp);

        $ptrHosts = $this->resolvePtrHosts($normalizedIp);
        $ptrMatch = $this->hostnameListContains($ptrHosts, $fqdn);

        if ($forwardMatch && $ptrMatch) {
            return;
        }

        throw new HttpException('Reverse DNS check failed', 403, [
            'code' => 'reverse_dns_mismatch',
            'forward_match' => $forwardMatch,
            'ptr_match' => $ptrMatch,
        ]);
    }

    /**
     * @return string[]
     */
    public function resolveForwardIps(string $fqdn): array
    {
        $records = dns_get_record($fqdn, DNS_A | DNS_AAAA);
        if (!is_array($records)) {
            return [];
        }

        $ips = [];
        foreach ($records as $record) {
            if (isset($record['ip'])) {
                $normalized = $this->normalizeIp((string) $record['ip']);
                if ($normalized !== null && $normalized !== '') {
                    $ips[] = $normalized;
                }
            }
            if (isset($record['ipv6'])) {
                $normalized = $this->normalizeIp((string) $record['ipv6']);
                if ($normalized !== null && $normalized !== '') {
                    $ips[] = $normalized;
                }
            }
        }

        return array_values(array_unique($ips));
    }

    /**
     * @return string[]
     */
    public function resolvePtrHosts(string $ip): array
    {
        $reverseName = $this->reverseDnsName($ip);
        $hosts = [];
        if ($reverseName !== null) {
            $records = dns_get_record($reverseName, DNS_PTR);
            if (is_array($records)) {
                foreach ($records as $record) {
                    if (isset($record['target'])) {
                        $normalized = $this->normalizeHostname((string) $record['target']);
                        if ($normalized !== null) {
                            $hosts[] = $normalized;
                        }
                    }
                }
            }
        }

        if (!$hosts) {
            $fallback = gethostbyaddr($ip);
            if (is_string($fallback) && $fallback !== '' && $fallback !== $ip) {
                $normalized = $this->normalizeHostname($fallback);
                if ($normalized !== null) {
                    $hosts[] = $normalized;
                }
            }
        }

        return array_values(array_unique($hosts));
    }

    public function reverseDnsName(string $ip): ?string
    {
        $normalized = $this->normalizeIp($ip);
        if ($normalized === null) {
            return null;
        }

        $binary = @inet_pton($normalized);
        if ($binary === false) {
            return null;
        }

        if (strlen($binary) === 4) {
            $parts = array_reverse(explode('.', $normalized));
            return implode('.', $parts) . '.in-addr.arpa';
        }

        if (strlen($binary) === 16) {
            $hex = bin2hex($binary);
            $chars = str_split($hex);
            $chars = array_reverse($chars);
            return implode('.', $chars) . '.ip6.arpa';
        }

        return null;
    }

    public function normalizeHostname(?string $hostname): ?string
    {
        if (!is_string($hostname)) {
            return null;
        }

        $normalized = strtolower(trim($hostname));
        $normalized = rtrim($normalized, '.');
        if ($normalized === '') {
            return null;
        }

        return $normalized;
    }

    private function normalizeReverseDnsModeValue(mixed $value): ?bool
    {
        if ($value === null) {
            return null;
        }
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if ($normalized === '' || $normalized === 'global' || $normalized === 'default') {
                return null;
            }
            if (in_array($normalized, ['1', 'true', 't', 'yes', 'y', 'on', 'enabled', 'enable'], true)) {
                return true;
            }
            if (in_array($normalized, ['0', 'false', 'f', 'no', 'n', 'off', 'disabled', 'disable'], true)) {
                return false;
            }
        }

        return null;
    }

    private function normalizeIp(?string $ip): ?string
    {
        if ($ip === null) {
            return null;
        }
        $normalized = trim($ip);
        if ($normalized === '') {
            return null;
        }

        $binary = @inet_pton($normalized);
        if ($binary === false) {
            return null;
        }

        if (strlen($binary) === 16) {
            $v4prefix = str_repeat("\x00", 10) . "\xff\xff";
            if (substr($binary, 0, 12) === $v4prefix) {
                $v4 = substr($binary, 12, 4);
                return inet_ntop($v4);
            }
        }

        return inet_ntop($binary);
    }

    /**
     * @param string[] $hosts
     */
    private function hostnameListContains(array $hosts, string $fqdn): bool
    {
        $normalized = $this->normalizeHostname($fqdn);
        if ($normalized === null) {
            return false;
        }
        foreach ($hosts as $host) {
            $candidate = $this->normalizeHostname($host);
            if ($candidate !== null && hash_equals($candidate, $normalized)) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param string[] $ips
     */
    private function ipListContains(array $ips, string $candidate): bool
    {
        $normalized = $this->normalizeIp($candidate);
        if ($normalized === null) {
            return false;
        }
        foreach ($ips as $ip) {
            $normalizedIp = $this->normalizeIp($ip);
            if ($normalizedIp !== null && hash_equals($normalizedIp, $normalized)) {
                return true;
            }
        }
        return false;
    }
}
