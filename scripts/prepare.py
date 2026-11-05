#!/usr/bin/env python3
# language: Python 3.12, file: scripts/prepare.py
import json, os, re, sys, shutil, zipfile, subprocess, base64, shlex, time
from pathlib import Path

def log(m): print(m, flush=True)

def common_root(names):
    tops = {n.split('/')[0] for n in names if n and not n.startswith('__MACOSX')}
    if len(tops) == 1:
        t = tops.pop()
        if all(n.startswith(t + '/') or n == t for n in names if n):
            return t
    return None

def detect(root: Path) -> str:
    if (root / 'pubspec.yaml').exists(): return 'Flutter'
    pkg = root / 'package.json'
    if pkg.exists():
        try: data = json.loads(pkg.read_text(encoding='utf-8', errors='replace'))
        except Exception: data = {}
        deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
        if 'react-native' in deps: return 'React Native'
        if '@capacitor/core' in deps: return 'Capacitor / Ionic'
        if 'cordova' in deps: return 'Cordova'
    if (root / 'capacitor.config.ts').exists() or (root / 'capacitor.config.json').exists():
        return 'Capacitor / Ionic'
    if (root / 'config.xml').exists(): return 'Cordova'
    return 'Android native (Gradle)'

def android_root(root: Path, fw: str) -> Path:
    if fw in ('Flutter', 'React Native', 'Capacitor / Ionic'): return root / 'android'
    if fw == 'Cordova': return root / 'platforms' / 'android'
    return root

def find_module(aroot: Path):
    if not aroot.exists(): return None
    for p in sorted(aroot.glob('*/build.gradle*')):
        if p.name.endswith('.kts') and p.with_suffix('').with_suffix('.gradle').exists(): continue
        try: txt = p.read_text(encoding='utf-8', errors='replace')
        except Exception: continue
        if 'com.android.application' in txt: return p.parent
    for name in ('build.gradle.kts', 'build.gradle'):
        f = aroot / name
        if f.exists():
            try: txt = f.read_text(encoding='utf-8', errors='replace')
            except Exception: continue
            if 'com.android.application' in txt: return aroot
    return None

def assign_str(text, key, value):
    pat = re.compile(rf'(\b{key}\s*(?:=\s*)?)(["\'])([^"\']*)\2')
    if pat.search(text):
        return pat.sub(lambda m: f'{m.group(1)}{m.group(2)}{value}{m.group(2)}', text, count=1)
    return text

def assign_num(text, keys, value):
    for key in keys:
        pat = re.compile(rf'(\b{key}\s*(?:=\s*)?)(\d+)')
        if pat.search(text):
            return pat.sub(lambda m: f'{m.group(1)}{value}', text, count=1)
    return text

def block_span(text, header):
    m = re.search(header, text)
    if not m: return None
    start = text.find('{', m.start())
    if start < 0: return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == '{': depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0: return (start, i)
    return None

def inject_in_block(text, header, line):
    span = block_span(text, header)
    if not span: return text
    s, e = span
    if line.strip() in text[s:e]: return text
    return text[:e] + f'\n        {line}\n' + text[e:]

def compute_autoversion(proj: Path) -> int:
    try:
        out = subprocess.check_output(['git', 'rev-list', '--count', 'HEAD'],
                                      cwd=proj, stderr=subprocess.DEVNULL).decode().strip()
        n = int(out)
        if n > 0: return n
    except Exception: pass
    return int(time.time())

