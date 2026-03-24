<?php

declare(strict_types=1);

use App\Exceptions\ValidationException;
use App\Services\ProjectNormalizer;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class ProjectNormalizerTest extends TestCase
{
    private ProjectNormalizer $normalizer;

    protected function setUp(): void
    {
        $this->normalizer = new ProjectNormalizer();
    }

    // -------------------------------------------------------------------------
    // normalizeSlug
    // -------------------------------------------------------------------------

    public function testNormalizeSlugReturnsValidSlug(): void
    {
        $this->assertSame('my-project', $this->normalizer->normalizeSlug('my-project'));
    }

    public function testNormalizeSlugTrimsWhitespace(): void
    {
        $this->assertSame('abc', $this->normalizer->normalizeSlug('  abc  '));
    }

    public function testNormalizeSlugAllowsUnderscoresAndHyphens(): void
    {
        $this->assertSame('my_project-v2', $this->normalizer->normalizeSlug('my_project-v2'));
    }

    public function testNormalizeSlugAllowsAlphanumericOnly(): void
    {
        $this->assertSame('Project123', $this->normalizer->normalizeSlug('Project123'));
    }

    public function testNormalizeSlugThrowsForEmptyString(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeSlug('');
    }

    public function testNormalizeSlugThrowsForWhitespaceOnly(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeSlug('   ');
    }

    public function testNormalizeSlugThrowsWhenStartsWithHyphen(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeSlug('-bad-start');
    }

    public function testNormalizeSlugThrowsWhenStartsWithUnderscore(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeSlug('_bad');
    }

    public function testNormalizeSlugThrowsForSpacesInMiddle(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeSlug('has space');
    }

    public function testNormalizeSlugThrowsForSpecialChars(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeSlug('bad@slug');
    }

    public function testNormalizeSlugErrorKeyIsSlug(): void
    {
        try {
            $this->normalizer->normalizeSlug('');
            $this->fail('Expected ValidationException');
        } catch (ValidationException $e) {
            $this->assertArrayHasKey('slug', $e->getErrors());
        }
    }

    // -------------------------------------------------------------------------
    // normalizeAbout
    // -------------------------------------------------------------------------

    public function testNormalizeAboutReturnsNullForNull(): void
    {
        $this->assertNull($this->normalizer->normalizeAbout(null));
    }

    public function testNormalizeAboutReturnsNullForEmptyArray(): void
    {
        $this->assertNull($this->normalizer->normalizeAbout([]));
    }

    public function testNormalizeAboutThrowsForNonArray(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeAbout('not an array');
    }

    public function testNormalizeAboutReturnsTrimmedStringValues(): void
    {
        $result = $this->normalizer->normalizeAbout(['key' => '  value  ']);
        $this->assertSame(['key' => 'value'], $result);
    }

    public function testNormalizeAboutPreservesArrayValues(): void
    {
        $result = $this->normalizer->normalizeAbout(['tags' => ['a', 'b']]);
        $this->assertSame(['tags' => ['a', 'b']], $result);
    }

    public function testNormalizeAboutPreservesNullValues(): void
    {
        $result = $this->normalizer->normalizeAbout(['key' => null]);
        $this->assertSame(['key' => null], $result);
    }

    public function testNormalizeAboutSkipsNumericKeys(): void
    {
        $result = $this->normalizer->normalizeAbout([0 => 'value', 'key' => 'kept']);
        $this->assertSame(['key' => 'kept'], $result);
    }

    public function testNormalizeAboutSkipsEmptyStringKeys(): void
    {
        $result = $this->normalizer->normalizeAbout(['' => 'ignored', 'ok' => 'kept']);
        $this->assertSame(['ok' => 'kept'], $result);
    }

    public function testNormalizeAboutReturnsNullWhenAllKeysSkipped(): void
    {
        $result = $this->normalizer->normalizeAbout([0 => 'a', 1 => 'b']);
        $this->assertNull($result);
    }

    // -------------------------------------------------------------------------
    // normalizeRoster
    // -------------------------------------------------------------------------

    public function testNormalizeRosterReturnsTrimmedString(): void
    {
        $this->assertSame('# Team', $this->normalizer->normalizeRoster('  # Team  '));
    }

    public function testNormalizeRosterAllowsEmptyString(): void
    {
        $this->assertSame('', $this->normalizer->normalizeRoster(''));
    }

    public function testNormalizeRosterThrowsWhenExceedsMaxLength(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeRoster(str_repeat('a', 65536));
    }

    public function testNormalizeRosterAcceptsExactlyMaxLength(): void
    {
        $result = $this->normalizer->normalizeRoster(str_repeat('a', 65535));
        $this->assertSame(65535, strlen($result));
    }

    // -------------------------------------------------------------------------
    // normalizeNotePayload
    // -------------------------------------------------------------------------

    public function testNormalizeNotePayloadReturnsHeaderAndBody(): void
    {
        [$header, $body] = $this->normalizer->normalizeNotePayload(['header' => 'My Note', 'body' => 'Some content']);
        $this->assertSame('My Note', $header);
        $this->assertSame('Some content', $body);
    }

    public function testNormalizeNotePayloadTrimsValues(): void
    {
        [$header, $body] = $this->normalizer->normalizeNotePayload(['header' => '  H  ', 'body' => '  B  ']);
        $this->assertSame('H', $header);
        $this->assertSame('B', $body);
    }

    public function testNormalizeNotePayloadThrowsWhenHeaderMissing(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeNotePayload(['body' => 'content']);
    }

    public function testNormalizeNotePayloadThrowsWhenBodyMissing(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeNotePayload(['header' => 'title']);
    }

    public function testNormalizeNotePayloadThrowsWhenBothMissing(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeNotePayload([]);
    }

    public function testNormalizeNotePayloadErrorKeysAreCorrect(): void
    {
        try {
            $this->normalizer->normalizeNotePayload([]);
            $this->fail('Expected ValidationException');
        } catch (ValidationException $e) {
            $errors = $e->getErrors();
            $this->assertArrayHasKey('header', $errors);
            $this->assertArrayHasKey('body', $errors);
        }
    }

    // -------------------------------------------------------------------------
    // normalizeTodoPayload
    // -------------------------------------------------------------------------

    public function testNormalizeTodoPayloadReturnsTitleAndDetail(): void
    {
        [$title, $detail] = $this->normalizer->normalizeTodoPayload(['title' => 'Fix bug', 'detail' => 'Details here']);
        $this->assertSame('Fix bug', $title);
        $this->assertSame('Details here', $detail);
    }

    public function testNormalizeTodoPayloadAllowsEmptyDetail(): void
    {
        [$title, $detail] = $this->normalizer->normalizeTodoPayload(['title' => 'Task']);
        $this->assertSame('Task', $title);
        $this->assertSame('', $detail);
    }

    public function testNormalizeTodoPayloadTrimsValues(): void
    {
        [$title, $detail] = $this->normalizer->normalizeTodoPayload(['title' => '  T  ', 'detail' => '  D  ']);
        $this->assertSame('T', $title);
        $this->assertSame('D', $detail);
    }

    public function testNormalizeTodoPayloadThrowsWhenTitleMissing(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeTodoPayload([]);
    }

    public function testNormalizeTodoPayloadErrorKeyIsTitle(): void
    {
        try {
            $this->normalizer->normalizeTodoPayload(['title' => '']);
            $this->fail('Expected ValidationException');
        } catch (ValidationException $e) {
            $this->assertArrayHasKey('title', $e->getErrors());
        }
    }

    // -------------------------------------------------------------------------
    // normalizeFilePayload
    // -------------------------------------------------------------------------

    public function testNormalizeFilePayloadReturnsAllFields(): void
    {
        [$name, $desc, $content, $mime] = $this->normalizer->normalizeFilePayload([
            'stored_name' => 'readme.md',
            'description' => 'A readme',
            'content' => 'Hello',
            'mime_type' => 'text/markdown',
        ]);
        $this->assertSame('readme.md', $name);
        $this->assertSame('A readme', $desc);
        $this->assertSame('Hello', $content);
        $this->assertSame('text/markdown', $mime);
    }

    public function testNormalizeFilePayloadUsesNameFallback(): void
    {
        [$name] = $this->normalizer->normalizeFilePayload(['name' => 'file.txt', 'content' => 'data']);
        $this->assertSame('file.txt', $name);
    }

    public function testNormalizeFilePayloadUsesTextFallback(): void
    {
        [, , $content] = $this->normalizer->normalizeFilePayload(['stored_name' => 'f.txt', 'text' => 'text data']);
        $this->assertSame('text data', $content);
    }

    public function testNormalizeFilePayloadThrowsWhenContentEmpty(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeFilePayload(['stored_name' => 'f.txt', 'content' => '']);
    }

    public function testNormalizeFilePayloadReturnsNullForMissingOptionals(): void
    {
        [$name, $desc, $content, $mime] = $this->normalizer->normalizeFilePayload([
            'stored_name' => 'f.txt',
            'content' => 'data',
        ]);
        $this->assertNull($desc);
        $this->assertNull($mime);
    }

    // -------------------------------------------------------------------------
    // normalizeFeedbackPayload
    // -------------------------------------------------------------------------

    public function testNormalizeFeedbackPayloadReturnsValidData(): void
    {
        [$type, $title, $body] = $this->normalizer->normalizeFeedbackPayload([
            'type' => 'bug',
            'title' => 'Crash on save',
            'body' => 'Steps to reproduce...',
        ]);
        $this->assertSame('bug', $type);
        $this->assertSame('Crash on save', $title);
        $this->assertSame('Steps to reproduce...', $body);
    }

    public function testNormalizeFeedbackPayloadDefaultsTypeToFeature(): void
    {
        [$type] = $this->normalizer->normalizeFeedbackPayload(['title' => 'T', 'body' => 'B']);
        $this->assertSame('feature', $type);
    }

    public function testNormalizeFeedbackPayloadNormalizesTypeToLowercase(): void
    {
        [$type] = $this->normalizer->normalizeFeedbackPayload(['type' => 'BUG', 'title' => 'T', 'body' => 'B']);
        $this->assertSame('bug', $type);
    }

    public function testNormalizeFeedbackPayloadAcceptsNoteType(): void
    {
        [$type] = $this->normalizer->normalizeFeedbackPayload(['type' => 'note', 'title' => 'T', 'body' => 'B']);
        $this->assertSame('note', $type);
    }

    public function testNormalizeFeedbackPayloadThrowsForInvalidType(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeFeedbackPayload(['type' => 'invalid', 'title' => 'T', 'body' => 'B']);
    }

    public function testNormalizeFeedbackPayloadThrowsWhenTitleMissing(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeFeedbackPayload(['type' => 'bug', 'body' => 'B']);
    }

    public function testNormalizeFeedbackPayloadThrowsWhenBodyMissing(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeFeedbackPayload(['type' => 'feature', 'title' => 'T']);
    }

    // -------------------------------------------------------------------------
    // normalizeStoredName
    // -------------------------------------------------------------------------

    public function testNormalizeStoredNameReturnsSimpleName(): void
    {
        $this->assertSame('file.txt', $this->normalizer->normalizeStoredName('file.txt'));
    }

    public function testNormalizeStoredNameNormalizesForwardSlashes(): void
    {
        $this->assertSame('path/to/file.txt', $this->normalizer->normalizeStoredName('path//to///file.txt'));
    }

    public function testNormalizeStoredNameConvertsBackslashesToForwardSlashes(): void
    {
        $this->assertSame('path/to/file.txt', $this->normalizer->normalizeStoredName('path\\to\\file.txt'));
    }

    public function testNormalizeStoredNameStripsLeadingSlash(): void
    {
        $this->assertSame('path/file.txt', $this->normalizer->normalizeStoredName('/path/file.txt'));
    }

    public function testNormalizeStoredNameThrowsForEmptyString(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeStoredName('');
    }

    public function testNormalizeStoredNameThrowsForDotSegment(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeStoredName('path/./file.txt');
    }

    public function testNormalizeStoredNameThrowsForDotDotSegment(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeStoredName('path/../file.txt');
    }

    public function testNormalizeStoredNameThrowsForOnlySlashes(): void
    {
        $this->expectException(ValidationException::class);
        $this->normalizer->normalizeStoredName('///');
    }

    // -------------------------------------------------------------------------
    // normalizeOptionalString
    // -------------------------------------------------------------------------

    public function testNormalizeOptionalStringReturnsNullForNull(): void
    {
        $this->assertNull($this->normalizer->normalizeOptionalString(null));
    }

    public function testNormalizeOptionalStringReturnsNullForEmptyString(): void
    {
        $this->assertNull($this->normalizer->normalizeOptionalString(''));
    }

    public function testNormalizeOptionalStringReturnsNullForWhitespaceOnly(): void
    {
        $this->assertNull($this->normalizer->normalizeOptionalString('   '));
    }

    public function testNormalizeOptionalStringReturnsTrimmedValue(): void
    {
        $this->assertSame('hello', $this->normalizer->normalizeOptionalString('  hello  '));
    }

    public function testNormalizeOptionalStringReturnsNullForBool(): void
    {
        $this->assertNull($this->normalizer->normalizeOptionalString(true));
        $this->assertNull($this->normalizer->normalizeOptionalString(false));
    }

    public function testNormalizeOptionalStringReturnsNullForArray(): void
    {
        $this->assertNull($this->normalizer->normalizeOptionalString(['a']));
    }

    public function testNormalizeOptionalStringAcceptsNumeric(): void
    {
        $this->assertSame('42', $this->normalizer->normalizeOptionalString(42));
    }
}
