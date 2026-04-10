<?php

declare(strict_types=1);

namespace App\Http;

class AnthropicResponse
{
    private static function corsHeaders(): void
    {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Headers: Content-Type, Authorization, x-api-key, anthropic-version');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    }

    public static function json(array $payload, int $status = 200): never
    {
        http_response_code($status);
        self::corsHeaders();
        header('Content-Type: application/json');
        echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function error(string $message, string $type, int $status): never
    {
        self::json([
            'type' => 'error',
            'error' => [
                'type' => $type,
                'message' => $message,
            ],
        ], $status);
    }

    /**
     * @param list<array{event: string, data: array}> $events
     */
    public static function streamEvents(array $events): never
    {
        http_response_code(200);
        self::corsHeaders();
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');

        foreach ($events as $event) {
            echo 'event: ' . $event['event'] . "\n";
            echo 'data: ' . json_encode($event['data'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n\n";
            if (ob_get_level() > 0) {
                ob_flush();
            }
            flush();
        }

        exit;
    }

    public static function options(): never
    {
        http_response_code(204);
        self::corsHeaders();
        exit;
    }
}
