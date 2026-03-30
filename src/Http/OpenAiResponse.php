<?php

declare(strict_types=1);

namespace App\Http;

class OpenAiResponse
{
    private static function corsHeaders(): void
    {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Headers: Content-Type, Authorization, OpenAI-Organization');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    }

    public static function json(array $payload, int $status = 200): void
    {
        http_response_code($status);
        self::corsHeaders();
        header('Content-Type: application/json');
        echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function error(string $message, string $type, int $status, ?string $code = null, ?string $param = null): void
    {
        $error = [
            'message' => $message,
            'type' => $type,
        ];

        if ($param !== null) {
            $error['param'] = $param;
        }

        if ($code !== null) {
            $error['code'] = $code;
        }

        self::json(['error' => $error], $status);
    }

    public static function stream(array $payload): void
    {
        self::streamEvents([
            ['data' => $payload],
        ]);
    }

    /**
     * @param list<array{data: array, event?: string}> $events
     */
    public static function streamEvents(array $events): void
    {
        http_response_code(200);
        self::corsHeaders();
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');

        foreach ($events as $event) {
            if (isset($event['event']) && $event['event'] !== '') {
                echo 'event: ' . $event['event'] . "\n";
            }

            echo 'data: ' . json_encode($event['data'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n\n";
            if (ob_get_level() > 0) {
                ob_flush();
            }
            flush();
        }

        echo "data: [DONE]\n\n";
        if (ob_get_level() > 0) {
            ob_flush();
        }
        flush();

        exit;
    }

    public static function options(): void
    {
        http_response_code(204);
        self::corsHeaders();
        exit;
    }
}
