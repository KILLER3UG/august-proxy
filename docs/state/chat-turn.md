---
id: chat-turn
title: One chat turn
kind: statechart
status: implemented
summary: A send runs as a loop of model requests and tool rounds until it ends for one of eight named reasons.
parent: august-map
sources:
  - backend-py/app/services/workbench/workbench.py
  - backend-py/app/services/workbench/tool_protocol.py
  - frontend/desktop/src/lib/turn-end.ts
sourceRevision: "224e8ab53e7bd8e1e16057e2ba0a680a5c8f902a"
diagramDetails:
  Ended: What ends a turn
---

# One chat turn

You send a message. The backend builds a prompt, asks the model, and either gets
an answer or gets a tool call. A tool call is checked against policy, run, and
fed back as a receipt, and the model is asked again. That cycle repeats until
the model answers without asking for anything, or until a bound stops it.

```mermaid
stateDiagram-v2
  [*] --> Requested
  Requested --> Building: assemble prompt
  Building --> AwaitingModel: request sent
  AwaitingModel --> ToolProposed: model asks for a tool
  AwaitingModel --> Ended: model answers
  ToolProposed --> Gated: policy check
  Gated --> AwaitingApproval: needs a person
  Gated --> Executing: allowed
  Gated --> AwaitingModel: refused, receipt returned
  AwaitingApproval --> Executing: approved
  AwaitingApproval --> Ended: declined
  Executing --> AwaitingModel: receipt fed back
  Ended --> [*]
```

Click **What ends a turn** for the eight reasons, which is the first thing to
read when a turn stops short.

## What ends a turn

Every turn closes with a `turn_end` frame carrying a reason. The reasons are a
closed list, and the transcript shows an amber badge for any stop that is not
`finished`.

| Reason | What it means |
| --- | --- |
| `finished` | The model answered and asked for nothing further. |
| `length` | The provider cut the answer at its token limit. |
| `cap` | The tool-round ceiling was reached. The last round is spent with no tools so the work comes back as a report. |
| `stall-stop` | No progress was detected across the stall window. |
| `budget` | An opt-in turn budget was breached and every relief rung was spent. |
| `error` | The request failed and no escape ladder could repair it. |
| `interrupted` | You stopped it. |
| `awaiting-input` | The turn is waiting on a person, not on a model. |

Two bounds are armed by default and they measure different things. The stall
counter resets whenever the model does genuinely new work, so a model that keeps
touching new files is not stopped by it. The second bound counts requests that
actually left the process, which is what stops a model that varies its arguments
forever while getting nowhere.

## What is not a lifecycle here

The turn is one request loop inside one session. A delegated subagent runs its
own loop with its own counters, and a Bot to Bot hop is a fresh turn in a
different session, so no counter above spans a chain.
