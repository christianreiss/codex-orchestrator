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
        $fromEmail = trim($fromEmail);
        if ($fromEmail === '') {
            return false;
        }

        $from = $fromName !== null && trim($fromName) !== ''
            ? sprintf('%s <%s>', trim($fromName), $fromEmail)
            : $fromEmail;

        $headers = [
            'From: ' . $from,
            'Reply-To: ' . $from,
            'Content-Type: text/plain; charset=utf-8',
        ];

        return mail($to, $subject, $body, implode("\r\n", $headers));
    }
}
