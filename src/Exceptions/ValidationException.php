<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Exceptions;

class ValidationException extends HttpException
{
    public function __construct(array $errors)
    {
        parent::__construct('Validation failed', 422, $errors);
    }

    public function getErrors(): array
    {
        return $this->context();
    }
}
