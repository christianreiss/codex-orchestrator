import re
import unittest

import app as runner_app

# Each draft prompt tells the model which JSON keys to emit on a single prose
# line. The normalizer that parses the reply decides the same thing again, in
# code. This line is the only place the two halves of that contract meet, so a
# prompt that stops carrying it can no longer be checked at all.
REQUIRED_KEYS_RE = re.compile(r"^Required keys: (.+)$", re.MULTILINE)

MISSING_FIELD_RE = re.compile(r"missing required field: (.+)")

# Stand-in payload values. Every key a normalizer insists on is a non-empty
# string; tags is the one named key read as a list.
PROBE_STRING = "probe"
PROBE_VALUES = {"tags": [PROBE_STRING]}

# The build-up probe below adds one key per rejection, so it cannot need more
# rounds than a draft has keys. The bound only stops a normalizer that reports
# the same missing key forever from hanging the suite.
MAX_PROBE_ROUNDS = 32


def _prompt_required_keys(label, prompt):
    """The key set a prompt's 'Required keys:' line names."""
    stated = REQUIRED_KEYS_RE.findall(prompt)
    if len(stated) != 1:
        raise AssertionError(
            f"{label} emits {len(stated)} 'Required keys: ...' lines, expected exactly "
            "one; the prompt no longer states the shape it asks the model for"
        )

    keys = [key.strip() for key in stated[0].rstrip(".").split(",")]
    if not all(keys):
        raise AssertionError(f"{label} names an empty key in its 'Required keys:' line")
    if len(set(keys)) != len(keys):
        raise AssertionError(f"{label} names a key twice in its 'Required keys:' line")
    return set(keys)


def _payload(keys):
    return {key: PROBE_VALUES.get(key, PROBE_STRING) for key in keys}


def _rejected_key(normalize, data):
    """The key a normalizer refuses this payload over, or None if it accepts it."""
    try:
        normalize(data)
    except ValueError as exc:
        match = MISSING_FIELD_RE.fullmatch(str(exc))
        if match is None:
            raise
        return match.group(1)
    return None


def _hard_required_keys(normalize, named_keys):
    """Every key the normalizer raises 'missing required field' over.

    Two probes, unioned. Dropping each named key in turn from a complete payload
    is the direct reading of the contract, but on its own it can only ever name
    keys the prompt already lists. Building a payload up from nothing, feeding
    back each rejection, is what surfaces a key the normalizer demands and the
    prompt never mentions.
    """
    required = set()

    complete = _payload(named_keys)
    for key in named_keys:
        missing = _rejected_key(normalize, {k: v for k, v in complete.items() if k != key})
        if missing is not None:
            required.add(missing)

    probe = {}
    for _ in range(MAX_PROBE_ROUNDS):
        missing = _rejected_key(normalize, dict(probe))
        if missing is None:
            break
        required.add(missing)
        probe[missing] = PROBE_VALUES.get(missing, PROBE_STRING)
    else:
        raise AssertionError(
            f"{normalize.__name__} still reported a missing field after "
            f"{MAX_PROBE_ROUNDS} rounds of supplying the key it asked for"
        )

    return required


def _cases():
    """Each draft prompt paired with the normalizer that parses its reply."""
    assist_request = runner_app.SkillAssistRequest(
        auth_json={},
        messages=[runner_app.SkillAssistMessage(role="user", content="Tighten the steps.")],
        skill=runner_app.SkillAssistDraft(slug="deploy-crane", display_name="Deploy crane"),
    )
    project_request = runner_app.ProjectAssistRequest(
        auth_json={},
        slug="crane-rollout",
        project={"title": "Crane rollout"},
    )

    return (
        (
            "_skill_generation_prompt",
            runner_app._skill_generation_prompt("Draft a crane deploy skill.", "deploy-crane"),
            runner_app._normalize_generated_skill,
        ),
        (
            "_skill_assist_prompt",
            runner_app._skill_assist_prompt(assist_request),
            runner_app._normalize_assisted_skill,
        ),
        (
            "_project_assist_prompt",
            runner_app._project_assist_prompt(project_request),
            runner_app._normalize_assisted_project,
        ),
    )


class PromptContractTest(unittest.TestCase):
    def test_prompts_ask_for_exactly_the_keys_the_normalizer_returns(self):
        for label, prompt, normalize in _cases():
            with self.subTest(prompt=label):
                named_keys = _prompt_required_keys(label, prompt)

                self.assertEqual(
                    named_keys,
                    set(normalize(_payload(named_keys))),
                    f"{label} asks for a different key set than {normalize.__name__} "
                    "returns; a draft built from this prompt would be reshaped or "
                    "rejected",
                )

    def test_prompts_name_every_key_the_normalizer_rejects_a_draft_over(self):
        for label, prompt, normalize in _cases():
            with self.subTest(prompt=label):
                named_keys = _prompt_required_keys(label, prompt)

                self.assertEqual(
                    set(),
                    _hard_required_keys(normalize, named_keys) - named_keys,
                    f"{normalize.__name__} fails a draft over keys {label} never asks "
                    "the model for; the operator would see a failed draft instead of "
                    "a code error",
                )
