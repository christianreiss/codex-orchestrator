<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminWsClientContractTest extends TestCase
{
    public function testClientBootstrapsFromWsInfoAndTracksCursor(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/client.ts');
        $this->assertIsString($src);

        $this->assertStringContainsString('/admin/ws/info', $src);
        $this->assertStringContainsString('last_event_id', $src);
        $this->assertStringContainsString('state.lastEventId', $src);
        $this->assertStringContainsString('last_event_id=${encodeURIComponent(String(state.lastEventId))}', $src);
    }

    public function testClientEmitsStatusAndEventChannels(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/client.ts');
        $this->assertIsString($src);

        $this->assertStringContainsString('WsEvent', $src);
        $this->assertStringContainsString('WsClientHandle', $src);
        $this->assertStringContainsString('status.set("connecting")', $src);
        $this->assertStringContainsString('status.set("open")', $src);
        $this->assertStringContainsString('status.set("closed")', $src);
        $this->assertStringContainsString('events.set(payload)', $src);
        $this->assertStringContainsString('scheduleReconnect()', $src);
        $this->assertStringContainsString('state.enabled', $src);
    }
}
