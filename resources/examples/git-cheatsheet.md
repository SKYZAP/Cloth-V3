# Git cheat sheet

## Everyday commands

| Task | Command |
|---|---|
| Status, short form | `git status -sb` |
| Stage part of a file | `git add -p` |
| Commit staged changes | `git commit -m "message"` |
| Amend the last commit (not yet pushed) | `git commit --amend` |
| Show staged diff | `git diff --staged` |
| Compact history graph | `git log --oneline --graph --decorate --all` |
| Who changed a line | `git blame -L 40,60 path/to/file` |

## Branches

- Create and switch: `git switch -c feature/login`
- Switch back: `git switch main`
- Delete a merged branch: `git branch -d feature/login` (use `-D` to force)
- Rename the current branch: `git branch -m new-name`
- List branches with their upstream and last commit: `git branch -vv`

## Syncing with a remote

- `git fetch` downloads remote changes without touching your working tree.
- `git pull --rebase` replays your local commits on top of the fetched ones and avoids merge commits.
- First push of a branch: `git push -u origin feature/login`.
- `git push --force-with-lease` is the safe force push: it refuses if someone else pushed in the meantime.

## Undoing things

| Situation | Command |
|---|---|
| Discard changes to a file | `git restore path` |
| Unstage a file | `git restore --staged path` |
| Undo the last commit, keep changes staged | `git reset --soft HEAD~1` |
| Create a commit that reverses an old one | `git revert <sha>` |
| Recover a lost commit | `git reflog`, then `git switch -c rescue <sha>` |

`git reset --hard` discards uncommitted work permanently; prefer `git stash` when unsure.

## Stash

- `git stash push -m "wip: parser"` saves work in progress, including staged changes.
- `git stash list` shows saved stashes; `git stash pop` reapplies and drops the latest.
- `git stash -u` also stashes untracked files.

## Rebase and history editing

- Interactive rebase of the last 5 commits: `git rebase -i HEAD~5`. Actions: `pick`, `reword`, `edit`, `squash`, `fixup`, `drop`.
- Create a fixup for an earlier commit, then fold it in automatically:
  `git commit --fixup <sha>` then `git rebase -i --autosquash <sha>~1`.
- Abort a rebase that went wrong: `git rebase --abort`.
- Never rewrite commits that others have already pulled.

## Finding bugs

`git bisect` binary-searches history:

```sh
git bisect start
git bisect bad            # current commit is broken
git bisect good v1.4.0    # this tag worked
# test, then mark each step good or bad…
git bisect reset
```

`git bisect run npm test` automates it with a script that exits non-zero on failure.

## Worktrees

`git worktree add ../app-hotfix hotfix/1.4.1` checks out another branch in a separate folder, so you can work on two branches at once without stashing. Remove it with `git worktree remove ../app-hotfix`.

## Useful configuration

```sh
git config --global pull.rebase true
git config --global rebase.autoStash true
git config --global init.defaultBranch main
git config --global alias.lg "log --oneline --graph --decorate --all"
```
