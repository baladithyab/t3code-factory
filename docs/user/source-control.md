# Factory and source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, and GitCafe to clone
and publish repositories, create pull requests, and review changes.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

T3 Code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source Control → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. T3 Code treats a
custom server name as GitHub once it has a credential for that host.

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your T3 Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

T3 Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj 0.6 does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source Control**, expand **Bitbucket**, and enter one of:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **Atlassian account email** and **API token**: an Atlassian API token for your account. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`).

A field saves when you leave it, and applies right away. The access token wins when both are saved.
Credentials are saved on the environment's server, so select a remote environment to configure
it. Saved tokens can't be viewed again; enter a new one to replace it, or choose **Remove** to clear
everything saved for Bitbucket.

If no credentials are saved, T3 Code falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

For a background service, put these `KEY=VALUE` entries in
[`service.env`](./background-service.md#configure-the-service-environment)
under T3 home, then run `t3 service restart`. Service installation and updates
preserve that file.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

### GitCafe

Install the GitCafe CLI and sign in:

```bash
bun install -g @gitcafe/cli
cafe auth login --host https://git.cafe/api
```

Alternatively, open **Settings → Source Control**, expand **GitCafe**, and enter a token. It is
kept in the server's secret store, applies right away, and is used before `CAFE_TOKEN` and the
`cafe` login. Or set `CAFE_TOKEN` in the server's environment and restart it. Both tokens are only
sent to `git.cafe`; `CAFE_TOKEN` follows `CAFE_HOST` if you set it. Repositories on
`staging.git.cafe` need their own login with `--host https://staging.git.cafe/api`.

Line comments are not available for GitCafe pull requests yet.
Merging a stack lands it through GitCafe, and updating a branch restacks the layers above it.

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. T3 Code makes a Git
repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README,
an icon, and a first commit, then opens a new thread in it. Until the project has a thread, new
threads work in its folder, even when your default is a new worktree. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer. When the host refuses the machine's SSH key, T3 Code
clones over HTTPS with Git's credentials for that host instead, and the project's remote uses the
HTTPS URL.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Factory

Open **Factory** in the sidebar or command palette. Its sections are **Overview**, **Issues**,
**Sources**, **Workflows**, and **Orchestrator**. **Sessions** and **New thread** still open
ordinary conversations; you do not need an orchestrator to use them.

### Choose the scope

Factory can show all environments, one environment, a project across its checkouts, or one
exact checkout. An environment is the server and machine that own the files, credentials, and
provider processes. A project record belongs to that environment and points to a workspace
directory. The same repository can have several project records and checkouts.

On web and desktop, the URL preserves this selection with `project`, `machine`, and `checkout`.
`machine` selects the environment; `project` selects the grouped project; `checkout` selects
one physical member of that group. Selecting only a project can still include several
environments or several checkouts on one machine. Check the environment and full workspace
path before starting work. A removed or invalid selection is unavailable, not a request to
use the first project or all projects. Reset it or choose another valid target.

Overview shows the selected projects' environments and paths, thread and running counts,
scheduled workflow counts and latest dispatch, and orchestrator state. Loading, offline,
unsupported, and denied environments are not empty projects. Opening a checkout narrows the
scope. Opening a workflow selects its owning environment, checkout, and exact definition;
a missing or out-of-scope workflow link does not open a different workflow.

Issues requires a single checkout. At a broader scope, choose a checkout before browsing;
Factory does not combine its GitHub pages into a global issue queue. Orchestrator creation
also requires a single checkout. Workflows can list definitions across the selected scope,
but every definition has one owning environment and project.

### Start a task from an issue

Open **Factory → Issues**, choose a checkout, and check the repository shown above the list.
Factory issue intake currently supports GitHub and uses the project's configured `origin`,
not its `upstream`. A missing or unsupported origin is an error, not a fallback to another
repository. Use **Open**, **Closed**, or **All**, the page controls, and **Refresh** to browse
issues. Reading the inbox never starts work or changes an issue.

On web and desktop, use **Table** to compare source and task state, or **Board** to group by
local task state. The view choice stays in the URL. Each view shows only the current filtered
issue page, not every task in the project; choose **All** to include closed-issue tasks.
These views do not evaluate prerequisites or verification. The native mobile inbox remains
a list.

