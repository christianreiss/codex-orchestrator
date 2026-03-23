<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Services\AuthService;

class VersionController
{
    public function __construct(
        private AuthService $service,
    ) {}

    public function index(): void
    {
        $versions = $this->service->versionSummary();

        Response::json([
            'status' => 'ok',
            'data' => $versions,
        ]);
    }
}
