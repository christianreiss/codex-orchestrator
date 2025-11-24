<?php

namespace App\Http;

class Router
{
    /**
     * @var array<int, array{method: string, pattern: string, handler: callable}>
     */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): void
    {
        $this->routes[] = [
            'method' => strtoupper($method),
            'pattern' => $pattern,
            'handler' => $handler,
        ];
    }

    /**
     * @param string $method HTTP method (already normalized to upper-case)
     * @param string $path Request path (no query string)
     * @param mixed ...$args Arguments forwarded to handlers (e.g. payload)
     *
     * @return bool true when a route matched and handled the request.
     */
    public function dispatch(string $method, string $path, ...$args): bool
    {
        foreach ($this->routes as $route) {
            if ($route['method'] !== $method) {
                continue;
            }

            $pattern = $route['pattern'];
            $matches = [];
            if (!preg_match($pattern, $path, $matches)) {
                continue;
            }

            $handler = $route['handler'];

            $needsArgs = true;
            try {
                if (is_array($handler) && count($handler) === 2 && is_object($handler[0])) {
                    $ref = new \ReflectionMethod($handler[0], $handler[1]);
                } elseif (is_array($handler) && count($handler) === 2 && is_string($handler[0])) {
                    $ref = new \ReflectionMethod($handler[0], $handler[1]);
                } else {
                    $ref = new \ReflectionFunction($handler);
                }
                $needsArgs = $ref->getNumberOfParameters() > 0;
            } catch (\Throwable) {
                $needsArgs = true;
            }

            if ($needsArgs) {
                $handler($matches, ...$args);
            } else {
                $handler();
            }

            return true;
        }

        return false;
    }
}