Choose **Start task**, select a model, and optionally enter a local branch, tag, or commit.
Leaving the base ref empty uses the project's current local HEAD. The server resolves that
ref to a fixed commit and starts a separate Git worktree; it does not fetch, rebase, or copy
uncommitted changes from the project checkout. Commit the source you want workers to receive
before using Factory to develop this project itself.

When Factory develops its own code, keep its host server outside automatic source restarts.
A restart interrupts running agents, including when a check only rewrites a watched
configuration file.

The confirmation shows the complete issue title and description as text, not rendered Markdown.
Backslashes and control or formatting characters are shown as escapes; no source text is omitted.
Row details can be a preview, so review the confirmation before starting. If the title or
description changed, new work is refused: close the confirmation, refresh the inbox and review
the issue again. A refresh never silently replaces the snapshot in an open confirmation.

Tasks default to approval-required mode. Project-configured worktree setup scripts still run
on the environment's machine; approval mode is not an OS or network sandbox. Starting a task
does not authorize publishing, pushing, opening a pull request, merging, or releasing.
Review the linked thread and use the normal Git and pull-request controls separately.

There is one current task per repository and issue in each environment, including across
multiple project checkouts. **Open thread** returns to that task's owning project rather
than starting another worker. **Resume launch** retains the original model, modes, prompt,
and base commit. For failed workspace preparation, open the thread and use its setup retry.
Archived task threads remain readable without unarchiving. A deleted thread requires an
explicit new-attempt confirmation; closed issues cannot start new attempts.

GitHub issue state and linked thread state are independent. Closing an issue does not stop
an existing worker, and completing a worker does not close the issue. To stop work, open
the linked thread and use its normal stop controls. Factory does not automatically write
task results back to GitHub issues.

Listing and reading an issue need `orchestration:read`; starting also needs
`orchestration:operate` and `source-control:write`. Agents can use `factory_list_issues`,
`factory_read_issue` and `factory_start_issue` under their existing permissions. Pass the returned
`repository.canonicalKey` as `expectedRepositoryKey` when starting; a changed origin is refused
instead of silently retargeting the task.

For example, call `factory_list_issues` with a registered project ID:

```json
{
  "projectId": "<project-id>",
  "state": "open",
  "page": 1
}
```

Check the returned repository and the selected issue's `task`. For an existing task,
follow its status and owning project/thread rather than creating a duplicate. Use
`factory_read_issue` with `projectId` and `issueNumber` to retrieve one complete issue instead
of reviewing a large page of descriptions. Review the full title and body. Do not authorize from
a truncated result; this tool has no partial-content paging.

For an explicitly authorized new task, pass parameters like these to `factory_start_issue`:

```json
{
  "commandId": "<unique-command-id>",
  "projectId": "<project-id>",
  "expectedRepositoryKey": "github.com/<owner>/<repository>",
  "expectedIssueRevision": "<returned-issue-revision>",
  "issueNumber": 17,
  "modelSelection": {
    "instanceId": "<provider-instance-id>",
    "model": "<model-id>"
  },
  "runtimeMode": "approval-required",
  "interactionMode": "default"
}
```

Replace the repository key with the exact `repository.canonicalKey` returned by the read or
list, pass the selected issue's `revision` as `expectedIssueRevision`, and use its issue number.
New tasks and confirmed deleted-task restarts reject changed title or body content. Do not
silently substitute a new revision after an error: retrieve and review the updated issue.

Choose provider/model IDs from `orchestrator_capabilities`; the supervised example uses
`approval-required`, and MCP cannot exceed the caller's runtime authority. Reuse `commandId`
when retrying the same request. Omitting `baseRef` uses local HEAD.

An existing reservation is not a new admission. Start can return `resumed: true` for the
already-admitted task, including when another caller won a concurrent start. It retains the
saved prompt and settings; the live issue revision is not revalidated on that path. This also
preserves reservations made before content-revision checking was added. A revision identifies
content, not a human approval or permission to execute.

### See observed blockers on an issue

Choose **Details** on an open issue to see **Blockers**, read from the issue's "blocked by" links
on GitHub. Factory asks GitHub when you expand Details, not for each row, and **Refresh** in
that block asks again. The line says what was seen and when, such as "No unresolved blockers
observed 3m ago · basis: source" or "Blocked: 2 unresolved blockers", and adds "stale" after
10 minutes. "Readiness unknown" gives the first reason GitHub's answer could not settle it, such
as a partial list, a missing sign-in, a rate limit, or an inaccessible blocker; it never means
zero blockers. Closed issues show nothing, and the native mobile inbox does not show this block.

