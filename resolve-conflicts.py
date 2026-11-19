import re, pathlib

root = pathlib.Path(r'D:\Dev2\relaydeck')

def resolve(path, resolver):
    p = root / path
    text = p.read_text(encoding='utf-8')
    count = 0
    def repl(m):
        nonlocal count
        count += 1
        return resolver(m.group(1), m.group(2), count)
    out = re.sub(r'<<<<<<< Updated upstream\n(.*?)\n=======\n(.*?)\n>>>>>>> Stashed changes', repl, text, flags=re.S)
    assert '<<<<<<<' not in out, f'unresolved markers remain in {path}'
    p.write_text(out, encoding='utf-8')
    print(f'{path}: resolved {count} conflicts')

# --- style.css: take main; re-add only the slice-8/8 rules after the chevron rule ---
def css(upstream, stashed, n):
    base = upstream
    anchor = '.channel-picker>span{position:absolute;right:25px;top:7px;pointer-events:none;color:#8899b3}'
    assert anchor in base
    add = ('.panel-top select#terminal-quality{width:auto;margin-left:8px;font-size:10px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--blue-soft);color:var(--blue);font-weight:600;cursor:pointer}'
           '.tool-row small{display:block;font-size:10px;color:var(--muted);margin-top:4px;line-height:1.5}')
    return base.replace(anchor, anchor + add)

resolve('web/style.css', css)

# --- main.js ---
def mainjs(upstream, stashed, n):
    if n == 1:  # lucide import: main + Download (PenLine belongs to slice 7/8)
        return upstream.replace('Copy, GitBranch', 'Copy, Download, GitBranch')
    if n == 2:  # icons object: main + Download
        return upstream.replace('Copy, GitBranch', 'Copy, Download, GitBranch')
    if n == 3:  # workspace template: main + terminalActionsHtml (no edit-group-slot)
        old = "${a ? `${agentActions(a)}` : '<span class=\"muted\">Ready when you are</span>'}"
        assert old in upstream
        return upstream.replace(old, '${terminalActionsHtml(a)}')
    if n == 4:  # descriptions: main's (no room_update); settings: stashed (adds notifications row)
        settings_start = 'function settings() {'
        upstream_settings = upstream[upstream.index(settings_start):]
        stashed_settings = stashed[stashed.index(settings_start):]
        return upstream[:upstream.index(settings_start)] + stashed_settings
    raise AssertionError(f'unexpected conflict {n}')

resolve('web/main.js', mainjs)

# --- screenshots: take main for now; the smoke run will re-capture on this branch ---
for shot in ('docs/screenshots/workspace-empty.png', 'docs/screenshots/workspace.png'):
    p = root / shot
    blob = p.read_bytes()
    m = re.search(rb'\n<<<<<<< Updated upstream\n(.*?)\n=======\n(.*?)\n>>>>>>> Stashed changes\n', blob, re.S)
    assert m, shot
    p.write_bytes(blob[:m.start()] + b'\n' + m.group(1) + blob[m.end():])
    print(f'{shot}: took upstream')
print('done')
