<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Exceptions;

use RuntimeException;

class HttpException extends RuntimeException
{
    public function __construct(
        string $message,
        private readonly int $statusCode = 400,
        private readonly array $context = []
    ) {
        parent::__construct($message);
    }

    public function statusCode(): int
    {
        return $this->statusCode;
    }

    /**
     * Alias used by callers expecting a PSR-style accessor.
     */
    public function getStatusCode(): int
    {
        return $this->statusCode();
    }

    public function context(): array
    {
        return $this->context;
    }
}