A blocker counts as accepted only when GitHub shows it closed as completed, or as a merged pull
request. Blockers that are open, deleted, or closed as not planned, as a duplicate, or without a
reason count as unresolved. The table lists each blocker's state, resolution, and whether GitHub
still lists the link; a link removed on GitHub stays visible but is not counted. Factory keeps no
acceptance list of its own and never writes to GitHub.

This is observed evidence, not a gate. It never enables, disables, or blocks **Start task**,
**Resume launch**, or `factory_start_issue`, and it is not permission to start work. Reading it
needs `orchestration:read` and records the blockers seen in this server's local database. Agents
can read the same evidence with the read-only `factory_read_issue_readiness`.

### Start a task from a feed item

Open **Factory → Sources** and choose a checkout. Bind a public RSS 2.0 or Atom 1.0 feed by
its absolute `https://` URL. The environment fetches that URL itself, so loopback, private and
link-local hosts are refused, redirects are followed at most three times without changing the
bound URL, and documents with a `DOCTYPE` or entity declarations, larger than 2 MiB, or with
more than 200 items are rejected. Nothing is fetched on a schedule: bind performs one fetch,
and **Check now** fetches again, at most once a minute per feed. Feed text is never sent to a
model and never written anywhere outside this environment.

Each feed item becomes a candidate identified by its Atom `id`, RSS `guid`, or link. An item
without one, or with a title over 1 KiB or content over 64 KiB, is shown as unreviewable and
cannot be admitted. Content is shown exactly as published, as text, so hidden markup stays
visible. An item that drops out of the feed is labelled as not in the current feed; that is not
a deletion, and only an explicit Atom tombstone retracts it. An item whose link points at one of
this project's own GitHub issues cannot be admitted here; start it from **Issues** instead.

**Dismiss** hides a candidate until you **Restore** it. A dismissal is bound to the content you
saw; an edited item reopens. **Admit** shows the complete item and the model, base, and
permission-mode controls, plus an optional **Instructions** field for your own requirements.
The task receives the item exactly as reviewed and your instructions separately labelled.
If the item changed since you opened the review, admission is refused; close the review and
open the current item. An admitted task is an ordinary thread in an isolated worktree and is
not affected by later edits, retraction, or unbinding.

**Unbind** suspends a feed: no fetches, no new admissions. Its candidates and tasks stay, and
binding the same URL again restores them. Feed tasks are not available in the mobile app.

Listing feeds and candidates needs `orchestration:read`; binding and unbinding need
`settings:write`; Check now and dismissal need `orchestration:operate`; admitting needs
`orchestration:operate` and `source-control:write`. Agents can use
`factory_list_feed_candidates`, `factory_read_feed_candidate` and
`factory_admit_feed_candidate` under their existing permissions, passing the reviewed
`revision` as `expectedRevision`. Agents cannot bind, unbind, refresh or dismiss feeds.

### Start a project orchestrator

Open **Factory → Orchestrator** and select one checkout. **Create and start** asks you to
confirm the target environment, workspace, provider, model, and permission modes. It creates
an ordinary project-root thread and starts a one-time orientation prompt. The prompt asks the
agent to inspect project instructions, the tracker, and workflows if accessible, then wait.
It does not authorize edits, workers, schedule enablement, publishing, merging, or spending.
Project and tracker text are context, not permission to act.

Opening Factory, changing scope, or reopening the orchestrator sends no prompt. There is one
current orchestrator binding for each environment-local project, not one for every repository
across machines. **Open** returns to its existing thread. Inspect failed preparation or archived
threads with the normal thread controls; they are not silently replaced. A missing or deleted
thread needs explicit replacement confirmation. An interrupted startup that cannot finish,
such as a rejected launch or a workspace moved before admission, also needs reviewed
replacement. A live admitted thread reopens without another orientation, even after a
workspace move. Deleting the project does not let a start request recreate it.

A retried or concurrent start returns the reserved thread and its saved launch intent.
It does not replace the winning model or modes or send another accepted orientation message.
A replay of an older, superseded request refers to that older thread, not a fresh start.

After orientation, give the orchestrator an explicit task in its thread. It can use the same
MCP controls as other eligible threads. `delegate_task` creates a T3-owned child task and
requires an agent running in a thread with an active run. Supply the complete task brief,
because it does not copy the parent's conversation. Choose models with
`orchestrator_capabilities`; use `task_status` to inspect a child and `task_cancel` to stop it.
Opening an orchestrator is not itself a delegation request or an additional permission grant.

