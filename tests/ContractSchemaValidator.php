<?php

declare(strict_types=1);

/**
 * Small JSON-schema subset validator for contract fixtures.
 * Supported keywords: type, required, properties, additionalProperties,
 * enum, const, items, minimum, maximum, minItems, maxItems, pattern, anyOf, oneOf.
 */
final class ContractSchemaValidator
{
    /**
     * @return list<string>
     */
    public static function validate(mixed $value, array $schema, string $path = '$'): array
    {
        $errors = [];
        self::validateNode($value, $schema, $path, $errors);

        return $errors;
    }

    /**
     * @param list<string> $errors
     */
    private static function validateNode(mixed $value, array $schema, string $path, array &$errors): void
    {
        if (isset($schema['anyOf']) && is_array($schema['anyOf'])) {
            $matched = false;
            $anyOfErrors = [];
            foreach ($schema['anyOf'] as $idx => $candidate) {
                if (!is_array($candidate)) {
                    continue;
                }
                $candidateErrors = [];
                self::validateNode($value, $candidate, $path, $candidateErrors);
                if ($candidateErrors === []) {
                    $matched = true;
                    break;
                }
                foreach (array_slice($candidateErrors, 0, 2) as $err) {
                    $anyOfErrors[] = "anyOf[$idx] $err";
                }
            }
            if (!$matched) {
                $errors[] = "$path: value did not match anyOf candidate";
                foreach (array_slice($anyOfErrors, 0, 4) as $detail) {
                    $errors[] = "$path: $detail";
                }
                return;
            }
        }

        if (isset($schema['oneOf']) && is_array($schema['oneOf'])) {
            $matches = 0;
            foreach ($schema['oneOf'] as $candidate) {
                if (!is_array($candidate)) {
                    continue;
                }
                $candidateErrors = [];
                self::validateNode($value, $candidate, $path, $candidateErrors);
                if ($candidateErrors === []) {
                    $matches++;
                }
            }
            if ($matches !== 1) {
                $errors[] = "$path: expected exactly one oneOf match, got $matches";
                return;
            }
        }

        if (array_key_exists('const', $schema) && $value !== $schema['const']) {
            $expected = self::exportValue($schema['const']);
            $actual = self::exportValue($value);
            $errors[] = "$path: expected const $expected, got $actual";
            return;
        }

        if (isset($schema['enum']) && is_array($schema['enum'])) {
            $found = false;
            foreach ($schema['enum'] as $allowed) {
                if ($value === $allowed) {
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                $errors[] = "$path: value is not in enum";
                return;
            }
        }

        if (isset($schema['type'])) {
            $types = is_array($schema['type']) ? $schema['type'] : [$schema['type']];
            $typeMatch = false;
            foreach ($types as $type) {
                if (is_string($type) && self::matchesType($value, $type)) {
                    $typeMatch = true;
                    break;
                }
            }
            if (!$typeMatch) {
                $errors[] = "$path: type mismatch";
                return;
            }
        }

        if (is_array($value) && self::isObject($value)) {
            $required = $schema['required'] ?? null;
            if (is_array($required)) {
                foreach ($required as $requiredKey) {
                    if (!is_string($requiredKey)) {
                        continue;
                    }
                    if (!array_key_exists($requiredKey, $value)) {
                        $errors[] = "$path: missing required property \"$requiredKey\"";
                    }
                }
            }

            $properties = $schema['properties'] ?? null;
            if (is_array($properties)) {
                foreach ($properties as $key => $propertySchema) {
                    if (!is_string($key) || !array_key_exists($key, $value) || !is_array($propertySchema)) {
                        continue;
                    }
                    self::validateNode($value[$key], $propertySchema, $path . '.' . $key, $errors);
                }
            }

            $additional = $schema['additionalProperties'] ?? true;
            if ($additional === false && is_array($properties)) {
                foreach ($value as $key => $_) {
                    if (!is_string($key)) {
                        continue;
                    }
                    if (!array_key_exists($key, $properties)) {
                        $errors[] = "$path: unexpected property \"$key\"";
                    }
                }
            }
        }

        if (is_array($value) && self::isArray($value)) {
            if (isset($schema['minItems']) && is_int($schema['minItems']) && count($value) < $schema['minItems']) {
                $errors[] = "$path: expected at least {$schema['minItems']} items";
            }
            if (isset($schema['maxItems']) && is_int($schema['maxItems']) && count($value) > $schema['maxItems']) {
                $errors[] = "$path: expected at most {$schema['maxItems']} items";
            }
            if (isset($schema['items']) && is_array($schema['items'])) {
                foreach ($value as $index => $item) {
                    self::validateNode($item, $schema['items'], $path . '[' . $index . ']', $errors);
                }
            }
        }

        if ((is_int($value) || is_float($value)) && isset($schema['minimum']) && is_numeric($schema['minimum'])) {
            if ((float) $value < (float) $schema['minimum']) {
                $errors[] = "$path: expected minimum {$schema['minimum']}";
            }
        }
        if ((is_int($value) || is_float($value)) && isset($schema['maximum']) && is_numeric($schema['maximum'])) {
            if ((float) $value > (float) $schema['maximum']) {
                $errors[] = "$path: expected maximum {$schema['maximum']}";
            }
        }

        if (is_string($value) && isset($schema['pattern']) && is_string($schema['pattern'])) {
            $pattern = '/' . str_replace('/', '\\/', $schema['pattern']) . '/';
            if (@preg_match($pattern, $value) !== 1) {
                $errors[] = "$path: string does not match pattern {$schema['pattern']}";
            }
        }
    }

    private static function matchesType(mixed $value, string $type): bool
    {
        return match ($type) {
            'object' => is_array($value) && self::isObject($value),
            'array' => is_array($value) && self::isArray($value),
            'string' => is_string($value),
            'integer' => is_int($value),
            'number' => is_int($value) || is_float($value),
            'boolean' => is_bool($value),
            'null' => $value === null,
            default => false,
        };
    }

    private static function isObject(array $value): bool
    {
        if ($value === []) {
            return true;
        }

        return !array_is_list($value);
    }

    private static function isArray(array $value): bool
    {
        if ($value === []) {
            return true;
        }

        return array_is_list($value);
    }

    private static function exportValue(mixed $value): string
    {
        if (is_string($value)) {
            return '"' . $value . '"';
        }

        return var_export($value, true);
    }
}
