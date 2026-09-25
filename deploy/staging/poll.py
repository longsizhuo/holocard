#!/usr/bin/env python3
"""
staging 自动更新：每分钟由 systemd timer 跑一次（holocard-staging-poll.timer）。

规则：哪个 PR 有新推送，就把它部署到 staging；同一分钟里有好几个，取提交时间最新的那个。
只有一条泳道，后推送的覆盖先推送的——要测哪个 PR，往它上面推一次（或者手动 deploy.sh <PR 号>）。

只部署可信的 PR：分支在本仓库里（不是别人 fork 来的），且作者对仓库有写权限。
staging 跑的是还没评审的代码，要是随便什么人开个 PR 就能在这台机器上执行代码，
等于把整台服务器交出去了（这里还跑着别的生产服务）。

用拉而不是推：服务器主动去问 GitHub，不用对外开任何口子，也不用往 GitHub 上放服务器的密钥。
状态记在 /var/lib/holocard-staging/seen.json：每个 PR 上次看到的提交。部署失败也算看过，
同一个提交不会每分钟重试一遍，推一个新提交才会再试。
"""

import json
import subprocess
import sys
from pathlib import Path

REPO = 'longsizhuo/holocard'
STATE = Path('/var/lib/holocard-staging')
SEEN = STATE / 'seen.json'
DEPLOY = Path(__file__).with_name('deploy.sh')
TRUSTED = {'admin', 'maintain', 'write'}


def gh(*args: str) -> str:
    return subprocess.run(['gh', *args], capture_output=True, text=True, check=True).stdout


def trusted(login: str, cache: dict[str, bool]) -> bool:
    if login not in cache:
        try:
            permission = json.loads(gh('api', f'repos/{REPO}/collaborators/{login}/permission'))['permission']
        except subprocess.CalledProcessError:
            # 查不到（不是协作者会 404）一律当不可信
            permission = 'none'
        cache[login] = permission in TRUSTED
    return cache[login]


def main() -> int:
    prs = json.loads(gh('pr', 'list', '-R', REPO, '--state', 'open', '--limit', '50',
                        '--json', 'number,headRefOid,isCrossRepository,author'))
    seen: dict[str, str] = json.loads(SEEN.read_text()) if SEEN.exists() else {}
    cache: dict[str, bool] = {}

    changed = []
    for pr in prs:
        number, sha = str(pr['number']), pr['headRefOid']
        if seen.get(number) == sha:
            continue
        seen[number] = sha
        if pr['isCrossRepository'] or not trusted(pr['author']['login'], cache):
            print(f'[staging] 跳过 PR #{number}：不是本仓库分支，或作者没有写权限')
            continue
        date = json.loads(gh('api', f'repos/{REPO}/commits/{sha}'))['commit']['committer']['date']
        changed.append((date, number, sha))

    # 已关掉的 PR 不用再记着
    open_numbers = {str(pr['number']) for pr in prs}
    SEEN.write_text(json.dumps({k: v for k, v in seen.items() if k in open_numbers}))

    if not changed:
        return 0
    _, number, sha = max(changed)
    print(f'[staging] PR #{number} 有新提交 {sha[:7]}，开始部署')
    return subprocess.run([str(DEPLOY), number, sha]).returncode


if __name__ == '__main__':
    sys.exit(main())
