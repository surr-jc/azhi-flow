# Event triggers

A workflow can start when a signed webhook arrives, as well as by hand, on a schedule or through the API.
Use it for work that is shaped like an event: review every pull request when it is opened, investigate an
issue when it is labelled.

## In the definition

```yaml
trigger:
  manual: true
  events:
    - source: github                  # or: webhook
      on: [pull_request.opened, pull_request.synchronize]
      when: "event.pull_request.draft == false"
      inputs:
        repo: event.repository.full_name
        pr: event.pull_request.number
      secret: github-webhook-secret   # default: webhook-secret
```

| Field | Meaning |
|---|---|
| `source` | `github`: GitHub's `X-GitHub-Event` and `X-Hub-Signature-256` headers. `webhook`: `X-Azhi-Event` and `X-Azhi-Signature-256` (and `X-Azhi-Delivery`, a unique id; the body's hash is used when it is absent). |
| `on` | Event names. For GitHub, the event and its action: `pull_request.opened`. An entry without an action (`pull_request`) matches every action. Empty: any event. |
| `when` | CEL over `event`, the payload. The run starts only when it is `true`. An error (a missing field) counts as false. It cannot read run state, and no other step can read `event`. |
| `inputs` | Run input name to a path into the payload (`event.a.b`). Each name must be declared in the workflow's `inputs`. |
| `secret` | The workspace secret that signs the deliveries. Set it with `azhi secret set`. |

`azhi validate` checks the filter, the paths and that every mapped input exists. It warns when a required
input is not mapped, because every delivery would then be refused.

Publishing a version creates or updates the triggers (`trg_<workflow>_<n>`); a trigger keeps its on/off
switch across versions. A trigger runs the **latest published** version.

## Set up the sender

1. `azhi secret set webhook-secret --value <long random string>`
2. Publish the workflow, then `azhi trigger list` (or Mission Control, Schedules, Event triggers) shows the
   webhook URL: `<public url>/v1/hooks/<trigger id>`. In local mode set `AZHI_PUBLIC_URL` to an address the
   sender can reach (a tunnel, for example); `azhi up` itself is not public.
3. In GitHub: Settings, Webhooks, Add webhook. Payload URL as above, content type `application/json`, the same
   secret, and the events you listed.

## What happens to a delivery

The signature is checked first, against the raw body. A wrong signature, an unknown trigger and a missing
secret all answer `401` the same way, and nothing is recorded. After that every delivery is recorded in
`trigger_deliveries` with one outcome:

| Outcome | HTTP | Meaning |
|---|---|---|
| `started` | 202 | A run was created, with `trigger: event` and the mapped inputs. |
| `duplicate` | 200 | The delivery id was seen before (GitHub redelivery, a retry). No second run. |
| `ignored` | 200 | A `ping`, an event not in `on`, or the trigger is off. |
| `filtered` | 200 | `when` was false or could not be evaluated. |
| `refused` | 422 | No published version, the run plan has blockers (including a spend limit), or the inputs do not fit the workflow's input schema. The reason is in the response and the log. A refusal is not retried. |

`azhi trigger deliveries <trigger>` and the Event triggers panel show them. `azhi trigger disable <trigger>`
(admin, audited) stops a trigger without unpublishing.

## Safety

- The payload is **untrusted data**. Only scalar values (string, number, boolean) at the fixed paths the
  definition names are copied into the inputs, strings are capped at 500 characters, and the workflow's
  `inputs` schema checks them like any other start. Pull request titles and bodies are not copied unless you
  map them; if you do, treat the input as untrusted in the workflow, as you would a ticket.
- Taint analysis does not yet treat an event-mapped input as untrusted. A mapped value is data an outsider
  may have chosen (a repository name, a number), so keep agents that read it behind the usual approvals for
  writes.
- A run started by a trigger acts as the version's publisher, like a scheduled run. Nothing merges or closes
  because of a trigger; the workflow's own approvals still apply.
- The signing secret is a workspace secret, never in a URL or in the definition.

## Not built yet

- A polling source for installations with no public URL.
- A concurrency key, so a new push to a pull request replaces the run still working on the older one.
- Sources other than GitHub and the generic signed webhook (GitLab, Jira, Slack events).
- Event-mapped inputs as a taint source.
