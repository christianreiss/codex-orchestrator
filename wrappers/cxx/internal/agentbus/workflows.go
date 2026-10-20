package agentbus

import (
	"context"
	"encoding/json"
	"errors"
)

var workflowPaths = map[string]string{
	"agent_workflow_create":       "workflows/create",
	"agent_workflow_revise":       "workflows/revise",
	"agent_workflow_archive":      "workflows/archive",
	"agent_workflow_run_create":   "workflows/run-create",
	"agent_workflow_run_control":  "workflows/run-control",
	"agent_workflow_run_current":  "workflows/run-current",
	"agent_workflow_invite":       "workflows/invite",
	"agent_workflow_membership":   "workflows/membership",
	"agent_workflow_task_claim":   "workflows/task-claim",
	"agent_workflow_task_update":  "workflows/task-update",
	"agent_workflow_run_note":     "workflows/run-note",
	"agent_workflow_run_finish":   "workflows/run-finish",
	"agent_workflow_run_evaluate": "workflows/run-evaluate",
}

func workflowTools() []map[string]any {
	var out []map[string]any
	if err := json.Unmarshal([]byte(workflowToolDefinitions), &out); err != nil {
		panic(err)
	}
	return out
}

func callWorkflowTool(ctx context.Context, client *sessionClient, name string, args map[string]any) (map[string]any, error) {
	path, ok := workflowPaths[name]
	if !ok {
		return nil, errors.New("unknown workflow operation")
	}
	var out map[string]any
	err := client.post(ctx, path, args, &out)
	return out, err
}