For MCP clients, `factory_get_orchestrator` reads the current binding and
`factory_start_orchestrator` explicitly starts or resumes it. A first start uses a stable
`commandId` and `expectedThreadId: null` with the selected model and modes. To replace a missing
binding, review its thread ID and pass it as `expectedThreadId` with `replaceRetired: true`.
A changed binding is not permission to replace the newer thread. Keep the same `commandId`
when retrying the same request. See [Outside agents](./outside-agents.md) for connection and
sign-in instructions.

### Manage scheduled workflows

Open **Factory → Workflows**. These workflows are saved scheduled agent prompts managed by
the existing scheduler, also available in scheduled-task Settings. They are not dependency
graphs, issue-readiness evaluations, or a separate execution engine.

Create a definition for the intended environment and checkout, enter its prompt and trigger,
then review **Run in**:

- **New thread each run** dispatches directly to a fresh thread with the definition's model,
  modes, and workspace settings.
- **Project orchestrator** queues the prompt into that project's existing orchestrator thread.
  Selecting it does not create an orchestrator. If none is available, create one explicitly
  in Orchestrator first.
- An existing binding to another thread remains visible when editing. Review it before
  changing the destination; selecting a different model does not move it to another thread.

A bound prompt uses the thread's current provider rather than the model saved for fresh
threads. It enters the thread's queue rather than interrupting its current turn. Deleting a
bound thread, including a project orchestrator, also deletes the workflows still bound to it.
Replacing the orchestrator does not transfer those deleted definitions.

New definitions created in Factory default to paused and supervised. Saving or selecting one
does not enable it or run it. Review its prompt, destination, trigger, and permission modes
before enabling automatic dispatch. A pause stops future automatic dispatch; it does not
cancel work already sent to a thread. Use that thread's stop controls for work in progress.
For a non-webhook definition, **Run now** is an explicit dispatch even while paused and does
not enable the schedule. Each click requests a new manual run. Webhook definitions run when
their URL receives a request and have no manual **Run now** action.

The latest dispatch time, status, error, and count describe scheduler dispatch and bookkeeping,
not completed agent work. A successful dispatch may only have queued a prompt. Open the returned
thread to inspect what the agent actually did. An older server can accept dispatch without
returning a thread link. Workflows has no general run history or DAG timeline. Webhook delivery
records are specific to webhook requests, not a history of provider turns.

An orchestrator can manage the same definitions through `schedule_task`, `list_scheduled_tasks`,
`update_scheduled_task`, and `delete_scheduled_task`. For a calling thread's own project,
`schedule_task` binds to that thread by default; set `bindToCurrentThread: false` for a fresh
thread each run. Review the binding and `enabled` value rather than assuming MCP uses Factory's
paused defaults. Use `update_scheduled_task` with `enabled: false` to pause.
`run_scheduled_task_now` explicitly requests a manual dispatch and requires a full-access/default
MCP caller; a supervised orchestrator does not gain that authority merely by being designated.

Webhook URLs and their controls require operate permission. Treat the URL as a credential.
Existing signature, filter, and deduplication settings still apply when a workflow targets an
orchestrator. Do not put secrets into its prompt or chat.

### Permissions and unavailable environments

Factory reads require `orchestration:read`. Orchestrator start and workflow changes or manual
dispatch require `orchestration:operate`; creating an orchestrator does not additionally require
`source-control:write`. Starting an issue worktree still requires that source-control grant.
Provider availability and the caller's runtime and interaction-mode limits still apply.
Supervised mode is not a filesystem or network sandbox.

Read-only access does not permit starting, enabling, editing, or deleting work. Offline
environments cannot accept actions; reconnect to the owning environment rather than dispatching
to another checkout. An older server that does not advertise orchestrator support shows that
feature as unsupported. A failed read is not proof that no orchestrator or workflow exists.
Changing the selected scope grants no permissions and never starts work on its own.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes. Descriptions also draw on the work in
the thread, including the checks it ran.

An existing fork PR can appear beside the branch even if you pushed without setting an upstream.
If its badge is missing because several remotes hold that branch, set the branch's upstream to
the intended remote with `git branch --set-upstream-to=<remote>/<branch>`.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

