<?php

namespace App\Services\Traits;

use App\Exceptions\ValidationException;

/**
 * Shared helpers used across multiple host-facing sync services.
 */
trait HostServiceTrait
{
    /**
     * Extract the integer host ID from a hydrated host row, or return null.
     */
    private function hostId(?array $host): ?int
    {
        return isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : null;
    }

    /**
     * Assert that a SHA-256 hex string is valid, appending to $errors on failure.
     *
     * @param array<string, list<string>> $errors
     */
    private function assertSha256(?string $sha, bool $allowNull = false, array &$errors = []): void
    {
        if ($sha === null) {
            if ($allowNull) {
                return;
            }
            $errors['sha256'][] = 'sha256 is required';
            if ($errors) {
                throw new ValidationException($errors);
            }
            return;
        }

        $value = trim($sha);
        if (!preg_match('/^[A-Fa-f0-9]{64}$/', $value)) {
            $errors['sha256'][] = 'sha256 must be 64 hex characters';
            if ($errors) {
                throw new ValidationException($errors);
            }
        }
    }
}
