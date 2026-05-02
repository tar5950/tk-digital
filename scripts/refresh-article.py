#!/usr/bin/env python3
"""
TK Digital — Rafraîchissement automatique des vieux articles.

Lance ce script tous les 30-60 jours via GitHub Actions.
Il sélectionne UN article qui a >60 jours, demande à Gemini de :
1. Vérifier si les chiffres/références sont toujours d'actualité
2. Ajouter une section "Mise à jour [date]" en début d'article
3. Régénérer le HTML

Cela donne un signal de "fraîcheur" à Google = boost SEO sur les vieux articles.

Variables d'environnement requises :
- GEMINI_API_KEY
"""

import os
import json
import re
import sys
import datetime
from pathlib import Path
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
BLOG = ROOT / "blog"
ARTICLES = BLOG / "articles"

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

REFRESH_AGE_DAYS = 60  # un article est "vieux" après 60 jours
REFRESH_COOLDOWN_DAYS = 30  # ne pas re-rafraîchir un article rafraîchi il y a moins de 30 jours


def log(msg):
    print(f"[refresh {datetime.datetime.now().isoformat(timespec='seconds')}] {msg}")


def article_age_days(filepath):
    """Calcule l'âge en jours d'un article basé sur son nom de fichier (date YYYY-MM-DD-...)."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})-", filepath.name)
    if not m:
        return 0
    pub_date = datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return (datetime.date.today() - pub_date).days


def last_refresh_date(html):
    """Cherche la date de dernier refresh dans le HTML."""
    m = re.search(r'data-refreshed="(\d{4}-\d{2}-\d{2})"', html)
    if m:
        return datetime.date.fromisoformat(m.group(1))
    return None


def pick_article_to_refresh():
    """Sélectionne le plus vieux article jamais rafraîchi (ou rafraîchi il y a >30j)."""
    today = datetime.date.today()
    candidates = []

    for f in sorted(ARTICLES.glob("*.html")):
        age = article_age_days(f)
        if age < REFRESH_AGE_DAYS:
            continue

        try:
            html = f.read_text(encoding="utf-8")
        except Exception:
            continue

        last_refresh = last_refresh_date(html)
        if last_refresh:
            days_since_refresh = (today - last_refresh).days
            if days_since_refresh < REFRESH_COOLDOWN_DAYS:
                continue
            score = days_since_refresh
        else:
            score = age

        candidates.append((score, f))

    if not candidates:
        return None

    # Le plus prioritaire (score le plus élevé = plus longtemps sans refresh)
    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]


def extract_article_data(html):
    """Extrait le titre, la date, le slug et le contenu existant d'un article."""
    title_m = re.search(r"<title>(.+?)</title>", html)
    title = title_m.group(1).split(" | ")[0] if title_m else ""

    h1_m = re.search(r"<h1[^>]*>(.+?)</h1>", html, re.DOTALL)
    h1 = h1_m.group(1).strip() if h1_m else title

    return {"title": title, "h1": h1}


def call_gemini_refresh(article_html_text, article_title):
    """Demande à Gemini de proposer une mise à jour pertinente."""
    today = datetime.date.today().isoformat()
    prompt = f"""Tu es Tarik, fondateur de TK Digital. Ton article de blog s'appelle :
"{article_title}"

Aujourd'hui on est le {today}. L'article date de plus de 2 mois.

Ta mission : rédige UN paragraphe court (3-5 phrases) qui sera ajouté en début d'article comme "📅 Mise à jour {today}".

Ce paragraphe doit :
- Mentionner ce qui a changé depuis la rédaction (nouveaux tarifs concurrents, nouvelles features, nouvel update Google, etc.)
- Rester FACTUEL et VÉRIFIABLE (sources : Trustpilot, blogs spécialisés, communiqués officiels)
- Tutoyer le lecteur
- Faire ~80-150 mots
- Être utile pour le lecteur (pas un teaser commercial)

Si tu ne sais pas vraiment ce qui a changé sur ce sujet précis, dis simplement :
"J'ai relu cet article ce mois-ci. Le fond reste vrai. Les chiffres également (vérifiés sur les sources d'origine). Si tu vois quelque chose qui te semble obsolète, dis-le moi."

INTERDIT :
- Inventer des chiffres
- Faire des promesses irréalistes
- Diffamer des concurrents

Réponds UNIQUEMENT avec un objet JSON :
{{"refresh_text": "Ton paragraphe court ici"}}"""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.5,
            "maxOutputTokens": 1024,
            "responseMimeType": "application/json",
        },
    }
    url = f"{GEMINI_URL}?key={GEMINI_API_KEY}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                  headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    text = data["candidates"][0]["content"]["parts"][0]["text"]
    parsed = json.loads(text)
    return parsed["refresh_text"]


def inject_refresh_block(html, refresh_text, today_str):
    """Injecte le bloc 'Mise à jour' juste après le H1 dans le HTML."""
    # Marquer le HTML avec data-refreshed
    if 'data-refreshed=' in html:
        html = re.sub(r'data-refreshed="\d{4}-\d{2}-\d{2}"', f'data-refreshed="{today_str}"', html)
    else:
        html = html.replace('<body data-category=', f'<body data-refreshed="{today_str}" data-category=', 1)

    # Bloc à injecter
    refresh_block = f'''
  <div class="refresh-block" style="background:rgba(200,241,53,.06);border:1px solid rgba(200,241,53,.2);border-left:3px solid var(--a);border-radius:0 6px 6px 0;padding:18px 22px;margin:24px 0 32px;">
    <div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--a);margin-bottom:8px;">📅 Mise à jour {today_str}</div>
    <p style="font-size:14px;color:var(--w2);line-height:1.7;margin:0;">{refresh_text}</p>
  </div>'''

    # Si un refresh-block existe déjà, le remplacer; sinon, l'insérer après le H1
    if 'class="refresh-block"' in html:
        html = re.sub(
            r'<div class="refresh-block"[\s\S]*?</div>',
            refresh_block.strip(),
            html,
            count=1
        )
    else:
        # Injecter après l'auteur byline (qui suit le H1)
        if 'class="author-byline"' in html:
            html = re.sub(
                r'(</div>\s*</div>\s*)(<p class="intro">)',
                r'\1' + refresh_block + r'\n  \2',
                html,
                count=1
            )
        else:
            # Fallback: injecter avant <p class="intro">
            html = html.replace('<p class="intro">', refresh_block + '\n  <p class="intro">', 1)

    # Update <meta property="article:modified_time"> et le schema dateModified
    html = re.sub(
        r'"dateModified":\s*"[^"]*"',
        f'"dateModified": "{today_str}"',
        html
    )

    return html


def main():
    log("Starting article refresh")

    if not GEMINI_API_KEY:
        log("❌ GEMINI_API_KEY missing")
        sys.exit(1)

    target = pick_article_to_refresh()
    if not target:
        log("ℹ️ No article eligible for refresh today.")
        return

    log(f"Picked article: {target.name}")

    html = target.read_text(encoding="utf-8")
    info = extract_article_data(html)

    try:
        refresh_text = call_gemini_refresh(html, info["title"])
        log(f"✅ Got refresh text ({len(refresh_text)} chars)")
    except Exception as e:
        log(f"❌ Gemini call failed: {e}")
        sys.exit(1)

    today_str = datetime.date.today().isoformat()
    new_html = inject_refresh_block(html, refresh_text, today_str)
    target.write_text(new_html, encoding="utf-8")

    log(f"✅ Article refreshed: {target.name}")


if __name__ == "__main__":
    main()
