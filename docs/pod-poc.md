# Proof of concept in one pod

For a small trial, the server, web UI, database and Temporal can run in one container. Teams run
workers on their own machines, so agent sessions run there, not in the pod. For lasting team use,
follow [install.md](install.md) instead.

The pod runs `azhi up --no-worker` ([local-mode-plan.md](local-mode-plan.md)). That gives you:
- PGlite, an embedded PostgreSQL;
- Temporal's single-binary dev server;
- all state in `/data`.

It does not give you:
- **More than one database writer.** Everything is serialised, which is fine for a few people.
- **A production Temporal.** The dev server is not one.
- **Separate teams.** All teams share one workspace; separate workspaces per team are not built yet.

## Size

It was sized for a pod with these settings:

| Setting | Value |
|---|---|
| CPU limit | 500m |
| CPU request | 100m |
| Memory limit | 2Gi |
| Memory request | 128Mi |

- Idle use of the full three-container install was measured at about 420 MiB, so memory fits. This pod has not
  been measured.
- CPU is what slows it down. Expect slow pages and step dispatch while several runs are active.
- A memory request of 128Mi lets the node evict this pod first when it runs short of memory. Raise the request if
  you can.
- `NODE_OPTIONS=--max-old-space-size=768` caps the server's memory so Temporal keeps room.

## Build and deploy

```bash
docker build -f deploy/pod/Dockerfile -t REGISTRY/azhi-flow/pod:dev .
docker push REGISTRY/azhi-flow/pod:dev
```

Before applying `deploy/pod/azhi-poc.yaml`, edit three things:
1. **`image`:** the image you pushed.
2. **`AZHI_PUBLIC_URL`:** the address teams open.
3. **`loadBalancerSourceRanges`:** your teams' addresses. Port 7233 (Temporal) has no sign-in, so only teams
   should be able to reach it. Don't expose it to the whole internet.

```bash
kubectl apply -f deploy/pod/azhi-poc.yaml
```

The manifest creates:
- one replica with the `Recreate` strategy, since two pods must never share the volume;
- a 5 GiB volume;
- a startup probe that allows up to five minutes on half a CPU;
- a `LoadBalancer` service for 7400 (web and API) and 7233 (Temporal).

The owner token is written to `/data/server/local-token`, and the start-up log prints a sign-in link:

```bash
kubectl exec deploy/azhi -- cat /data/server/local-token
```

Open `http://<host>:7400/ui#token=<token>`. On the Users page, create a user for each person and give them a
token.

## Team workers

On each team machine (Linux, macOS or Windows; see [install.md](install.md#workers)):

```bash
git clone https://github.com/surr-jc/azhi-flow && cd azhi-flow && npm ci --omit=dev
npx azhi login --url http://<host>:7400 --token <their token>
AZHI_TEMPORAL_ADDRESS=<host>:7233 npx azhi worker start --trust workspace-publishers
```

The worker connects out to both ports. The team machine needs no open ports. `azhi doctor` lists the online
workers.

## Keys in the trial

Provider and GitHub keys are workspace secrets, encrypted on the server: Claude plan token, ChatGPT and Copilot
sign-ins, GitHub token. Workers fetch a key for each step. Keeping keys only on team machines, and one workspace per
team, are planned but not built.

## Settings

| Variable | Pod default | Use |
|---|---|---|
| `AZHI_HOST` | `0.0.0.0` | where the API and Temporal listen; `azhi up` defaults to `127.0.0.1` |
| `AZHI_PORT` | `7400` | web and API |
| `AZHI_TEMPORAL_PORT` | `7233` | Temporal; when listening beyond loopback, a busy port fails the start instead of moving |
| `AZHI_HOME` | `/data` | database, Temporal state, artifacts and the local token |
| `AZHI_PUBLIC_URL` | set in the manifest | links in the UI and the sign-in redirect |
