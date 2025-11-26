<?php

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
