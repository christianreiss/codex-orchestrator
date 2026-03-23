<?php

declare(strict_types=1);

namespace App\Http\Controllers;

/**
 * Serves the admin SPA shell for all GET page routes.
 *
 * Every method simply includes the compiled SPA entry-point so that
 * client-side routing can take over.
 */
class AdminPageController
{
    private string $publicDir;

    public function __construct(string $publicDir)
    {
        $this->publicDir = $publicDir;
    }

    /** GET /admin */
    public function index(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/login */
    public function login(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/hosts/{id} */
    public function host(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/dashboard */
    public function dashboard(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/account, /admin/account/password, /admin/account/passkeys */
    public function account(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/settings */
    public function settings(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/settings/{section} */
    public function settingsSection(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/hosts/secure */
    public function hostsSecure(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/hosts/unprovisioned */
    public function hostsUnprovisioned(): void
    {
        require $this->publicDir . '/admin/index.php';
    }

    /** GET /admin/logs/mcp, /admin/logs/events */
    public function logs(): void
    {
        require $this->publicDir . '/admin/index.php';
    }
}
