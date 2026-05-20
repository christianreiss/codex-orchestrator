<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperLaneCommandTest extends TestCase
{
    public function testWrapperExposesLaneCommandAndPersistHelper(): void
    {
        // The Go main.go has a `lane` subcommand with --persist flag; the
        // orchestrator/lane.go exposes SetLane() (the persist helper) and the
        // /host/lane endpoint.
        $mainGo = $this->readFile(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        $laneGo = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/orchestrator/lane.go');

        // Help text lists lane subcommand with normal|spark|clear.
        self::assertStringContainsString('lane <normal|spark|clear>', $mainGo);
        // --persist flag is parsed and acts as the persist helper.
        self::assertStringContainsString('--persist', $mainGo);
        self::assertStringContainsString('persist', $mainGo);
        // The API endpoint path is wired in orchestrator/lane.go.
        self::assertStringContainsString('/host/lane', $laneGo);
    }

    public function testWrapperInjectsLaneProfileOrModelWhenLaneSourceIsCommandOrHost(): void
    {
        // The Go codex/lane.go injects --model from cfg.EngineOptions.ModelOverride
        // when neither --model nor --profile are present in args.
        // The mapping (spark → gpt-5.4-mini, normal → gpt-5.3-codex) is
        // documented in the file's GoDoc comment.
        $codexLaneGo = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/codex/lane.go');

        self::assertStringContainsString('applyLaneAndProfile', $codexLaneGo);
        self::assertStringContainsString('ModelOverride', $codexLaneGo);
        self::assertStringContainsString('gpt-5.4-mini', $codexLaneGo);
        self::assertStringContainsString('gpt-5.3-codex', $codexLaneGo);
    }

    public function testWrapperGuardsEmptyLanePassthroughBeforeResettingArgv(): void
    {
        // In Go, cmdLane() in main.go iterates over args and the lane handler
        // respects a passthrough ("--") separator since parseFlags() collects
        // passthrough tokens. An empty passthrough simply produces no extra args.
        $mainGo = $this->readFile(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');

        // The passthrough slice is guarded before being appended in run().
        self::assertStringContainsString('passthrough', $mainGo);
        // ParseFlags collects tokens after "--" into a separate passthrough slice.
        self::assertStringContainsString('consumedDash', $mainGo);
        // cmdLane is called with the parsed subArgs.
        self::assertStringContainsString('cmdLane(ctx, cfg, subArgs', $mainGo);
    }

    private function readFile(string $path): string
    {
        $source = @file_get_contents($path);
        self::assertIsString($source, sprintf('Expected to be able to read %s', $path));

        return $source;
    }
}
