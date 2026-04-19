<?php

declare(strict_types=1);

/**
 * Build the online-manual search index.
 *
 * Walks public/admin/manual/articles/*.md, tokenises title + section + headings + body,
 * and writes public/admin/manual/search-index.json. The index is an inverted map of
 * token -> [docId, ...] plus a per-doc array with title/section/anchors for rendering.
 *
 * Run after editing any article. Idempotent.
 */

$root = dirname(__DIR__);
$manualDir = $root . '/public/admin/manual';
$articlesDir = $manualDir . '/articles';
$manifestPath = $manualDir . '/manifest.json';
$outPath = $manualDir . '/search-index.json';

if (!is_dir($articlesDir)) {
    fwrite(STDERR, "articles directory not found: $articlesDir\n");
    exit(1);
}

$manifest = json_decode((string) @file_get_contents($manifestPath), true);
if (!is_array($manifest) || !isset($manifest['articles']) || !is_array($manifest['articles'])) {
    fwrite(STDERR, "invalid or missing manifest.json\n");
    exit(1);
}

$stopwords = array_flip([
    'the','a','an','and','or','of','to','in','is','it','for','on','with','by','from','as',
    'at','be','are','was','were','this','that','these','those','but','not','if','then','else',
    'so','do','does','did','has','have','had','can','could','should','would','will','you',
    'your','we','our','their','they','them','he','she','its','he','her','his','him','i',
    'me','my','mine','us','also','into','over','under','per','via','just','only','than',
    'when','while','where','which','who','whom','why','how','about','any','all','each',
    'every','no','none','both','once','here','there','because','same','other','such','own',
    'most','more','some','many','much','even','again','further','ok','yes','no','off','on',
]);

$tokenize = static function (string $text) use ($stopwords): array {
    $text = strtolower($text);
    $text = preg_replace('/`[^`]*`/', ' ', $text) ?? $text;
    $text = preg_replace('/[^a-z0-9+\.]+/', ' ', $text) ?? $text;
    $raw = preg_split('/\s+/', trim($text));
    if ($raw === false) {
        return [];
    }
    $out = [];
    foreach ($raw as $token) {
        if ($token === '' || strlen($token) < 2 || strlen($token) > 48) {
            continue;
        }
        if (isset($stopwords[$token])) {
            continue;
        }
        $out[$token] = true;
    }
    return array_keys($out);
};

$slugifyHeading = static function (string $text): string {
    $text = strtolower(trim($text));
    $text = preg_replace('/[^\w\s-]/u', '', $text) ?? $text;
    $text = preg_replace('/\s+/', '-', $text) ?? $text;
    $text = preg_replace('/-+/', '-', $text) ?? $text;
    $out = substr($text, 0, 80);
    return $out === '' ? 'heading' : $out;
};

$docs = [];
$index = [];
$docIdx = 0;

foreach ($manifest['articles'] as $entry) {
    if (!is_array($entry)) continue;
    $slugRaw = $entry['slug'] ?? '';
    $slug = is_string($slugRaw) ? $slugRaw : '';
    if ($slug === '') continue;
    $path = $articlesDir . '/' . $slug . '.md';
    if (!is_readable($path)) {
        fwrite(STDERR, "missing article: $slug ($path)\n");
        continue;
    }
    $raw = file_get_contents($path);
    if ($raw === false) {
        fwrite(STDERR, "unreadable article: $slug\n");
        continue;
    }
    $body = $raw;
    if (str_starts_with($raw, '---')) {
        $end = strpos($raw, "\n---", 3);
        if ($end !== false) {
            $body = substr($raw, $end + 4);
        }
    }

    $titleRaw = $entry['title'] ?? $slug;
    $title = is_string($titleRaw) ? $titleRaw : $slug;
    $sectionRaw = $entry['section'] ?? '';
    $section = is_string($sectionRaw) ? $sectionRaw : '';
    $summaryRaw = $entry['summary'] ?? '';
    $summary = is_string($summaryRaw) ? $summaryRaw : '';

    // Extract headings (h2, h3) for anchor deep-links.
    $anchors = [];
    $usedIds = [];
    if (preg_match_all('/^(#{2,3})\s+(.+?)\s*$/m', $body, $matches, PREG_SET_ORDER) > 0) {
        foreach ($matches as $m) {
            $headingText = trim(preg_replace('/`([^`]*)`/', '$1', $m[2]) ?? $m[2]);
            $baseId = $slugifyHeading($headingText);
            $id = $baseId;
            $n = 2;
            while (isset($usedIds[$id])) {
                $id = $baseId . '-' . $n++;
            }
            $usedIds[$id] = true;
            $anchors[] = ['id' => $id, 'text' => $headingText, 'level' => strlen($m[1])];
        }
    }

    $doc = [
        'slug' => $slug,
        'title' => $title,
        'section' => $section,
        'summary' => $summary,
        'anchors' => $anchors,
    ];
    $docs[] = $doc;

    $tokens = [];
    foreach ($tokenize($title) as $t) $tokens[$t] = true;
    foreach ($tokenize($section) as $t) $tokens[$t] = true;
    foreach ($tokenize($summary) as $t) $tokens[$t] = true;
    foreach ($anchors as $anc) {
        foreach ($tokenize($anc['text']) as $t) $tokens[$t] = true;
    }
    foreach ($tokenize($body) as $t) $tokens[$t] = true;

    foreach (array_keys($tokens) as $token) {
        if (!isset($index[$token])) {
            $index[$token] = [];
        }
        $index[$token][] = $docIdx;
    }
    $docIdx++;
}

ksort($index);

$output = [
    'version' => gmdate('Y-m-d\TH:i:s\Z'),
    'docs' => $docs,
    'index' => $index,
];

$json = json_encode($output, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
if ($json === false) {
    fwrite(STDERR, "failed to encode search index: " . json_last_error_msg() . "\n");
    exit(1);
}
file_put_contents($outPath, $json . "\n");
fwrite(STDOUT, sprintf("wrote %s — %d docs, %d tokens\n", $outPath, count($docs), count($index)));
