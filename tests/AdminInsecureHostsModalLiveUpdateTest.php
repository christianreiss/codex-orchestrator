<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminInsecureHostsModalLiveUpdateTest extends TestCase
{
    public function testInsecureHostsModalTracksCountdownsAndWsRefresh(): void
    {
        // Dialog component – replaces the old openInsecureHostsModal() block
        $dialog = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/InsecureApprovalsDialog.svelte');
        $this->assertIsString($dialog);

        // Countdown is rendered via the dedicated InsecureCountdown component
        $this->assertStringContainsString('InsecureCountdown', $dialog);
        // Hosts section
        $this->assertStringContainsString('Active windows', $dialog);
        // No hosts empty state
        $this->assertStringContainsString('No hosts currently in an insecure window.', $dialog);
        // Domains empty state
        $this->assertStringContainsString('No active domain allow-list entries.', $dialog);
        // Disable action exists
        $this->assertStringContainsString('createDisableInsecureMutation', $dialog);
        // Enable/extend action exists
        $this->assertStringContainsString('createEnableInsecureMutation', $dialog);

        // WS invalidation wires insecure.requested / insecure.approved back to the
        // query cache – this replaces the old shouldRefreshInsecureModalForAction /
        // scheduleInsecureHostsModalRefresh pattern.
        $events = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        $this->assertIsString($events);
        $this->assertStringContainsString('insecure.requested', $events);
        $this->assertStringContainsString('insecure.approved', $events);
        $this->assertStringContainsString('hosts', $events, 'WS events must invalidate hosts queries');
    }
}