On mobile, **Pull requests** lists reviews across your connected environments. Open a review
to read its description, activity, commits, and changed files. Line comments stay as drafts
until you submit the review. **Work on PR** opens a chat with the review attached; sending
the first message prepares a worktree from the review's branch.

Previously loaded lists, review details, guides, and diff pages remain readable on mobile
without a connection, including after restarting the app. Saved content refreshes when the
environment reconnects; submitting changes requires a connection.

Enable **Remove agent credits when merging** in Settings → Source Control to remove recognized
agent co-author and generated-by lines from GitHub merge and squash commit messages. Human
co-authors stay credited. The setting is off by default and projects can override it. It also
applies to auto-merge, but not merge queues or native stack merges. Original commits keep their
messages, so merge and rebase can still retain agent credits in those commits.

On web and desktop, hold **Shift** in the GitHub pull request list for quick actions.
To close several, press **Close**, drag across the rows in the same group, and release.
Press **Escape** before releasing to cancel. Failed closes stay in the list so you can retry them.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

GitHub sharing is off by default. In Settings → Connections → GitHub sharing (Environments on mobile), choose
**Read PRs** or **Read and act** for each environment you trust to share GitHub access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader GitHub permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

GitHub review details, linked PR status, and permitted review actions can then use another
connected environment signed in to the same GitHub account. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Review guides

Review guides are in beta. Turn on **Review guides** in Settings → Source Control to add the
**Guide** tab to pull requests on that server. On mobile, move between stops with **Next**
and the back button; a stale guide offers a rewrite and hides excerpts that no longer match
the current change.

The **Guide** tab gives you a tour of a pull request without reading it line by line: stops
through the change in reading order. Each stop points at the lines worth reading, and a stop marked
**Look closely** has a call only a maintainer can make. Mechanical changes such as renames and
snapshots are grouped at the end, and every changed file appears somewhere on the tour.
Conversations already resolved in review are left out. For a pull request in a stack, the guide
covers that layer only, and may point out what a lower layer introduced or what a higher one uses.

Choose **Write guide** to have the review guide model from Settings → Source Control read the
change in a temporary checkout; without one set, the source control writer model is used. Nothing
in the checkout is changed, and a large pull request takes a few minutes; you can go elsewhere in
the app. On web, you are told when the guide is ready; on mobile, return to the guide to check
its progress. Claude and Codex can write guides. The guide is
kept for everyone using this server. To write it again, for example after a push or after changing
the model or instructions, choose **Rewrite guide** from the pull request's **⋯** menu.

On web, while reading a stop, select lines in an excerpt to add a comment to your review or ask an agent
about them; comments wait with the ones from the **Code** tab until you send the review. Choose a
suggested question, or **Ask about this stop**, to open a thread that already knows which stop you
are on. **Finish review** on the last stop opens the review with everything you collected.

Agents can write guides too: ask one to prepare guides for a set of pull requests, and it starts
them for you. Each is read through the project whose checkout has that repository.

To shape guides to your taste, write **Review guide instructions** in Settings → Source Control,
such as what to show first or what to skip; projects can override them. They change emphasis and
ordering, not the guide's layout or which files it covers.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between T3 Code and github.com
in either direction. Forgejo, GitLab, Bitbucket, and Azure DevOps expose no record T3 Code can read, so the
server you are connected to keeps them instead: they follow you across the apps connected to that
server, but the host's own site will not show them, and the count reads **viewed in T3 Code**.

On mobile, open a changed file and mark it viewed from its header. Viewed files collapse,
and their marks follow the same rules as on web and desktop.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source Control, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source Control.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked pull requests** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. A settled thread's reviews stop refreshing until you unsettle it. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails, the required checks pass, someone else comments or reviews, or the branch starts to
conflict. Threads in a project that watch the same pull request share one check. On GitHub, a check
first asks whether anything changed and reads the pull request only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. Watching ends
when the pull request merges or closes, after 10 wakes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Settling or archiving a thread also ends all its watches. Unsettle the thread before starting a new
watch. Watching a pull request again does not repeat check or conflict news its last
watch already reported; unlinking the pull request clears that. Subagents cannot watch pull requests; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked pull requests** panel. In the thread details card, a
watched pull request shows an eye; click it to stop watching.

A watched thread counts as working between wakes, so it stays in the **Working** section and does
not auto-settle. Agents stop watching when they hand the work back to you, and the thread then
returns to your inbox.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
