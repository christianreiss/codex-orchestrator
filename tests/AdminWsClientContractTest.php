<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminWsClientContractTest extends TestCase
{
    public function testClientBootstrapsFromWsInfoAndTracksCursor(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/admin-ws.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('/admin/ws/info', $js);
        $this->assertStringContainsString("url.searchParams.set('since', state.lastEventId)", $js);
        $this->assertStringContainsString('const lastEventId = Number(data.last_event_id || 0);', $js);
        $this->assertStringContainsString('state.lastEventId = String(lastEventId);', $js);
    }

    public function testClientEmitsStatusAndEventChannels(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/admin-ws.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('isEventEnvelope', $js);
        $this->assertStringContainsString('isResponseEnvelope', $js);
        $this->assertStringContainsString('isErrorEnvelope', $js);
        $this->assertStringContainsString('pendingRequests: new Map()', $js);
        $this->assertStringContainsString("emit('admin-ws-status', { status: 'connecting' })", $js);
        $this->assertStringContainsString("emit('admin-ws-status', { status: 'open' })", $js);
        $this->assertStringContainsString("emit('admin-ws-status', { status: 'closed' })", $js);
        $this->assertStringContainsString("emit('admin-ws-event', message.event)", $js);
        $this->assertStringContainsString("emit('admin-ws-message', message)", $js);
        $this->assertStringContainsString("window.__adminWsRequest = request", $js);
        $this->assertStringContainsString("window.__adminWsCanRequest = canRequest", $js);
        $this->assertStringContainsString("window.__adminWsIsEnabled = () => state.enabled", $js);
        $this->assertStringContainsString('scheduleReconnect()', $js);
    }
}