def patch_gradle(mod: Path, meta, aroot: Path, proj: Path):
    f = mod / 'build.gradle.kts'
    kts = True
    if not f.exists():
        f = mod / 'build.gradle'
        kts = False
    if not f.exists(): raise SystemExit(f'build.gradle tidak ditemukan di {mod}')
    text = f.read_text(encoding='utf-8', errors='replace')
    opts = meta.get('options') or {}

    vcode = int(meta.get('vcode') or 1)
    if opts.get('autoVersion'): vcode = compute_autoversion(proj)

    text = assign_str(text, 'applicationId', meta['pkg'])
    text = assign_str(text, 'namespace', meta['pkg'])
    text = assign_str(text, 'versionName', str(meta.get('ver') or '1.0.0'))
    text = assign_num(text, ['versionCode'], vcode)
    text = assign_num(text, ['minSdk', 'minSdkVersion'], int(opts.get('minSdk') or 24))
    text = assign_num(text, ['targetSdk', 'targetSdkVersion'], int(opts.get('targetSdk') or 34))

    abis = opts.get('abis') or []
    if abis:
        quoted = ', '.join(f'"{a}"' for a in abis)
        line = f'ndk {{ abiFilters += listOf({quoted}) }}' if kts else f'ndk {{ abiFilters {quoted} }}'
        text = inject_in_block(text, r'defaultConfig\s*\{', line)

    if opts.get('split') and abis:
        quoted = ', '.join(f'"{a}"' for a in abis)
        if kts:
            sb = ('splits {\n            abi {\n'
                  '                isEnable = true\n                reset()\n'
                  f'                include({quoted})\n'
                  '                isUniversalApk = false\n            }\n        }')
        else:
            sb = ('splits {\n            abi {\n'
                  '                enable true\n                reset()\n'
                  f'                include {quoted}\n'
                  '                universalApk false\n            }\n        }')
        span = block_span(text, r'android\s*\{')
        if span:
            s, e = span
            if 'splits' not in text[s:e]:
                text = text[:e] + '\n        ' + sb + '\n' + text[e:]

    minify = bool(opts.get('r8'))
    if kts:
        if re.search(r'isMinifyEnabled\s*=', text):
            text = re.sub(r'isMinifyEnabled\s*=\s*\w+', f'isMinifyEnabled = {str(minify).lower()}', text)
        else:
            text = inject_in_block(text, r'release\s*\{', f'isMinifyEnabled = {str(minify).lower()}')
    else:
        if re.search(r'minifyEnabled\s+\w+', text):
            text = re.sub(r'minifyEnabled\s+\w+', f'minifyEnabled {str(minify).lower()}', text)
        else:
            text = inject_in_block(text, r'release\s*\{', f'minifyEnabled {str(minify).lower()}')

    if opts.get('debuggable'):
        line = 'isDebuggable = true' if kts else 'debuggable true'
        text = inject_in_block(text, r'release\s*\{', line)

    if meta.get('keystore') and meta.get('type') == 'release':
        sign = aroot / 'sign.gradle'
        sign.write_text('''android {
    signingConfigs {
        release {
            storeFile file(System.getenv("KS_FILE"))
            storePassword System.getenv("KS_STORE_PASS")
            keyAlias System.getenv("KS_ALIAS")
            keyPassword System.getenv("KS_KEY_PASS")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
''', encoding='utf-8')
        if "sign.gradle" not in text:
            text += "\napply from: rootProject.file('sign.gradle')\n"

    f.write_text(text, encoding='utf-8')

def set_attr(tag: str, key: str, value: str) -> str:
    if re.search(rf'{re.escape(key)}\s*=', tag):
        return re.sub(rf'{re.escape(key)}\s*=\s*"[^"]*"', f'{key}="{value}"', tag)
    return tag[:-1].rstrip() + f' {key}="{value}">'

def patch_manifest(mod: Path, meta):
    mf = mod / 'src' / 'main' / 'AndroidManifest.xml'
    if not mf.exists(): return
    text = mf.read_text(encoding='utf-8', errors='replace')
    have = set(re.findall(r'<uses-permission[^>]*android:name="([^"]+)"', text))
    add = [p for p in (meta.get('permissions') or []) if p not in have]
    if add:
        block = ''.join(f'    <uses-permission android:name="{p}" />\n' for p in add)
        text = re.sub(r'(<application\b)', block + r'\1', text, count=1)

    feats = meta.get('features') or {}
    attrs = {}
    if feats.get('cleartext'): attrs['android:usesCleartextTraffic'] = 'true'
    if feats.get('hwAccel') is False: attrs['android:hardwareAccelerated'] = 'false'
    if feats.get('backup') is False: attrs['android:allowBackup'] = 'false'
    if (meta.get('options') or {}).get('debuggable'): attrs['android:debuggable'] = 'true'

    m = re.search(r'<application\b[^>]*>', text)
    if m:
        tag = m.group(0)
        for k, v in attrs.items(): tag = set_attr(tag, k, v)
        text = text[:m.start()] + tag + text[m.end():]

    ori = feats.get('orientation')
    if ori in ('portrait', 'landscape'):
        text = re.sub(r'(<activity\b[^>]*?)(>)',
                      lambda mm: set_attr(mm.group(1), 'android:screenOrientation', ori) + '>', text, count=1)
    if feats.get('keepScreenOn'):
        text = re.sub(r'(<activity\b[^>]*?)(>)',
                      lambda mm: set_attr(mm.group(1), 'android:keepScreenOn', 'true') + '>', text, count=1)
    if feats.get('fullscreen'):
        text = re.sub(r'(<activity\b[^>]*?)(>)',
                      lambda mm: set_attr(mm.group(1), 'android:theme', '@android:style/Theme.NoTitleBar.Fullscreen') + '>', text, count=1)

    mf.write_text(text, encoding='utf-8')

