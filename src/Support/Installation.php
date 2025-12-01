<?php

namespace App\Support;

class Installation
{
    public static function ensure(string $root): string
    {
        $existing = $_ENV['INSTALLATION_ID'] ?? getenv('INSTALLATION_ID');
        if (is_string($existing) && trim($existing) !== '') {
            return trim($existing);
        }

        $envPath = rtrim($root, '/\\') . '/.env';
        if (is_file($envPath) && is_readable($envPath)) {
            $contents = (string) file_get_contents($envPath);
            if (preg_match('/^\s*INSTALLATION_ID\s*=\s*([^\r\n#]+)/m', $contents, $matches)) {
                $persisted = trim($matches[1]);
                if ($persisted !== '') {
                    putenv('INSTALLATION_ID=' . $persisted);
                    $_ENV['INSTALLATION_ID'] = $persisted;
                    $_SERVER['INSTALLATION_ID'] = $persisted;

                    return $persisted;
                }
            }
        }

        $id = self::uuidV4();
        $written = false;

        if (is_file($envPath) && is_writable($envPath)) {
            $contents = (string) file_get_contents($envPath);
            if (!preg_match('/^\s*INSTALLATION_ID\s*=/m', $contents)) {
                $contents .= (str_ends_with($contents, PHP_EOL) ? '' : PHP_EOL) . 'INSTALLATION_ID=' . $id . PHP_EOL;
                file_put_contents($envPath, $contents);
                $written = true;
            }
        } elseif (!file_exists($envPath)) {
            $written = file_put_contents($envPath, 'INSTALLATION_ID=' . $id . PHP_EOL) !== false;
        }

        putenv('INSTALLATION_ID=' . $id);
        $_ENV['INSTALLATION_ID'] = $id;
        $_SERVER['INSTALLATION_ID'] = $id;

        if (!$written) {
            error_log('[install] generated INSTALLATION_ID but could not persist to .env; set it manually to avoid drift');
        }

        return $id;
    }

    private static function uuidV4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
