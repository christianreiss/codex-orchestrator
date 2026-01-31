<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Support;

class Mailer
{
    public function send(string $to, string $subject, string $body, string $fromEmail, ?string $fromName = null): bool
    {
        $to = trim($to);
        $fromEmail = trim($fromEmail);
        $fromName = $fromName !== null ? trim($fromName) : null;

        if ($to === '' || $fromEmail === '') {
            return false;
        }

        if ($this->hasHeaderInjection($to)
            || $this->hasHeaderInjection($subject)
            || $this->hasHeaderInjection($fromEmail)
            || ($fromName !== null && $this->hasHeaderInjection($fromName))
        ) {
            return false;
        }

        $from = $fromName !== null && $fromName !== ''
            ? sprintf('%s <%s>', $fromName, $fromEmail)
            : $fromEmail;

        $headers = [
            'From: ' . $from,
            'Reply-To: ' . $from,
            'Content-Type: text/plain; charset=utf-8',
        ];

        return mail($to, $subject, $body, implode("\r\n", $headers));
    }

    private function hasHeaderInjection(string $value): bool
    {
        return str_contains($value, "\r") || str_contains($value, "\n");
    }
}