def apply_icon(mod: Path, job, base: Path):
    icon = (job.get('icon') or {}).get('path')
    if not icon: return
    src = (base / icon).resolve()
    if not src.exists(): return
    res = mod / 'src' / 'main' / 'res'
    for d in ('mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'):
        t = res / d; t.mkdir(parents=True, exist_ok=True)
        for name in ('ic_launcher.png', 'ic_launcher_round.png'):
            shutil.copyfile(src, t / name)

def sanitize_outname(name: str) -> str:
    base = os.path.basename(name or '').strip()
    base = re.sub(r'[^\w.\-]+', '_', base)
    return base[:64]

def write_env(work: Path, job, base: Path):
    lines = []
    ks = job.get('keystore')
    if ks and ks.get('path'):
        kp = (base / ks['path']).resolve()
        if kp.exists():
            dst = work / 'keystore.jks'
            shutil.copyfile(kp, dst)
            lines += [
                f'export KS_FILE={shlex.quote(str(dst))}',
                f'export KS_ALIAS={shlex.quote(ks.get("alias") or "")}',
                f'export KS_STORE_PASS={shlex.quote(ks.get("storePassword") or "")}',
                f'export KS_KEY_PASS={shlex.quote(ks.get("keyPassword") or "")}',
            ]
    raw = (job.get('meta', {}).get('env') or '').strip()
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, v = line.split('=', 1); k = k.strip()
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k): continue
        lines.append(f'export {k}={shlex.quote(v.strip().strip(chr(34)).strip(chr(39)))}')
    outn = sanitize_outname((job.get('meta', {}).get('options') or {}).get('outputName') or '')
    if outn: lines.append(f'export OUT_NAME={shlex.quote(outn)}')
    (work / 'env.sh').write_text('\n'.join(lines) + '\n', encoding='utf-8')

def main():
    meta_path = Path(sys.argv[1]).resolve()
    work = Path(sys.argv[2]).resolve()
    base = meta_path.parent
    job = json.loads(meta_path.read_text(encoding='utf-8'))
    if work.exists(): shutil.rmtree(work)
    work.mkdir(parents=True)

    proj = work / 'project'
    src = job['source']
    if src.get('type') == 'git':
        url = src['url']; branch = src.get('branch') or 'main'
        cmd = ['git', 'clone', '--depth', '1', '--branch', branch, url, str(proj)]
        if src.get('token'):
            auth = base64.b64encode(f'x-access-token:{src["token"]}'.encode()).decode()
            cmd = ['git', '-c', f'http.extraHeader=Authorization: Basic {auth}'] + cmd[1:]
        log(f'git clone {url} ({branch})')
        subprocess.run(cmd, check=True)
    else:
        lp = (base / src['path']).resolve()
        if not lp.exists(): raise SystemExit(f'source.zip tidak ada: {lp}')
        with zipfile.ZipFile(lp) as zf:
            root = common_root(zf.namelist())
            zf.extractall(proj)
        if root:
            inner = proj / root
            if inner.is_dir():
                for p in inner.iterdir(): shutil.move(str(p), str(proj / p.name))
                inner.rmdir()

    sub = (job.get('meta', {}).get('options') or {}).get('subdir') or ''
    if sub:
        proj = proj / sub
        if not proj.is_dir(): raise SystemExit(f'subfolder proyek tidak ada: {sub}')

    fw = job.get('meta', {}).get('framework') or detect(proj)
    aroot = android_root(proj, fw)
    mod = find_module(aroot)
    if mod is None: raise SystemExit(f'modul Android (com.android.application) tidak ditemukan di {aroot}')

    patch_gradle(mod, job['meta'], aroot, proj)
    patch_manifest(mod, job['meta'])
    apply_icon(mod, job, base)

    gs = (job.get('gservices') or {}).get('path')
    if gs:
        gp = (base / gs).resolve()
        if gp.exists(): shutil.copyfile(gp, mod / 'google-services.json')

    write_env(work, job, base)
    log(f'framework={fw} android_root={aroot} module={mod}')

if __name__ == '__main__':
    main()