const workflowToolDefinitions = `[
  {
    "name": "agent_workflow_create",
    "description": "Create a reusable workflow with one stable goal, success criteria, inputs, ordered tasks and knowledge. Read skill://workflows first. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "client_request_id": {
          "type": "string",
          "format": "uuid"
        },
        "slug": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
        },
        "document": {
          "type": "object",
          "properties": {
            "schema_version": {
              "const": 1,
              "type": "number"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "summary": {
              "type": "string",
              "maxLength": 65536
            },
            "goal": {
              "type": "object",
              "properties": {
                "statement": {
                  "type": "string",
                  "maxLength": 65536
                },
                "success_criteria": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                      },
                      "text": {
                        "type": "string",
                        "maxLength": 65536
                      }
                    },
                    "required": [
                      "id",
                      "text"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1,
                  "maxItems": 100
                }
              },
              "required": [
                "statement",
                "success_criteria"
              ],
              "additionalProperties": false
            },
            "inputs": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "label": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 255
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "string",
                      "number",
                      "boolean",
                      "enum"
                    ]
                  },
                  "required": {
                    "type": "boolean"
                  },
                  "default": {},
                  "options": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1
                    },
                    "minItems": 1,
                    "maxItems": 100
                  },
                  "description": {
                    "type": "string",
                    "maxLength": 65536
                  }
                },
                "required": [
                  "key",
                  "label",
                  "type",
                  "required"
                ],
                "additionalProperties": false
              },
              "maxItems": 64
            },
            "tasks": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 255
                  },
                  "instructions": {
                    "type": "string",
                    "maxLength": 65536
                  },
                  "acceptance_criteria": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "maxLength": 65536
                    },
                    "minItems": 1,
                    "maxItems": 100
                  },
                  "depends_on": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                    },
                    "maxItems": 200
                  },
                  "knowledge_ids": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                    },
                    "maxItems": 100
                  },
                  "execution_hint": {
                    "type": "string",
                    "maxLength": 65536
                  }
                },
                "required": [
                  "id",
                  "title",
                  "instructions",
                  "acceptance_criteria",
                  "depends_on",
                  "knowledge_ids"
                ],
                "additionalProperties": false
              },
              "minItems": 1,
              "maxItems": 200
            },
            "knowledge": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 255
                  },
                  "inline": {
                    "type": "string",
                    "maxLength": 65536
                  },
                  "reference": {
                    "type": "object",
                    "properties": {
                      "uri": {
                        "type": "string",
                        "maxLength": 2048
                      },
                      "read_hint": {
                        "type": "string",
                        "maxLength": 65536
                      }
                    },
                    "required": [
                      "uri"
                    ],
                    "additionalProperties": false
                  }
                },
                "required": [
                  "id",
                  "title"
                ],
                "additionalProperties": false
              },
              "maxItems": 100
            }
          },
          "required": [
            "schema_version",
            "title",
            "summary",
            "goal",
            "inputs",
            "tasks",
            "knowledge"
          ],
          "additionalProperties": false
        },
        "reason": {
          "type": "string",
          "maxLength": 65536
        }
      },
      "required": [
        "client_request_id",
        "slug",
        "document",
        "reason"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "agent_workflow_revise",
    "description": "Publish a new immutable workflow version; the goal and success criteria cannot change. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "client_request_id": {
          "type": "string",
          "format": "uuid"
        },
        "workflow_id": {
          "type": "string",
          "minLength": 1
        },
        "expected_workflow_version": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "document": {
          "type": "object",
          "properties": {
            "schema_version": {
              "const": 1,
              "type": "number"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "summary": {
              "type": "string",
              "maxLength": 65536
            },
            "goal": {
              "type": "object",
              "properties": {
                "statement": {
                  "type": "string",
                  "maxLength": 65536
                },
                "success_criteria": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                      },
                      "text": {
                        "type": "string",
                        "maxLength": 65536
                      }
                    },
                    "required": [
                      "id",
                      "text"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1,
                  "maxItems": 100
                }
              },
              "required": [
                "statement",
                "success_criteria"
              ],
              "additionalProperties": false
            },
            "inputs": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "label": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 255
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "string",
                      "number",
                      "boolean",
                      "enum"
                    ]
                  },
                  "required": {
                    "type": "boolean"
                  },
                  "default": {},
                  "options": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1
                    },
                    "minItems": 1,
                    "maxItems": 100
                  },
                  "description": {
                    "type": "string",
                    "maxLength": 65536
                  }
                },
                "required": [
                  "key",
                  "label",
                  "type",
                  "required"
                ],
                "additionalProperties": false
              },
              "maxItems": 64
            },
            "tasks": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 255
                  },
                  "instructions": {
                    "type": "string",
                    "maxLength": 65536
                  },
                  "acceptance_criteria": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "maxLength": 65536
                    },
                    "minItems": 1,
                    "maxItems": 100
                  },
                  "depends_on": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                    },
                    "maxItems": 200
                  },
                  "knowledge_ids": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                    },
                    "maxItems": 100
                  },
                  "execution_hint": {
                    "type": "string",
                    "maxLength": 65536
                  }
                },
                "required": [
                  "id",
                  "title",
                  "instructions",
                  "acceptance_criteria",
                  "depends_on",
                  "knowledge_ids"
                ],
                "additionalProperties": false
              },
              "minItems": 1,
              "maxItems": 200
            },
            "knowledge": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 255
                  },
                  "inline": {
                    "type": "string",
                    "maxLength": 65536
                  },
                  "reference": {
                    "type": "object",
                    "properties": {
                      "uri": {
                        "type": "string",
                        "maxLength": 2048
                      },
                      "read_hint": {
                        "type": "string",
                        "maxLength": 65536
                      }
                    },
                    "required": [
                      "uri"
                    ],
                    "additionalProperties": false
                  }
                },
                "required": [
                  "id",
                  "title"
                ],
                "additionalProperties": false
              },
              "maxItems": 100
            }
          },
          "required": [
            "schema_version",
            "title",
            "summary",
            "goal",
            "inputs",
            "tasks",
            "knowledge"
          ],
          "additionalProperties": false
        },
        "reason": {
          "type": "string",
          "maxLength": 65536
        },
        "source_run_id": {
          "type": "string",
          "format": "uuid"
        }
      },
      "required": [
        "client_request_id",
        "workflow_id",
        "expected_workflow_version",
        "document",
        "reason"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "agent_workflow_archive",
    "description": "Archive or restore a workflow without deleting runs or history. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "client_request_id": {
          "type": "string",
          "format": "uuid"
        },
        "workflow_id": {
          "type": "string",
          "minLength": 1
        },
        "expected_workflow_version": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "expected_control_version": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "action": {
          "type": "string",
          "enum": [
            "archive",
            "restore"
          ]
        },
        "reason": {
          "type": "string",
          "maxLength": 65536
        }
      },
      "required": [
        "client_request_id",
        "workflow_id",
        "expected_workflow_version",
        "expected_control_version",
        "action",
        "reason"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "agent_workflow_run_create",
    "description": "Start a concrete run pinned to a workflow version. Creates your membership and coordination; no external task executes automatically. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "client_request_id": {
          "type": "string",
          "format": "uuid"
        },
        "workflow_id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "const": "latest",
              "type": "string"
            }
          ],
          "default": "latest"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255
        },
        "inputs": {
          "type": "object",
          "additionalProperties": {},
          "default": {}
        }
      },
      "required": [
        "client_request_id",
        "workflow_id",
        "title"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "agent_workflow_run_control",
    "description": "Control this run or renew/transfer its coordinator lease. Pause/cancel does not terminate external processes. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "configure",
              "type": "string"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "inputs": {
              "type": "object",
              "additionalProperties": {}
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "start",
              "type": "string"
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "coordinator_acquire",
              "type": "string"
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "coordinator_renew",
              "type": "string"
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "pause",
              "type": "string"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "resume",
              "type": "string"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "block",
              "type": "string"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "request_cancel",
              "type": "string"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "coordinator_transfer",
              "type": "string"
            },
            "target_address_id": {
              "type": "string",
              "format": "uuid"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action",
            "target_address_id",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "coordinator_recover",
              "type": "string"
            },
            "target_address_id": {
              "type": "string",
              "format": "uuid"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action",
            "target_address_id",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  {
    "name": "agent_workflow_run_current",
    "description": "After resume call agent_self then this tool. Lists your open run memberships, invitations, claims and pending evaluations. A global current run is never inferred for writes.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {},
      "required": []
    }
  },
  {
    "name": "agent_workflow_invite",
    "description": "Invite an existing agent to this run for a bounded reason and optional suggested tasks. Any active participant may invite; no operator dialog or new process is required. Resolve ambiguous names with agent_translate. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "client_request_id": {
          "type": "string",
          "format": "uuid"
        },
        "run_id": {
          "type": "string",
          "format": "uuid"
        },
        "target_address_id": {
          "type": "string",
          "format": "uuid"
        },
        "reason": {
          "type": "string",
          "maxLength": 65536
        },
        "task_ids": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
          },
          "maxItems": 200,
          "default": []
        }
      },
      "required": [
        "client_request_id",
        "run_id",
        "target_address_id",
        "reason"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "agent_workflow_membership",
    "description": "Accept/decline your invitation, leave a run, remove a participant as coordinator, or revoke an invitation. Acceptance joins the managed chat; task ownership requires a separate claim. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "action": {
              "const": "accept",
              "type": "string"
            },
            "invitation_id": {
              "type": "string",
              "format": "uuid"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "action",
            "invitation_id",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "action": {
              "const": "decline",
              "type": "string"
            },
            "invitation_id": {
              "type": "string",
              "format": "uuid"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "action",
            "invitation_id",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "action": {
              "const": "revoke_invitation",
              "type": "string"
            },
            "invitation_id": {
              "type": "string",
              "format": "uuid"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "action",
            "invitation_id",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "action": {
              "const": "leave",
              "type": "string"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "action",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "expected_run_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "coordinator_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "remove",
              "type": "string"
            },
            "target_address_id": {
              "type": "string",
              "format": "uuid"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "expected_run_version",
            "action",
            "target_address_id",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  {
    "name": "agent_workflow_task_claim",
    "description": "Acquire/renew/release a task claim or reconcile uncertainty. Claims last 30 minutes: renew within ten and before further external changes. Reconcile investigates the prior process; it never blindly retries. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "task_id": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "expected_task_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "acquire",
              "type": "string"
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "task_id",
            "expected_task_version",
            "action"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "task_id": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "expected_task_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "claim_token": {
              "type": "string",
              "minLength": 20,
              "maxLength": 256
            },
            "claim_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "renew",
              "type": "string"
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "task_id",
            "expected_task_version",
            "claim_token",
            "claim_generation",
            "action"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "task_id": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "expected_task_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "claim_token": {
              "type": "string",
              "minLength": 20,
              "maxLength": 256
            },
            "claim_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "release",
              "type": "string"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "task_id",
            "expected_task_version",
            "claim_token",
            "claim_generation",
            "action",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "task_id": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "expected_task_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "reconcile",
              "type": "string"
            },
            "stage": {
              "type": "string",
              "enum": [
                "begin",
                "resolve"
              ]
            },
            "claim_token": {
              "type": "string",
              "minLength": 20,
              "maxLength": 256
            },
            "claim_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "resolution": {
              "type": "string",
              "enum": [
                "verified_success",
                "safe_to_retry",
                "still_uncertain"
              ]
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            },
            "old_execution_stopped": {
              "type": "boolean"
            },
            "evidence": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "description": {
                    "type": "string",
                    "maxLength": 65536
                  },
                  "type": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  },
                  "time": {
                    "type": "string",
                    "format": "date-time"
                  },
                  "uri": {
                    "type": "string",
                    "maxLength": 2048
                  },
                  "hash": {
                    "type": "string",
                    "maxLength": 128
                  },
                  "execution_host": {
                    "type": "string",
                    "maxLength": 255
                  },
                  "expires_at": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "id",
                  "description",
                  "type",
                  "time"
                ],
                "additionalProperties": false
              },
              "maxItems": 200
            },
            "outputs": {
              "type": "object",
              "additionalProperties": {}
            },
            "execution_host": {
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "task_id",
            "expected_task_version",
            "action",
            "stage",
            "reason"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  {
    "name": "agent_workflow_task_update",
    "description": "Store task progress/result, structured outputs and evidence under your current claim. Retry is explicit and justified. A chat message never changes task state. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "task_id": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "expected_task_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "retry",
              "type": "string"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "task_id",
            "expected_task_version",
            "action",
            "reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "task_id": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "expected_task_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "skip",
              "type": "string"
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            },
            "skip_reason": {
              "const": "not_applicable",
              "type": "string"
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "task_id",
            "expected_task_version",
            "action",
            "reason",
            "skip_reason"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "client_request_id": {
              "type": "string",
              "format": "uuid"
            },
            "run_id": {
              "type": "string",
              "format": "uuid"
            },
            "task_id": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            },
            "expected_task_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "claim_token": {
              "type": "string",
              "minLength": 20,
              "maxLength": 256
            },
            "claim_generation": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "action": {
              "const": "result",
              "type": "string"
            },
            "status": {
              "type": "string",
              "enum": [
                "succeeded",
                "failed",
                "blocked",
                "uncertain"
              ]
            },
            "summary": {
              "type": "string",
              "maxLength": 65536
            },
            "outputs": {
              "type": "object",
              "additionalProperties": {},
              "default": {}
            },
            "evidence": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                  },
                  "description": {
                    "type": "string",
                    "maxLength": 65536
                  },
                  "type": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  },
                  "time": {
                    "type": "string",
                    "format": "date-time"
                  },
                  "uri": {
                    "type": "string",
                    "maxLength": 2048
                  },
                  "hash": {
                    "type": "string",
                    "maxLength": 128
                  },
                  "execution_host": {
                    "type": "string",
                    "maxLength": 255
                  },
                  "expires_at": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "id",
                  "description",
                  "type",
                  "time"
                ],
                "additionalProperties": false
              },
              "maxItems": 200,
              "default": []
            },
            "error": {
              "type": "string",
              "maxLength": 65536
            },
            "execution_host": {
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            }
          },
          "required": [
            "client_request_id",
            "run_id",
            "task_id",
            "expected_task_version",
            "claim_token",
            "claim_generation",
            "action",
            "status",
            "summary",
            "execution_host"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  {
    "name": "agent_workflow_run_note",
    "description": "Append a note, knowledge-use record or improvement suggestion. Record unavailable sources and used source digests; do not include secret values. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "client_request_id": {
          "type": "string",
          "format": "uuid"
        },
        "run_id": {
          "type": "string",
          "format": "uuid"
        },
        "kind": {
          "type": "string",
          "enum": [
            "note",
            "knowledge",
            "improvement"
          ]
        },
        "text": {
          "type": "string",
          "maxLength": 65536
        },
        "task_id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "evidence_ids": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
          },
          "maxItems": 200
        },
        "source": {
          "type": "object",
          "properties": {
            "uri": {
              "type": "string",
              "maxLength": 2048
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "read_at": {
              "type": "string",
              "format": "date-time"
            },
            "digest": {
              "type": "string",
              "maxLength": 128
            },
            "revision": {
              "type": "string",
              "maxLength": 128
            },
            "summary": {
              "type": "string",
              "maxLength": 65536
            },
            "unavailable": {
              "type": "boolean"
            }
          },
          "required": [
            "uri",
            "title",
            "read_at",
            "summary"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "client_request_id",
        "run_id",
        "kind",
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "agent_workflow_run_finish",
    "description": "End external work and enter evaluating, with outcome and all goal-criterion assessments. This does not complete the run; mandatory evaluation follows. Return the report URL in your final answer. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "client_request_id": {
          "type": "string",
          "format": "uuid"
        },
        "run_id": {
          "type": "string",
          "format": "uuid"
        },
        "expected_run_version": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "coordinator_generation": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "outcome": {
          "type": "string",
          "enum": [
            "succeeded",
            "partial",
            "failed",
            "canceled",
            "unknown"
          ]
        },
        "summary": {
          "type": "string",
          "maxLength": 65536
        },
        "criteria": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
              },
              "status": {
                "type": "string",
                "enum": [
                  "met",
                  "not_met",
                  "unverified"
                ]
              },
              "reason": {
                "type": "string",
                "maxLength": 65536
              },
              "evidence_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                }
              }
            },
            "required": [
              "id",
              "status",
              "reason",
              "evidence_ids"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 100
        },
        "results": {
          "type": "object",
          "additionalProperties": {},
          "default": {}
        },
        "open_items": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 65536
          },
          "maxItems": 200,
          "default": []
        },
        "uncertain_task_ids": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
          },
          "maxItems": 200,
          "default": []
        }
      },
      "required": [
        "client_request_id",
        "run_id",
        "expected_run_version",
        "outcome",
        "summary",
        "criteria"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "agent_workflow_run_evaluate",
    "description": "Save or finalize the mandatory evaluation. Assess evidence, task quality, sources and collaboration. Revise the path automatically with a reason; preserve the goal. Finalization atomically publishes improvements, freezes report and closes chat. Keep client_request_id unchanged when retrying the identical operation. Authority and membership are checked server-side.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "client_request_id": {
          "type": "string",
          "format": "uuid"
        },
        "run_id": {
          "type": "string",
          "format": "uuid"
        },
        "expected_run_version": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "coordinator_generation": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "action": {
          "type": "string",
          "enum": [
            "save_draft",
            "finalize"
          ]
        },
        "expected_evaluation_version": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "evaluation": {
          "type": "object",
          "properties": {
            "findings": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "text": {
                    "type": "string",
                    "maxLength": 65536
                  },
                  "task_ids": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                    }
                  },
                  "event_ids": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "format": "uuid"
                    }
                  },
                  "evidence_ids": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                    }
                  }
                },
                "required": [
                  "text"
                ],
                "additionalProperties": false
              },
              "maxItems": 200
            },
            "lessons": {
              "type": "array",
              "items": {
                "type": "string",
                "maxLength": 65536
              },
              "maxItems": 100
            },
            "decision": {
              "type": "string",
              "enum": [
                "no_change",
                "revise"
              ]
            },
            "reason": {
              "type": "string",
              "maxLength": 65536
            },
            "document": {
              "type": "object",
              "properties": {
                "schema_version": {
                  "const": 1,
                  "type": "number"
                },
                "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 255
                },
                "summary": {
                  "type": "string",
                  "maxLength": 65536
                },
                "goal": {
                  "type": "object",
                  "properties": {
                    "statement": {
                      "type": "string",
                      "maxLength": 65536
                    },
                    "success_criteria": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                          },
                          "text": {
                            "type": "string",
                            "maxLength": 65536
                          }
                        },
                        "required": [
                          "id",
                          "text"
                        ],
                        "additionalProperties": false
                      },
                      "minItems": 1,
                      "maxItems": 100
                    }
                  },
                  "required": [
                    "statement",
                    "success_criteria"
                  ],
                  "additionalProperties": false
                },
                "inputs": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                      },
                      "label": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 255
                      },
                      "type": {
                        "type": "string",
                        "enum": [
                          "string",
                          "number",
                          "boolean",
                          "enum"
                        ]
                      },
                      "required": {
                        "type": "boolean"
                      },
                      "default": {},
                      "options": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1
                        },
                        "minItems": 1,
                        "maxItems": 100
                      },
                      "description": {
                        "type": "string",
                        "maxLength": 65536
                      }
                    },
                    "required": [
                      "key",
                      "label",
                      "type",
                      "required"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 64
                },
                "tasks": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                      },
                      "title": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 255
                      },
                      "instructions": {
                        "type": "string",
                        "maxLength": 65536
                      },
                      "acceptance_criteria": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "maxLength": 65536
                        },
                        "minItems": 1,
                        "maxItems": 100
                      },
                      "depends_on": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                        },
                        "maxItems": 200
                      },
                      "knowledge_ids": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                        },
                        "maxItems": 100
                      },
                      "execution_hint": {
                        "type": "string",
                        "maxLength": 65536
                      }
                    },
                    "required": [
                      "id",
                      "title",
                      "instructions",
                      "acceptance_criteria",
                      "depends_on",
                      "knowledge_ids"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1,
                  "maxItems": 200
                },
                "knowledge": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
                      },
                      "title": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 255
                      },
                      "inline": {
                        "type": "string",
                        "maxLength": 65536
                      },
                      "reference": {
                        "type": "object",
                        "properties": {
                          "uri": {
                            "type": "string",
                            "maxLength": 2048
                          },
                          "read_hint": {
                            "type": "string",
                            "maxLength": 65536
                          }
                        },
                        "required": [
                          "uri"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "required": [
                      "id",
                      "title"
                    ],
                    "additionalProperties": false
                  },
                  "maxItems": 100
                }
              },
              "required": [
                "schema_version",
                "title",
                "summary",
                "goal",
                "inputs",
                "tasks",
                "knowledge"
              ],
              "additionalProperties": false
            },
            "expected_workflow_version": {
              "type": "integer",
              "exclusiveMinimum": 0
            }
          },
          "required": [
            "findings",
            "lessons",
            "decision",
            "reason"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "client_request_id",
        "run_id",
        "expected_run_version",
        "action",
        "expected_evaluation_version",
        "evaluation"
      ],
      "additionalProperties": false
    }
  }
]`
